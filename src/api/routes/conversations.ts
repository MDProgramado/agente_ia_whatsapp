/**
 * Detalhe de conversa e ações rápidas do painel (R-046, D-20/D-23).
 *
 * As ações (`pausar`/`assumir`/`devolver`/`copiloto`) são **overrides explícitos
 * do Admin**, não transições do modelo: a FSM (`resolveNextState`) governa as
 * transições automáticas; o Admin é autoridade e pode mudar o modo/estado à mão.
 * Toda ação é auditada em `mode_changes` + `status_history` (quando há mudança de
 * estado) + `event_log`, na MESMA transação — um override sem trilha é
 * exatamente o "quem mudou o quê e quando" que a auditoria (R-022) precisa
 * responder.
 *
 * `assumir` também confirma os handoffs abertos (`human_acknowledged_at`): o
 * Admin que assume viu a fila. `devolver` desliga `handoff_active` e devolve o
 * modo para `bot_active` — é o ÚNICO caminho que reativa a automação (D-15: o
 * bot só volta a falar por ação explícita, nunca por timeout).
 */
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
	agendarConfirmacao,
	tratarRespostaAgendamento,
} from "../../application/appointment.js";
import type { Db } from "../../infra/db/client.js";
import { loadBlockedAttempts } from "../../infra/db/queries/blocked-attempts.js";
import {
	loadStatusHistory,
	recordStatusChange,
} from "../../infra/db/queries/status-history.js";
import { acaoConversaBody, idParams } from "../schemas.js";
import type { PanelCore } from "../server.js";

/**
 * Teto de linhas por fonte na trilha de auditoria (D-23). O painel quer a
 * janela recente do que aconteceu; a tabela inteira seria ruído e custo.
 */
const AUDIT_LIMITE = 200;

/**
 * `timestamptz` chega do driver como `Date`; a API fala ISO-8601 (string).
 * A conversão mora na borda para que o contrato do painel seja explícito em
 * vez de herdado do driver.
 */
const paraIso = (valor: Date | string | null | undefined): string | null => {
	if (valor === null || valor === undefined) return null;
	return valor instanceof Date ? valor.toISOString() : String(valor);
};

/** Corpo do agendamento manual da reunião (D-25). */
const agendamentoBody = z.object({
	quando: z.coerce.date({ message: "quando invalido" }),
	tipo: z.enum(["confirmacao", "lembrete"], { message: "tipo invalido" }),
});

/** Corpo da resposta do lead sobre a reunião. */
const respostaAgendamentoBody = z.object({
	resposta: z.enum(["confirmar", "remarcar", "cancelar"], {
		message: "resposta invalida",
	}),
});

interface LinhaConversa {
	readonly id: string;
	readonly state: string;
	readonly engagement_mode: string;
	readonly stage: string;
	readonly qualification: unknown;
	readonly follow_up_index: number;
	readonly handoff_active: boolean;
	readonly last_inbound_at: string | null;
	readonly last_outbound_at: string | null;
	readonly created_at: string;
	readonly lead_id: string;
	readonly name: string | null;
	readonly phone_number: string;
	readonly origin_source: string | null;
	readonly opt_out: boolean;
	readonly pipeline_status: string;
	readonly closed_reason: string | null;
}

/** Alvo de cada ação: o par (estado, modo) e se o handoff é desligado. */
interface AlvoAcao {
	readonly state: string;
	readonly mode: string;
	readonly limpaHandoff: boolean;
}

const ALVOS: Record<string, AlvoAcao> = {
	pausar: { state: "pausado", mode: "pausado", limpaHandoff: false },
	assumir: { state: "human", mode: "human", limpaHandoff: false },
	devolver: { state: "qualificando", mode: "bot_active", limpaHandoff: true },
	copiloto: { state: "copilot", mode: "copilot", limpaHandoff: false },
};

const paraDetalhe = (row: LinhaConversa) => ({
	id: row.id,
	state: row.state,
	engagementMode: row.engagement_mode,
	stage: row.stage,
	qualification:
		typeof row.qualification === "object" && row.qualification !== null
			? row.qualification
			: {},
	followUpIndex: row.follow_up_index,
	handoffActive: row.handoff_active,
	lastInboundAt: row.last_inbound_at,
	lastOutboundAt: row.last_outbound_at,
	createdAt: row.created_at,
	pipelineStatus: row.pipeline_status,
	closedReason: row.closed_reason,
	lead: {
		id: row.lead_id,
		name: row.name,
		phoneNumber: row.phone_number,
		originSource: row.origin_source,
		optOut: row.opt_out,
	},
});

/** Uma linha de `handoff_events` como a trilha de auditoria a consome. */
interface LinhaHandoff {
	readonly id: string;
	readonly conversation_id: string;
	readonly lead_id: string;
	readonly triggered_by: string;
	readonly trigger_detail: string | null;
	readonly trigger_value: string | null;
	readonly excerpt: string;
	readonly simultaneous_send_blocked: boolean;
	readonly bot_stopped_at: Date | string;
	readonly human_acknowledged_at: Date | string | null;
	readonly created_at: Date | string;
}

/**
 * Lê os handoffs de uma conversa, mais recentes primeiro.
 *
 * `handoff_events` é TABELA e não coluna porque "por que a automação parou
 * aqui?" é uma pergunta que precisa de histórico (R-012/R-022). Aqui só se lê:
 * esta é a via read-only do painel (D-23) e a rota das ações do Admin é que
 * escreve.
 */
const carregarHandoffEvents = async (
	db: Db,
	conversationId: string,
): Promise<LinhaHandoff[]> => {
	const resultado = await db.execute(sql`
		select
			id, conversation_id, lead_id, triggered_by, trigger_detail,
			trigger_value, excerpt, simultaneous_send_blocked,
			bot_stopped_at, human_acknowledged_at, created_at
		from handoff_events
		where conversation_id = ${conversationId}
		order by created_at desc
		limit ${AUDIT_LIMITE}
	`);
	return (resultado as unknown as { rows: LinhaHandoff[] }).rows;
};

export const registrarConversations = (
	app: FastifyInstance,
	core: PanelCore,
): void => {
	app.get("/api/conversations/:id", async (req, reply) => {
		const parsed = idParams.safeParse(req.params);
		if (!parsed.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}

		const resultado = await core.db.execute(sql`
			select
				c.id, c.state, c.engagement_mode, c.stage, c.qualification,
				c.follow_up_index, c.handoff_active,
				c.last_inbound_at, c.last_outbound_at, c.created_at,
				c.pipeline_status, c.closed_reason,
				l.id as lead_id, l.name, l.phone_number, l.origin_source, l.opt_out
			from conversations c
			join leads l on l.id = c.lead_id
			where c.id = ${parsed.data.id}
		`);

		const row = (resultado as unknown as { rows: LinhaConversa[] }).rows[0];
		if (!row) {
			return reply.code(404).send({ erro: "conversa nao encontrada" });
		}
		return paraDetalhe(row);
	});

	app.post("/api/conversations/:id/actions", async (req, reply) => {
		const params = idParams.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}
		const body = acaoConversaBody.safeParse(req.body);
		if (!body.success) {
			return reply.code(400).send({
				erro: "acao invalida",
				detalhes: body.error.issues.map((i) => i.message),
			});
		}

		const alvo = ALVOS[body.data.action];
		if (!alvo) {
			// Inalcançável: o enum do schema cobre as quatro chaves de ALVOS.
			return reply.code(400).send({ erro: "acao desconhecida" });
		}

		const resultado = await core.db.transaction(async (txBruto) => {
			const tx = txBruto as unknown as Db;

			const lido = await tx.execute(sql`
				select state, engagement_mode
				from conversations
				where id = ${params.data.id}
				for update
			`);
			const atual = (
				lido as unknown as {
					rows: { state: string; engagement_mode: string }[];
				}
			).rows[0];
			if (!atual) return { encontrado: false as const };

			await tx.execute(sql`
				update conversations
				set state = ${alvo.state},
				    engagement_mode = ${alvo.mode},
				    handoff_active = ${alvo.limpaHandoff ? false : sql`handoff_active`}
				where id = ${params.data.id}
			`);

			if (alvo.limpaHandoff) {
				// `devolver` reabre a automação — mas nunca sem que o handoff
				// tenha sido reconhecido: o Admin que devolve também "viu".
				await tx.execute(sql`
					update handoff_events
					set human_acknowledged_at = now()
					where conversation_id = ${params.data.id}
					  and human_acknowledged_at is null
				`);
			}
			if (body.data.action === "assumir") {
				await tx.execute(sql`
					update handoff_events
					set human_acknowledged_at = now()
					where conversation_id = ${params.data.id}
					  and human_acknowledged_at is null
				`);
			}

			// Auditoria do modo (sempre) e do estado (só quando muda).
			if (atual.engagement_mode !== alvo.mode) {
				await tx.execute(sql`
					insert into mode_changes (
						conversation_id, from_mode, to_mode, actor, reason
					)
					values (
						${params.data.id},
						${atual.engagement_mode},
						${alvo.mode},
						'admin',
						${`painel:${body.data.action}`}
					)
				`);
			}
			if (atual.state !== alvo.state) {
				await recordStatusChange(tx, {
					conversationId: params.data.id,
					fromState: atual.state,
					toState: alvo.state,
					changedBy: "admin",
					reason: `painel:${body.data.action}`,
				});
			}

			await tx.execute(sql`
				insert into event_log (
					event_type, entity_type, entity_id, conversation_id,
					payload, severity
				)
				values (
					'panel_action',
					'conversation',
					${params.data.id},
					${params.data.id},
					${JSON.stringify({
						action: body.data.action,
						fromState: atual.state,
						toState: alvo.state,
						fromMode: atual.engagement_mode,
						toMode: alvo.mode,
					})}::jsonb,
					'info'
				)
			`);

			return {
				encontrado: true as const,
				fromState: atual.state,
				toState: alvo.state,
				fromMode: atual.engagement_mode,
				toMode: alvo.mode,
			};
		});

		if (!resultado.encontrado) {
			return reply.code(404).send({ erro: "conversa nao encontrada" });
		}
		return {
			action: body.data.action,
			state: resultado.toState,
			engagementMode: resultado.toMode,
		};
	});

	// --- Trilha de auditoria read-only (D-23, R-043/R-022) -----------------
	//
	// As QUATRO fontes de histórico do painel (`messages`, `status_history`,
	// `handoff_events`, `blocked_attempts`) são append-only e SÓ LEEM. Esta rota
	// serve as três últimas — `messages` já tem rota própria
	// (`GET /api/conversations/:id/messages`) — e o painel funde as quatro
	// numa linha do tempo cronológica.
	//
	// Aqui esta rota não escreve nada: histórico que pode ser corrigido depois
	// não é histórico. A verificação do plano confere isso por `grep` na rota
	// nova (o resto do arquivo tem as escritas das AÇÕES do Admin, que são de
	// outro plano e são auditadas).
	app.get("/api/conversations/:id/audit", async (req, reply) => {
		const parsed = idParams.safeParse(req.params);
		if (!parsed.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}

		// 404 quando a conversa não existe: a trilha é POR conversa, e devolver
		// listas vazias para um id inválido esconderia erro de integração.
		const existe = await core.db.execute(sql`
			select id from conversations where id = ${parsed.data.id}
		`);
		if (!(existe as unknown as { rows: { id: string }[] }).rows[0]) {
			return reply.code(404).send({ erro: "conversa nao encontrada" });
		}

		// SEQUENCIAL, não `Promise.all`: dentro de uma transação o cliente `pg` é
		// único, e duas queries concorrentes nele são um erro de protocolo
		// ("Calling client.query() when the client is already executing a
		// query"). Três leituras locais em sequência custam menos que a
		// correctedura.
		const statusHistory = await loadStatusHistory(
			core.db,
			parsed.data.id,
			AUDIT_LIMITE,
		);
		const handoffEvents = await carregarHandoffEvents(core.db, parsed.data.id);
		const blockedAttempts = await loadBlockedAttempts(
			core.db,
			parsed.data.id,
			AUDIT_LIMITE,
		);

		return {
			statusHistory: statusHistory.map((linha) => ({
				id: linha.id,
				conversationId: linha.conversationId,
				fromState: linha.fromState,
				toState: linha.toState,
				changedBy: linha.changedBy,
				reason: linha.reason,
				changedAt: paraIso(linha.changedAt),
			})),
			handoffEvents: handoffEvents.map((linha) => ({
				id: linha.id,
				conversationId: linha.conversation_id,
				leadId: linha.lead_id,
				triggeredBy: linha.triggered_by,
				triggerDetail: linha.trigger_detail,
				triggerValue: linha.trigger_value,
				excerpt: linha.excerpt,
				simultaneousSendBlocked: linha.simultaneous_send_blocked,
				botStoppedAt: paraIso(linha.bot_stopped_at),
				humanAcknowledgedAt: paraIso(linha.human_acknowledged_at),
				createdAt: paraIso(linha.created_at),
			})),
			blockedAttempts: blockedAttempts.map((linha) => ({
				id: linha.id,
				conversationId: linha.conversationId,
				leadId: linha.leadId,
				direction: linha.direction,
				guard: linha.guard,
				reasonCode: linha.reasonCode,
				ruleReference: linha.ruleReference,
				excerpt: linha.excerpt,
				detail: linha.detail,
				blockedAt: paraIso(linha.blockedAt),
				createdAt: paraIso(linha.createdAt),
			})),
		};
	});

	// --- Agendamento manual (FLUP-08/D-25, R-006/R-023/R-025) ----------------
	//
	// O Admin registra a reunião; o sistema agenda confirmação e lembrete já
	// normalizados para a janela e a cota. Data inválida vira 400 AQUI: agendar é
	// 100% manual, o bot nunca decide horário (D-25).
	app.post("/api/conversations/:id/agendamento", async (req, reply) => {
		const params = idParams.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}
		const body = agendamentoBody.safeParse(req.body);
		if (!body.success) {
			return reply.code(400).send({
				erro: "corpo invalido",
				detalhes: body.error.issues.map((i) => i.message),
			});
		}

		const ctx = core.dispatchDeps.ctx;
		const resultado = await agendarConfirmacao(
			core.db,
			{
				conversationId: params.data.id,
				quando: body.data.quando,
				tipo: body.data.tipo,
			},
			{
				agora: core.agora,
				tz: ctx.tz,
				inicioJanela: ctx.windowStartHour,
				fimJanela: ctx.windowEndHour,
				feriados: core.feriados,
			},
		);

		if (!resultado.ok) {
			return resultado.erro === "conversa_nao_encontrada"
				? reply.code(404).send({ erro: "conversa nao encontrada" })
				: reply.code(409).send({ erro: "limite_diario" });
		}

		return reply.code(resultado.duplicado ? 200 : 201).send({
			scheduledFor: resultado.scheduledFor.toISOString(),
			outboxId: resultado.outboxId,
			duplicado: resultado.duplicado,
		});
	});

	// Resposta do lead sobre a reunião: confirmar encerra pendências; remarcar ou
	// cancelar NUNCA é tratado pelo bot — handoff (R-025).
	app.post(
		"/api/conversations/:id/agendamento/resposta",
		async (req, reply) => {
			const params = idParams.safeParse(req.params);
			if (!params.success) {
				return reply.code(400).send({ erro: "id invalido" });
			}
			const body = respostaAgendamentoBody.safeParse(req.body);
			if (!body.success) {
				return reply.code(400).send({
					erro: "corpo invalido",
					detalhes: body.error.issues.map((i) => i.message),
				});
			}

			const resultado = await tratarRespostaAgendamento(
				core.db,
				{
					conversationId: params.data.id,
					resposta: body.data.resposta,
				},
				{ agora: core.agora },
			);

			if (resultado.tratado === "erro") {
				return reply.code(404).send({ erro: "conversa nao encontrada" });
			}
			return resultado;
		},
	);
};
