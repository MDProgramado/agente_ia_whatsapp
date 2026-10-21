/**
 * Rotas de leads do painel (R-046, D-22/D-23, R-064).
 *
 * As LEITURAS são read-only: o painel consulta, nunca muta cadastro por aqui
 * (a mutação de lead vive no CRM/importador). A lista ordena por prioridade
 * operacional — handoff ativo primeiro, depois quem respondeu mais recentemente
 * — que é "o que o Admin precisa olhar agora".
 *
 * A ÚNICA escrita é `POST /api/leads/:id/opt-out`: o opt-out é IRREVERSÍVEL
 * (R-024/AR-005), então ele exige confirmação literal `OPTOUT` na borda
 * (T-03-41) e grava prova dupla — `optout_ledger(source='manual')` e
 * `event_log('optout_manual')` — na MESMA transação (T-03-42). Nada aqui
 * edita ou exclui histórico (D-23) nem envia mensagem: envio é do dispatcher.
 */
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../../infra/db/client.js";
import { applyOptOut } from "../../infra/db/queries/leads.js";
import { confirmarOptOutBody, idParams, listarLeadsQuery } from "../schemas.js";
import type { PanelCore } from "../server.js";

/**
 * Base legal e finalidade de REGISTRO quando o lead não tem (R-064). O schema
 * do banco torna as duas NOT NULL, então isto é o piso defensivo para uma base
 * que veio de uma importação anterior — nunca a fonte da verdade.
 */
const BASE_LEGAL_PADRAO = "legitimo_interesse";
const FINALIDADE_PADRAO = "contato_comercial_b2b";

/** Texto de prova do opt-out manual: o que o ledger guarda como `raw_content`. */
const PROVA_OPT_OUT_MANUAL =
	"Opt-out manual registrado pelo Admin no painel (type-to-confirm OPTOUT)";

interface LinhaLead {
	readonly id: string;
	readonly name: string | null;
	readonly phone_number: string;
	readonly origin_source: string | null;
	readonly opt_out: boolean;
	readonly legal_basis: string | null;
	readonly purpose: string | null;
	readonly legal_registered_at: string | null;
	readonly first_contact_by_human: boolean;
	readonly conversation_id: string | null;
	readonly state: string | null;
	readonly engagement_mode: string | null;
	readonly handoff_active: boolean | null;
	readonly last_inbound_at: string | null;
	readonly last_outbound_at: string | null;
	/**
	 * Instante do opt-out (`max(occurred_at)` do ledger do lead). Só a rota de
	 * detalhe o consulta — a lista não precisa da data, e o subquery correlated
	 * em 50 linhas seria custo por nada.
	 */
	readonly opt_out_at?: Date | string | null;
	/**
	 * Status do FUNIL de vendas (`pipeline_status`, RN-078/D-14). Vem por
	 * subquery — e não pelo `left join conversations` — porque o detalhe do lead
	 * precisa de UM status determinístico mesmo quando o lead tem mais de uma
	 * conversa; o join traria uma linha por conversa e o `rows[0]` seria
	 * arbitrário.
	 */
	readonly pipeline_status?: string | null;
	/**
	 * Etiquetas do lead (D-22): `json_agg` sobre `lead_tags`×`tags`. Também
	 * por subquery — um JOIN multiplicaria a linha do lead por etiqueta.
	 */
	readonly tags?: unknown;
}

/**
 * `timestamptz` chega do driver como `Date`; a API fala ISO-8601 (string).
 * A conversão mora AQUI, na borda, para que o contrato do painel seja
 * explícito em vez de herdado do driver.
 */
const paraIso = (valor: Date | string | null | undefined): string | null => {
	if (valor === null || valor === undefined) return null;
	return valor instanceof Date ? valor.toISOString() : String(valor);
};

/**
 * `json_agg` volta do driver `pg` já como array (o driver parseia `json`/`jsonb`).
 * A normalização existe para o caso de lead SEM etiqueta: `coalesce` devolve
 * `'[]'::json` e o array chega vazio, não nulo.
 */
const paraTags = (valor: unknown): string[] => {
	if (!Array.isArray(valor)) return [];
	return valor.filter((tag): tag is string => typeof tag === "string");
};

const paraItem = (row: LinhaLead) => ({
	id: row.id,
	name: row.name,
	phoneNumber: row.phone_number,
	originSource: row.origin_source,
	optOut: row.opt_out,
	conversationId: row.conversation_id,
	state: row.state,
	engagementMode: row.engagement_mode,
	handoffActive: row.handoff_active ?? false,
	lastInboundAt: row.last_inbound_at,
	lastOutboundAt: row.last_outbound_at,
});

export const registrarLeads = (app: FastifyInstance, core: PanelCore): void => {
	app.get("/api/leads", async (req, reply) => {
		const parsed = listarLeadsQuery.safeParse(req.query);
		if (!parsed.success) {
			return reply.code(400).send({
				erro: "parametros invalidos",
				detalhes: parsed.error.issues.map((i) => i.message),
			});
		}
		const { q, status, page, pageSize } = parsed.data;
		const busca = q ?? null;
		const filtroStatus = status ?? null;
		const offset = (page - 1) * pageSize;

		const resultado = await core.db.execute(sql`
			select
				l.id,
				l.name,
				l.phone_number,
				l.origin_source,
				l.opt_out,
				l.legal_basis,
				l.purpose,
				l.legal_registered_at,
				l.first_contact_by_human,
				c.id             as conversation_id,
				c.state,
				c.engagement_mode,
				c.handoff_active,
				c.last_inbound_at,
				c.last_outbound_at
			from leads l
			left join conversations c on c.lead_id = l.id
			where (
				${busca}::text is null
				or l.name ilike '%' || ${busca} || '%'
				or l.phone_number like '%' || ${busca} || '%'
			)
			and (${filtroStatus}::text is null or c.state = ${filtroStatus})
			order by
				c.handoff_active desc nulls last,
				c.last_inbound_at desc nulls last,
				l.created_at desc
			limit ${pageSize} offset ${offset}
		`);

		const rows = (resultado as unknown as { rows: LinhaLead[] }).rows;
		return { page, pageSize, itens: rows.map(paraItem) };
	});

	app.get("/api/leads/:id", async (req, reply) => {
		const parsed = idParams.safeParse(req.params);
		if (!parsed.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}

		const resultado = await core.db.execute(sql`
			select
				l.id,
				l.name,
				l.phone_number,
				l.origin_source,
				l.opt_out,
				l.legal_basis,
				l.purpose,
				l.legal_registered_at,
				l.first_contact_by_human,
				c.id             as conversation_id,
				c.state,
				c.engagement_mode,
				c.handoff_active,
				c.last_inbound_at,
				c.last_outbound_at,
				(select max(o.occurred_at) from optout_ledger o where o.lead_id = l.id)
					as opt_out_at,
				(
					select c2.pipeline_status
					from conversations c2
					where c2.lead_id = l.id
					order by c2.created_at desc
					limit 1
				) as pipeline_status,
				(
					select coalesce(json_agg(tg.name order by tg.name), '[]'::json)
					from lead_tags lt
					join tags tg on tg.id = lt.tag_id
					where lt.lead_id = l.id
				) as tags
			from leads l
			left join conversations c on c.lead_id = l.id
			where l.id = ${parsed.data.id}
		`);

		const row = (resultado as unknown as { rows: LinhaLead[] }).rows[0];
		if (!row) {
			return reply.code(404).send({ erro: "lead nao encontrado" });
		}

		// Campos de compliance (LGPD, R-064) expostos junto do lead: o Admin
		// precisa ver a base legal e a finalidade no próprio cartão do lead.
		// `optOutAt` é a data "Solicitado em ___" do wireframe §4.3.
		// `pipelineStatus` e `tags` alimentam o cabeçalho da gaveta de detalhe
		// (wireframe §4) — o funil de vendas e as etiquetas do lead.
		return {
			...paraItem(row),
			optOutAt: paraIso(row.opt_out_at),
			pipelineStatus: row.pipeline_status ?? null,
			tags: paraTags(row.tags),
			compliance: {
				legalBasis: row.legal_basis,
				purpose: row.purpose,
				legalRegisteredAt: row.legal_registered_at,
				firstContactByHuman: row.first_contact_by_human,
			},
		};
	});

	// --- Opt-out manual (R-024/AR-005, T-03-41/T-03-42) --------------------
	//
	// Irreversível: não existe "desfazer" no banco (trigger
	// `trg_leads_opt_out_irreversivel`) nem na UI. Por isso o corpo exige o
	// literal `OPTOUT` e a prova é DUPLA — `optout_ledger(source='manual')` e
	// `event_log('optout_manual')` — gravadas na MESMA transação: um opt-out
	// sem trilha é irreversível sem auditoria, que é o pior dos dois mundos.
	//
	// Idempotente: a segunda chamada devolve `{optOut:true, mudou:false}` e não
	// duplica prova nenhuma.
	app.post("/api/leads/:id/opt-out", async (req, reply) => {
		const params = idParams.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}
		const body = confirmarOptOutBody.safeParse(req.body);
		if (!body.success) {
			return reply.code(400).send({
				erro: "confirmacao invalida",
				detalhes: body.error.issues.map((i) => i.message),
			});
		}

		// 404 ANTES de qualquer escrita: um lead inexistente não pode "criar"
		// um opt-out, e a checagem evita gravar prova de um lead que não existe.
		const lido = await core.db.execute(sql`
			select id, legal_basis, purpose
			from leads
			where id = ${params.data.id}
		`);
		const lead = (
			lido as unknown as {
				rows: {
					id: string;
					legal_basis: string | null;
					purpose: string | null;
				}[];
			}
		).rows[0];
		if (!lead) {
			return reply.code(404).send({ erro: "lead nao encontrado" });
		}

		const legalBasis = lead.legal_basis ?? BASE_LEGAL_PADRAO;
		const purpose = lead.purpose ?? FINALIDADE_PADRAO;
		const agora = core.agora?.() ?? new Date();

		const resultado = await core.db.transaction(async (txBruto) => {
			const tx = txBruto as unknown as Db;

			// `applyOptOut` abre a sua própria transação (savepoint quando já
			// estamos dentro de uma) — a atomicidade do opt-out + ledger é
			// dela e não é reimplementada aqui.
			const mudou = await applyOptOut(tx, {
				leadId: params.data.id,
				rawContent: PROVA_OPT_OUT_MANUAL,
				legalBasis,
				purpose,
				source: "manual",
				occurredAt: agora,
			});

			// Idempotência: sem mudança de estado, sem prova nova. A segunda
			// chamada não duplica nem o ledger nem o `event_log`.
			if (!mudou) return { mudou: false };

			await tx.execute(sql`
				insert into event_log (
					event_type, entity_type, entity_id, lead_id, payload, severity
				)
				values (
					'optout_manual',
					'lead',
					${params.data.id},
					${params.data.id},
					${JSON.stringify({ leadId: params.data.id, source: "manual" })}::jsonb,
					'warn'
				)
			`);

			return { mudou: true };
		});

		return { optOut: true, mudou: resultado.mudou };
	});
};
