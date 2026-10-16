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
import type { Db } from "../../infra/db/client.js";
import { recordStatusChange } from "../../infra/db/queries/status-history.js";
import { acaoConversaBody, idParams } from "../schemas.js";
import type { PanelCore } from "../server.js";

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
	lead: {
		id: row.lead_id,
		name: row.name,
		phoneNumber: row.phone_number,
		originSource: row.origin_source,
		optOut: row.opt_out,
	},
});

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
};
