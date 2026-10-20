/**
 * Camada de persistência do CRM operacional (CRM-01/CRM-03 — D-14..D-16, D-22).
 *
 * ## Regras de ouro deste módulo
 *
 * 1. **Domínio antes do banco.** `corrigirStatus` valida a transição com
 *    `transicaoValida` (RN-083) ANTES de qualquer escrita: regra de funil é
 *    do domínio, não SQL — o banco só recebe transições já consideradas
 *    legítimas, e a comparação final no CHECK é a linha de defesa, não o alvo.
 * 2. **Append-only de verdade.** `status_history` e `lead_notes` recebem
 *    somente INSERT (RN-081, R-043); a correção de status trava a linha
 *    (`FOR UPDATE`) e NUNCA corrige histórico — corrige o estado atual.
 * 3. **Motivo de PERDIDO é enum do domínio** (D-15) e vira `closed_reason`;
 *    nos demais status críticos (RN-080) o motivo é justificativa livre que
 *    vive só em `status_history.reason`.
 * 4. **`event_log` guarda ids e contadores, nunca corpos** (T-03-35, LGPD):
 *    o payload de cada escrita relevante é estrutura, não texto do Admin.
 * 5. **`changed_by` é `'admin'|'ia'|'system'`** — jamais `'bot'`: o campo alimenta
 *    métricas do relatório diário (Pitfall 6) e `'ia'` ≠ `'bot'`.
 */
import { sql } from "drizzle-orm";
import {
	exigeJustificativa,
	isMotivo,
	isPipelineStatus,
	type PipelineStatus,
	rotulo,
	transicaoValida,
} from "../../../domain/pipeline.js";
import type { Db } from "../client.js";

/** Teto de página da busca do CRM — espelha o anti-DoS do `listarLeadsQuery` (T-03-18). */
const PAGE_SIZE_PADRAO = 50;
const PAGE_SIZE_MAX = 200;
const NOTAS_LIMITE_PADRAO = 50;

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Backstop de programação: a borda (Zod) já validou o formato; aqui um id
 * malformado que chegue é bug, não erro de usuário — lançar é o correto.
 */
const exigirUuid = (valor: string, campo: string): string => {
	if (!UUID_RE.test(valor)) {
		throw new Error(`${campo} invalido: "${valor}" nao e um UUID`);
	}
	return valor;
};

/** Clamp numérico seguro (NaN/undefined caem no padrão). */
const clampInteiro = (
	valor: number | undefined | null,
	padrao: number,
	min: number,
	max: number,
): number => {
	if (valor == null || !Number.isFinite(valor)) return padrao;
	return Math.min(Math.max(Math.trunc(valor), min), max);
};

/** Extrai o `code` do driver pg de um erro (para o mapear 409/404 na rota). */
export const codigoErroPg = (err: unknown): string | null => {
	if (typeof err !== "object" || err === null || !("code" in err)) return null;
	const code = (err as { code?: unknown }).code;
	return typeof code === "string" ? code : null;
};

// ---------------------------------------------------------------------------
// event_log — auditoria estruturada de toda escrita relevante (T-03-35)
// ---------------------------------------------------------------------------

export interface EventoInput {
	readonly eventType: string;
	readonly entityType: string;
	readonly entityId?: string | null;
	readonly leadId?: string | null;
	readonly conversationId?: string | null;
	/** Apenas ids, enums e contadores — NUNCA corpos de nota/mensagem (T-03-35). */
	readonly payload?: Record<string, unknown>;
	readonly severity?: "debug" | "info" | "warn" | "error" | "critical";
}

/** Grava um evento de auditoria. Chamar dentro da MESMA transação da escrita. */
export const registrarEvento = async (
	db: Db,
	ev: EventoInput,
): Promise<void> => {
	await db.execute(sql`
		insert into event_log (
			event_type, entity_type, entity_id, lead_id, conversation_id, payload, severity
		)
		values (
			${ev.eventType},
			${ev.entityType},
			${ev.entityId ?? null},
			${ev.leadId ?? null},
			${ev.conversationId ?? null},
			${JSON.stringify(ev.payload ?? {})}::jsonb,
			${ev.severity ?? "info"}
		)
	`);
};

// ---------------------------------------------------------------------------
// Correção de status do pipeline (D-14, RN-078..RN-083, R-022/R-024)
// ---------------------------------------------------------------------------

export type CorrecaoErro =
	| "conversa_nao_encontrada"
	| "status_invalido"
	| "opt_out_irreversivel"
	| "transicao_invalida"
	| "motivo_obrigatorio"
	| "motivo_invalido";

export type CorrecaoStatusResultado =
	| {
			readonly ok: true;
			readonly de: PipelineStatus;
			readonly para: PipelineStatus;
			readonly statusHistoryId: string;
	  }
	| {
			readonly ok: false;
			readonly erro: CorrecaoErro;
			readonly mensagem: string;
	  };

export interface CorrecaoStatusInput {
	readonly conversationId: string;
	/** Status de destino; validado contra D-14 — valor fora da lista vira 400. */
	readonly para: string;
	/** Justificativa (obrigatória em críticos, enum de D-15 em PERDIDO). */
	readonly motivo?: string | null;
	/** Quem age. `'admin'` = correção manual; `'ia'`/`'system'` = automação. */
	readonly changedBy: "admin" | "ia" | "system";
	/** `true` = correção manual do Admin (pode sair de terminais); `false` = avanço automático. */
	readonly manual: boolean;
}

/**
 * Corrige o `pipeline_status` de uma conversa com auditoria completa.
 *
 * Ordem das travas (todas ANTES de escrever):
 * 1. conversa existe (linha travada com `FOR UPDATE` — serializa correções simultâneas);
 * 2. opt-out irreversível (R-024: quem deu opt-out não volta ao funil);
 * 3. transição válida no domínio (RN-083 — manual sai de terminal, automação só avança);
 * 4. justificativa exigida em status crítico (RN-080), enum de D-15 em PERDIDO.
 *
 * `closed_reason` (D-16): gravado SÓ quando `para='perdido'` (é o vocabulário de
 * motivos de perda); limpo ao reativar um `perdido`; intocado nos demais status.
 * O histórico (`status_history`) sempre ganha uma linha — inclusive no reativar.
 */
export const corrigirStatus = async (
	db: Db,
	input: CorrecaoStatusInput,
): Promise<CorrecaoStatusResultado> => {
	const conversationId = exigirUuid(input.conversationId, "conversationId");
	if (!isPipelineStatus(input.para)) {
		return {
			ok: false,
			erro: "status_invalido",
			mensagem: `status de destino invalido: "${input.para}" (D-14 lista 9 valores)`,
		};
	}
	const para = input.para;

	return await db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;

		const selecionada = await tx.execute(sql`
			select c.id, c.pipeline_status, l.id as lead_id, l.opt_out
			from conversations c
			join leads l on l.id = c.lead_id
			where c.id = ${conversationId}
			for update of c
		`);
		const linha = (
			selecionada as unknown as {
				rows: {
					id: string;
					pipeline_status: string;
					lead_id: string;
					opt_out: boolean;
				}[];
			}
		).rows[0];
		if (!linha) {
			return {
				ok: false as const,
				erro: "conversa_nao_encontrada" as const,
				mensagem: "conversa inexistente",
			};
		}

		// R-024: opt-out é irreversível por definição — antes de qualquer outra
		// regra, inclusive antes de transicaoValida, para o erro dizer a causa real.
		if (linha.opt_out) {
			return {
				ok: false as const,
				erro: "opt_out_irreversivel" as const,
				mensagem: "lead em opt-out nao volta ao funil (R-024)",
			};
		}

		const de = linha.pipeline_status as PipelineStatus;
		// opt_out já tratado acima — aqui vale só a regra de direção (RN-083).
		if (!transicaoValida(de, para, { manual: input.manual, optOut: false })) {
			return {
				ok: false as const,
				erro: "transicao_invalida" as const,
				mensagem: `${rotulo(de)} -> ${rotulo(para)}: ${
					input.manual
						? "correcao manual nao pode repetir status nem sair de terminal para terminal"
						: "automacao so avanca no funil (RN-083)"
				}`,
			};
		}

		let motivoFinal: string | null = null;
		if (exigeJustificativa(para)) {
			const bruto = input.motivo?.trim() ?? "";
			if (!bruto) {
				return {
					ok: false as const,
					erro: "motivo_obrigatorio" as const,
					mensagem: `${rotulo(para)} exige justificativa (RN-080)`,
				};
			}
			// PERDIDO: motivo precisa ser um dos 9 de D-15 (vira closed_reason).
			if (para === "perdido" && !isMotivo(bruto)) {
				return {
					ok: false as const,
					erro: "motivo_invalido" as const,
					mensagem: `motivo de PERDIDO fora do vocabulario de D-15: "${bruto}"`,
				};
			}
			motivoFinal = bruto;
		}

		if (para === "perdido") {
			// Perda: enum do domínio em closed_reason (D-16) + histórico.
			await tx.execute(sql`
				update conversations
				set pipeline_status = ${para}, closed_reason = ${motivoFinal}
				where id = ${conversationId}
			`);
		} else if (de === "perdido") {
			// Reativação (RN-085): o lead saiu de PERDIDO — motivos de perda
			// deixam de valer, senão follow-up/painel continuariam lendo 'perdido'.
			await tx.execute(sql`
				update conversations
				set pipeline_status = ${para}, closed_reason = null
				where id = ${conversationId}
			`);
		} else {
			await tx.execute(sql`
				update conversations
				set pipeline_status = ${para}
				where id = ${conversationId}
			`);
		}

		const historico = await tx.execute(sql`
			insert into status_history (
				conversation_id, from_state, to_state, changed_by, reason
			)
			values (
				${conversationId}, ${de}, ${para}, ${input.changedBy}, ${motivoFinal}
			)
			returning id
		`);
		const idHistorico = (historico as unknown as { rows: { id: string }[] })
			.rows[0]?.id;
		if (!idHistorico) {
			throw new Error(
				"corrigirStatus: INSERT em status_history nao devolveu id (R-022)",
			);
		}

		await registrarEvento(tx, {
			eventType: "pipeline_status_corrigido",
			entityType: "conversation",
			entityId: conversationId,
			leadId: linha.lead_id,
			conversationId,
			payload: { de, para, manual: input.manual, changedBy: input.changedBy },
		});

		return {
			ok: true as const,
			de,
			para,
			statusHistoryId: idHistorico,
		};
	});
};

// ---------------------------------------------------------------------------
// Busca server-side do painel (CRM-01 — nome/telefone/status/tag, paginado)
// ---------------------------------------------------------------------------

export interface BuscaConversasInput {
	/** Busca por nome (ilike) ou telefone (dígitos) — clampado em 200 na borda. */
	readonly q?: string | null;
	readonly pipelineStatus?: string | null;
	readonly tagId?: string | null;
	readonly page?: number;
	readonly pageSize?: number;
}

export interface TagResumo {
	readonly id: string;
	readonly name: string;
}

export interface ConversaCrm {
	readonly conversationId: string;
	readonly leadId: string;
	readonly name: string | null;
	readonly phoneNumber: string;
	readonly pipelineStatus: PipelineStatus;
	readonly state: string;
	readonly engagementMode: string;
	readonly handoffActive: boolean;
	readonly optOut: boolean;
	readonly responsibleUserId: string | null;
	readonly lastInboundAt: Date | null;
	readonly lastOutboundAt: Date | null;
	readonly createdAt: Date;
	readonly tags: TagResumo[];
}

export interface ResultadoBuscaCrm {
	readonly itens: ConversaCrm[];
	readonly page: number;
	readonly pageSize: number;
	readonly total: number;
}

interface LinhaConversaCrm {
	readonly conversation_id: string;
	readonly lead_id: string;
	readonly name: string | null;
	readonly phone_number: string;
	readonly pipeline_status: string;
	readonly state: string;
	readonly engagement_mode: string;
	readonly handoff_active: boolean;
	readonly opt_out: boolean;
	readonly responsible_user_id: string | null;
	readonly last_inbound_at: Date | null;
	readonly last_outbound_at: Date | null;
	readonly created_at: Date;
	readonly total: number;
	readonly tags: TagResumo[] | null;
}

/**
 * Busca conversas com filtro por texto, status do funil e tag — tudo decidido
 * NO SERVIDOR: o painel nunca baixa a base inteira para filtrar no cliente
 * (anti-DoS T-03-18; paginação com `page >= 1`, `1 <= pageSize <= 200`).
 *
 * `count(*) over()` traz o total junto da página — uma consulta só, e a página
 * vazia devolve `total: 0`.
 *
 * A prioridade de ordenação é "o que o Admin precisa olhar agora": handoff
 * ativo primeiro, depois quem respondeu mais recentemente (mesmo espírito do
 * `GET /api/leads`).
 */
export const buscarConversas = async (
	db: Db,
	input: BuscaConversasInput,
): Promise<ResultadoBuscaCrm> => {
	const q = input.q?.trim() || null;
	const status = input.pipelineStatus?.trim() || null;
	if (status !== null && !isPipelineStatus(status)) {
		throw new Error(`pipeline_status invalido na busca: "${status}" (D-14)`);
	}
	const tagId = input.tagId?.trim()
		? exigirUuid(input.tagId.trim(), "tagId")
		: null;
	const page = clampInteiro(input.page, 1, 1, Number.MAX_SAFE_INTEGER);
	const pageSize = clampInteiro(
		input.pageSize,
		PAGE_SIZE_PADRAO,
		1,
		PAGE_SIZE_MAX,
	);
	const offset = (page - 1) * pageSize;
	// Telefone dígito a dígito: "11 98888" não casa com "+551198888" — os
	// dígitos extraídos do texto de busca são o que realmente casa.
	const qFone = q === null ? "" : q.replace(/[^0-9]/g, "");

	const resultado = await db.execute(sql`
		select
			c.id as conversation_id,
			l.id as lead_id,
			l.name,
			l.phone_number,
			c.pipeline_status,
			c.state,
			c.engagement_mode,
			c.handoff_active,
			l.opt_out,
			c.responsible_user_id,
			c.last_inbound_at,
			c.last_outbound_at,
			c.created_at,
			count(*) over()::int as total,
			coalesce((
				select json_agg(json_build_object('id', t.id, 'name', t.name) order by t.name)
				from lead_tags lt
				join tags t on t.id = lt.tag_id
				where lt.lead_id = l.id
			), '[]'::json) as tags
		from conversations c
		join leads l on l.id = c.lead_id
		where (
			${q}::text is null
			or l.name ilike '%' || ${q} || '%'
			or l.phone_number like '%' || ${q} || '%'
			or (length(${qFone}) >= 4 and l.phone_number like '%' || ${qFone} || '%')
		)
		and (${status}::text is null or c.pipeline_status = ${status})
		and (
			${tagId}::text is null
			or exists (
				select 1 from lead_tags lt
				where lt.lead_id = l.id and lt.tag_id = ${tagId}::uuid
			)
		)
		order by
			c.handoff_active desc nulls last,
			c.last_inbound_at desc nulls last,
			c.created_at desc,
			c.id desc
		limit ${pageSize} offset ${offset}
	`);

	const rows = (resultado as unknown as { rows: LinhaConversaCrm[] }).rows;
	return {
		page,
		pageSize,
		total: rows[0]?.total ?? 0,
		itens: rows.map((row) => ({
			conversationId: row.conversation_id,
			leadId: row.lead_id,
			name: row.name,
			phoneNumber: row.phone_number,
			pipelineStatus: row.pipeline_status as PipelineStatus,
			state: row.state,
			engagementMode: row.engagement_mode,
			handoffActive: row.handoff_active,
			optOut: row.opt_out,
			responsibleUserId: row.responsible_user_id,
			lastInboundAt: row.last_inbound_at,
			lastOutboundAt: row.last_outbound_at,
			createdAt: row.created_at,
			tags: row.tags ?? [],
		})),
	};
};

/** "Listar por status" do plano = busca já restringida a um status de D-14. */
export const listarPorStatus = async (
	db: Db,
	status: string,
	input: Omit<BuscaConversasInput, "pipelineStatus"> = {},
): Promise<ResultadoBuscaCrm> => {
	if (!isPipelineStatus(status)) {
		throw new Error(`status de pipeline invalido: "${status}" (D-14)`);
	}
	return buscarConversas(db, { ...input, pipelineStatus: status });
};

// ---------------------------------------------------------------------------
// Tags (D-22)
// ---------------------------------------------------------------------------

export interface TagCrm {
	readonly id: string;
	readonly name: string;
	readonly leadCount: number;
	readonly createdBy: string | null;
	readonly createdAt: Date;
}

/**
 * Cria uma tag. Idempotente por nome: nome já existe devolve a tag existente
 * com `criada: false` — duplicar a mesma tag em dois cliques não pode virar
 * duas tags de mesmo nome (o `unique` de `tags.name` seria o erro cruo).
 */
export const criarTag = async (
	db: Db,
	input: { readonly nome: string; readonly createdBy?: string | null },
): Promise<{ id: string; name: string; criada: boolean }> => {
	const nome = input.nome.trim();
	if (!nome) {
		throw new Error("nome de tag vazio (D-22 exige nome)");
	}
	const createdBy = input.createdBy ?? null;

	const inserida = await db.execute(sql`
		insert into tags (name, created_by)
		values (${nome}, ${createdBy})
		on conflict (name) do nothing
		returning id, name
	`);
	const nova = (inserida as unknown as { rows: { id: string; name: string }[] })
		.rows[0];
	if (nova) {
		await registrarEvento(db, {
			eventType: "tag_criada",
			entityType: "tag",
			entityId: nova.id,
			payload: { name: nova.name },
		});
		return { id: nova.id, name: nova.name, criada: true };
	}

	const existente = await db.execute(sql`
		select id, name from tags where name = ${nome}
	`);
	const atual = (
		existente as unknown as { rows: { id: string; name: string }[] }
	).rows[0];
	if (!atual) {
		// Corrida extrema (criou e sumiu entre as duas consultas) — bug, não caso de uso.
		throw new Error(`tag "${nome}" conflitou no INSERT mas nao foi encontrada`);
	}
	return { id: atual.id, name: atual.name, criada: false };
};

/** Lista todas as tags com contagem de leads vinculados, por nome. */
export const listarTags = async (db: Db): Promise<TagCrm[]> => {
	const resultado = await db.execute(sql`
		select
			t.id,
			t.name,
			t.created_by,
			t.created_at,
			(
				select count(*)::int from lead_tags lt where lt.tag_id = t.id
			) as lead_count
		from tags t
		order by t.name
	`);
	return (resultado as unknown as { rows: Record<string, unknown>[] }).rows.map(
		(row) => ({
			id: row.id as string,
			name: row.name as string,
			leadCount: row.lead_count as number,
			createdBy: (row.created_by as string | null) ?? null,
			createdAt: row.created_at as Date,
		}),
	);
};

/** Renomeia uma tag; `null` = id inexistente. Nome duplicado propaga 23505 (rota → 409). */
export const renomearTag = async (
	db: Db,
	tagId: string,
	novoNome: string,
): Promise<{ id: string; name: string } | null> => {
	const id = exigirUuid(tagId, "tagId");
	const nome = novoNome.trim();
	if (!nome) {
		throw new Error("nome de tag vazio (D-22 exige nome)");
	}
	const resultado = await db.execute(sql`
		update tags set name = ${nome}
		where id = ${id}
		returning id, name
	`);
	const row = (resultado as unknown as { rows: { id: string; name: string }[] })
		.rows[0];
	if (!row) return null;
	await registrarEvento(db, {
		eventType: "tag_renomeada",
		entityType: "tag",
		entityId: id,
		payload: { name: row.name },
	});
	return row;
};

/**
 * Remove a tag e todos os vínculos (`lead_tags` primeiro — a FK não tem
 * cascata, e a junção é dado derivado da tag, não histórico auditável).
 * `false` = tag inexistente.
 */
export const removerTag = async (db: Db, tagId: string): Promise<boolean> => {
	const id = exigirUuid(tagId, "tagId");
	return await db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;
		await tx.execute(sql`delete from lead_tags where tag_id = ${id}`);
		const removida = await tx.execute(sql`
			delete from tags where id = ${id} returning id
		`);
		const achou = (removida as unknown as { rows: unknown[] }).rows.length > 0;
		if (achou) {
			await registrarEvento(tx, {
				eventType: "tag_removida",
				entityType: "tag",
				entityId: id,
			});
		}
		return achou;
	});
};

/**
 * Vincula tag ao lead. Idempotência pela PK (D-22): `false` = já vinculada.
 * Lead/tag inexistente viola FK (23503) — a rota mapeia para 404.
 */
export const associarTag = async (
	db: Db,
	input: {
		readonly leadId: string;
		readonly tagId: string;
		readonly createdBy?: string | null;
	},
): Promise<boolean> => {
	const leadId = exigirUuid(input.leadId, "leadId");
	const tagId = exigirUuid(input.tagId, "tagId");
	const resultado = await db.execute(sql`
		insert into lead_tags (lead_id, tag_id, created_by)
		values (${leadId}, ${tagId}, ${input.createdBy ?? null})
		on conflict do nothing
		returning lead_id
	`);
	const vinculou =
		(resultado as unknown as { rows: unknown[] }).rows.length > 0;
	if (vinculou) {
		await registrarEvento(db, {
			eventType: "tag_vinculada",
			entityType: "lead",
			entityId: leadId,
			leadId,
			payload: { tagId },
		});
	}
	return vinculou;
};

/** Desvincula tag do lead (a tag em si continua existindo). `false` = não havia vínculo. */
export const desassociarTag = async (
	db: Db,
	leadId: string,
	tagId: string,
): Promise<boolean> => {
	const lead = exigirUuid(leadId, "leadId");
	const tag = exigirUuid(tagId, "tagId");
	const resultado = await db.execute(sql`
		delete from lead_tags
		where lead_id = ${lead} and tag_id = ${tag}
		returning lead_id
	`);
	const desvinculou =
		(resultado as unknown as { rows: unknown[] }).rows.length > 0;
	if (desvinculou) {
		await registrarEvento(db, {
			eventType: "tag_desvinculada",
			entityType: "lead",
			entityId: lead,
			leadId: lead,
			payload: { tagId: tag },
		});
	}
	return desvinculou;
};

// ---------------------------------------------------------------------------
// Notas do lead — Admin e IA (D-22, CRM-03, R-043)
// ---------------------------------------------------------------------------

/** Autoria literal de D-22 — não renomear (o CHECK do banco tem os mesmos valores). */
export type AutorNota = "admin" | "ia";

export interface NotaCrm {
	readonly id: string;
	readonly leadId: string;
	readonly conversationId: string | null;
	readonly body: string;
	readonly authorType: AutorNota;
	readonly createdBy: string | null;
	readonly createdAt: Date;
}

export type NotaResultado =
	| { readonly ok: true; readonly nota: NotaCrm }
	| { readonly ok: false; readonly erro: "lead_nao_encontrado" };

const mapearNota = (row: Record<string, unknown>): NotaCrm => ({
	id: row.id as string,
	leadId: row.lead_id as string,
	conversationId: (row.conversation_id as string | null) ?? null,
	body: row.body as string,
	authorType: row.author_type as AutorNota,
	createdBy: (row.created_by as string | null) ?? null,
	createdAt: row.created_at as Date,
});

/**
 * Cria uma nota (só INSERT — append-only, R-043). A nota da IA nasce com
 * `created_by` nulo: a autoria é `'ia'`, não de um usuário (D-22).
 * O `event_log` guarda o tamanho em caracteres, nunca o corpo (T-03-35).
 */
export const criarNota = async (
	db: Db,
	input: {
		readonly leadId: string;
		readonly conversationId?: string | null;
		readonly body: string;
		readonly authorType: AutorNota;
		readonly createdBy?: string | null;
	},
): Promise<NotaResultado> => {
	const leadId = exigirUuid(input.leadId, "leadId");
	const conversationId =
		input.conversationId != null
			? exigirUuid(input.conversationId, "conversationId")
			: null;
	const body = input.body.trim();
	if (!body) {
		throw new Error("nota vazia: escreva o texto antes de salvar");
	}
	if (input.authorType !== "admin" && input.authorType !== "ia") {
		throw new Error(
			`authorType invalido: "${input.authorType}" (D-22: admin|ia)`,
		);
	}

	return await db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;
		const existe = await tx.execute(sql`
			select id from leads where id = ${leadId}
		`);
		if ((existe as unknown as { rows: unknown[] }).rows.length === 0) {
			return { ok: false as const, erro: "lead_nao_encontrado" as const };
		}

		const inserida = await tx.execute(sql`
			insert into lead_notes (lead_id, conversation_id, body, author_type, created_by)
			values (
				${leadId}, ${conversationId}, ${body},
				${input.authorType}, ${input.createdBy ?? null}
			)
			returning id, lead_id, conversation_id, body, author_type, created_by, created_at
		`);
		const row = (inserida as unknown as { rows: Record<string, unknown>[] })
			.rows[0];
		if (!row) {
			throw new Error(
				"criarNota: INSERT em lead_notes nao devolveu id (R-043)",
			);
		}

		await registrarEvento(tx, {
			eventType: "nota_criada",
			entityType: "lead",
			entityId: leadId,
			leadId,
			conversationId,
			payload: { authorType: input.authorType, chars: body.length },
		});

		return { ok: true as const, nota: mapearNota(row) };
	});
};

/** Notas de um lead, mais recentes primeiro; limite clampado em 1..200. */
export const listarNotas = async (
	db: Db,
	leadId: string,
	limit: number = NOTAS_LIMITE_PADRAO,
): Promise<NotaCrm[]> => {
	const lead = exigirUuid(leadId, "leadId");
	const teto = clampInteiro(limit, NOTAS_LIMITE_PADRAO, 1, 200);
	const resultado = await db.execute(sql`
		select id, lead_id, conversation_id, body, author_type, created_by, created_at
		from lead_notes
		where lead_id = ${lead}
		order by created_at desc, id desc
		limit ${teto}
	`);
	return (resultado as unknown as { rows: Record<string, unknown>[] }).rows.map(
		mapearNota,
	);
};

// ---------------------------------------------------------------------------
// Tarefas e lembretes (D-22)
// ---------------------------------------------------------------------------

/** Status literal do CHECK `tasks_status_check` (vocabulário em inglês, D-22). */
export type StatusTarefa = "pending" | "done" | "cancelled";

const STATUS_TAREFA_VALIDOS: readonly string[] = [
	"pending",
	"done",
	"cancelled",
];

const ehStatusTarefa = (valor: string): valor is StatusTarefa =>
	STATUS_TAREFA_VALIDOS.includes(valor);

export interface TarefaCrm {
	readonly id: string;
	readonly leadId: string;
	readonly title: string;
	readonly status: StatusTarefa;
	readonly dueAt: Date | null;
	readonly responsibleUserId: string | null;
	readonly createdBy: string | null;
	readonly createdAt: Date;
}

export type TarefaResultado =
	| { readonly ok: true; readonly tarefa: TarefaCrm }
	| {
			readonly ok: false;
			readonly erro: "lead_nao_encontrado" | "responsavel_invalido";
	  };

const mapearTarefa = (row: Record<string, unknown>): TarefaCrm => ({
	id: row.id as string,
	leadId: row.lead_id as string,
	title: row.title as string,
	status: row.status as StatusTarefa,
	dueAt: (row.due_at as Date | null) ?? null,
	responsibleUserId: (row.responsible_user_id as string | null) ?? null,
	createdBy: (row.created_by as string | null) ?? null,
	createdAt: row.created_at as Date,
});

const normalizarDueAt = (
	valor: string | Date | null | undefined,
): Date | null => {
	if (valor == null) return null;
	return valor instanceof Date ? valor : new Date(valor);
};

/** Usuário existe e está ativo (`app_users.is_active`) — responsável deve ser assim. */
const usuarioAtivo = async (db: Db, userId: string): Promise<boolean> => {
	const id = exigirUuid(userId, "userId");
	const resultado = await db.execute(sql`
		select id from app_users where id = ${id} and is_active = true
	`);
	return (resultado as unknown as { rows: unknown[] }).rows.length > 0;
};

/** Cria tarefa/lembrete do lead. `responsibleUserId` precisa ser usuário ativo. */
export const criarTarefa = async (
	db: Db,
	input: {
		readonly leadId: string;
		readonly title: string;
		readonly dueAt?: string | Date | null;
		readonly responsibleUserId?: string | null;
		readonly createdBy?: string | null;
	},
): Promise<TarefaResultado> => {
	const leadId = exigirUuid(input.leadId, "leadId");
	const title = input.title.trim();
	if (!title) {
		throw new Error("tarefa sem titulo: escreva o que precisa ser feito");
	}
	const responsible =
		input.responsibleUserId == null ? null : input.responsibleUserId;

	return await db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;
		const existe = await tx.execute(
			sql`select id from leads where id = ${leadId}`,
		);
		if ((existe as unknown as { rows: unknown[] }).rows.length === 0) {
			return { ok: false as const, erro: "lead_nao_encontrado" as const };
		}
		if (responsible !== null && !(await usuarioAtivo(tx, responsible))) {
			return { ok: false as const, erro: "responsavel_invalido" as const };
		}

		const inserida = await tx.execute(sql`
			insert into tasks (lead_id, title, due_at, responsible_user_id, created_by)
			values (${leadId}, ${title}, ${normalizarDueAt(input.dueAt)}, ${responsible}, ${input.createdBy ?? null})
			returning id, lead_id, title, due_at, status, responsible_user_id, created_by, created_at
		`);
		const row = (inserida as unknown as { rows: Record<string, unknown>[] })
			.rows[0];
		if (!row) {
			throw new Error("criarTarefa: INSERT em tasks nao devolveu id");
		}
		await registrarEvento(tx, {
			eventType: "tarefa_criada",
			entityType: "lead",
			entityId: leadId,
			leadId,
			payload: { tarefaId: row.id as string, vence: row.due_at != null },
		});
		return { ok: true as const, tarefa: mapearTarefa(row) };
	});
};

export interface ListarTarefasInput {
	readonly leadId?: string | null;
	readonly status?: string | null;
	readonly page?: number;
	readonly pageSize?: number;
}

/**
 * Tarefas do painel, filtradas por lead/status e paginadas (mesmos clamps da
 * busca). Ordenação "o que vence primeiro": pendentes antes das encerradas,
 * vencendo em ordem cronológica, sem vencimento no fim.
 */
export const listarTarefas = async (
	db: Db,
	input: ListarTarefasInput = {},
): Promise<{
	itens: TarefaCrm[];
	page: number;
	pageSize: number;
	total: number;
}> => {
	const leadId = input.leadId?.trim()
		? exigirUuid(input.leadId.trim(), "leadId")
		: null;
	const status = input.status?.trim() || null;
	if (status !== null && !ehStatusTarefa(status)) {
		throw new Error(
			`status de tarefa invalido: "${status}" (pending|done|cancelled)`,
		);
	}
	const page = clampInteiro(input.page, 1, 1, Number.MAX_SAFE_INTEGER);
	const pageSize = clampInteiro(
		input.pageSize,
		PAGE_SIZE_PADRAO,
		1,
		PAGE_SIZE_MAX,
	);
	const offset = (page - 1) * pageSize;

	const resultado = await db.execute(sql`
		select
			id, lead_id, title, due_at, status, responsible_user_id, created_by, created_at,
			count(*) over()::int as total
		from tasks
		where (${leadId}::text is null or lead_id = ${leadId}::uuid)
		and (${status}::text is null or status = ${status})
		order by
			(status = 'pending') desc,
			due_at asc nulls last,
			created_at desc,
			id desc
		limit ${pageSize} offset ${offset}
	`);
	const rows = (resultado as unknown as { rows: Record<string, unknown>[] })
		.rows;
	return {
		page,
		pageSize,
		total: (rows[0]?.total as number | undefined) ?? 0,
		itens: rows.map(mapearTarefa),
	};
};

export interface PatchTarefa {
	readonly title?: string;
	readonly status?: string;
	readonly dueAt?: string | Date | null;
	readonly responsibleUserId?: string | null;
}

/**
 * Atualiza uma tarefa com leitura travada (`FOR UPDATE`): o patch é aplicado
 * sobre a linha lida, então dois updates simultâneos não se sobrescrevem
 * (sem lost update). `null` = tarefa inexistente.
 */
export const atualizarTarefa = async (
	db: Db,
	tarefaId: string,
	patch: PatchTarefa,
): Promise<TarefaCrm | null | "responsavel_invalido"> => {
	const id = exigirUuid(tarefaId, "tarefaId");
	if (patch.status !== undefined && !ehStatusTarefa(patch.status)) {
		throw new Error(
			`status de tarefa invalido: "${patch.status}" (pending|done|cancelled)`,
		);
	}
	const novoTitulo = patch.title?.trim();
	if (patch.title !== undefined && !novoTitulo) {
		throw new Error("tarefa sem titulo: escreva o que precisa ser feito");
	}

	return await db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;
		const selecionada = await tx.execute(sql`
			select id, lead_id, title, due_at, status, responsible_user_id, created_by, created_at
			from tasks
			where id = ${id}
			for update
		`);
		const atual = (
			selecionada as unknown as { rows: Record<string, unknown>[] }
		).rows[0];
		if (!atual) return null;

		const responsavel =
			patch.responsibleUserId === undefined
				? ((atual.responsible_user_id as string | null) ?? null)
				: patch.responsibleUserId;
		if (responsavel !== null && !(await usuarioAtivo(tx, responsavel))) {
			return "responsavel_invalido" as const;
		}

		const tituloFinal = novoTitulo ?? (atual.title as string);
		const statusFinal =
			(patch.status as StatusTarefa | undefined) ??
			(atual.status as StatusTarefa);
		const dueFinal =
			patch.dueAt === undefined
				? ((atual.due_at as Date | null) ?? null)
				: normalizarDueAt(patch.dueAt);

		const atualizada = await tx.execute(sql`
			update tasks
			set title = ${tituloFinal},
				status = ${statusFinal},
				due_at = ${dueFinal},
				responsible_user_id = ${responsavel}
			where id = ${id}
			returning id, lead_id, title, due_at, status, responsible_user_id, created_by, created_at
		`);
		const row = (atualizada as unknown as { rows: Record<string, unknown>[] })
			.rows[0];
		if (!row) {
			throw new Error("atualizarTarefa: UPDATE nao devolveu linha?");
		}

		await registrarEvento(tx, {
			eventType: "tarefa_atualizada",
			entityType: "task",
			entityId: id,
			leadId: row.lead_id as string,
			payload: {
				statusAnterior: atual.status as string,
				status: row.status as string,
			},
		});
		return mapearTarefa(row);
	});
};

// ---------------------------------------------------------------------------
// Responsável (R-028)
// ---------------------------------------------------------------------------

export type ResponsavelResultado =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly erro: "conversa_nao_encontrada" | "responsavel_invalido";
			readonly mensagem: string;
	  };

/**
 * Define (ou limpa, com `userId: null`) o responsável pela conversa.
 *
 * As DUAS colunas são atualizadas na mesma transação — `conversations` (o que o
 * painel mostra) e `leads` (dono do lead): divergir uma da outra criaria duas
 * verdades sobre o mesmo R-028.
 */
export const definirResponsavel = async (
	db: Db,
	input: {
		readonly conversationId: string;
		readonly userId: string | null;
	},
): Promise<ResponsavelResultado> => {
	const conversationId = exigirUuid(input.conversationId, "conversationId");
	const userId = input.userId;

	if (userId !== null && !(await usuarioAtivo(db, userId))) {
		return {
			ok: false,
			erro: "responsavel_invalido",
			mensagem: "responsavel precisa ser um usuario existente e ativo (R-028)",
		};
	}

	return await db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;
		const selecionada = await tx.execute(sql`
			select c.id, c.lead_id
			from conversations c
			where c.id = ${conversationId}
			for update of c
		`);
		const row = (
			selecionada as unknown as { rows: { id: string; lead_id: string }[] }
		).rows[0];
		if (!row) {
			return {
				ok: false as const,
				erro: "conversa_nao_encontrada" as const,
				mensagem: "conversa inexistente",
			};
		}

		await tx.execute(sql`
			update conversations set responsible_user_id = ${userId}
			where id = ${conversationId}
		`);
		await tx.execute(sql`
			update leads set responsible_user_id = ${userId}
			where id = ${row.lead_id}
		`);
		await registrarEvento(tx, {
			eventType: "responsavel_definido",
			entityType: "conversation",
			entityId: conversationId,
			leadId: row.lead_id,
			conversationId,
			payload: { definido: userId !== null },
		});
		return { ok: true as const };
	});
};
