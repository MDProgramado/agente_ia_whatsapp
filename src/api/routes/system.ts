/**
 * Estado operacional do sistema + kill switch (R-045, D-19/D-20).
 *
 * `GET /api/system` é o cabeçalho do painel: modo operacional, se a janela está
 * aberta (e quando abre de novo), os contadores do dia e a fila de handoffs
 * pendentes por prioridade.
 *
 * `POST /api/system/kill-switch` tem EXATAMENTE o efeito do CLI `mode paused`
 * (D-20): grava `settings.operational_mode = 'paused'` e o evento de auditoria
 * `operational_mode_changed` na MESMA transação. A única diferença é
 * `source: "panel"` (em vez de `"cli"`) — a trilha precisa distinguir de onde
 * veio o desligamento. O modo é lido pelo snapshot do gate (`#>> '{}'`), então
 * ligar o kill switch aqui bloqueia TODO envio imediatamente, sem passo extra.
 */
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { CHAVE_MODO_OPERACIONAL, lerModoOperacional } from "../../cli/mode.js";
import {
	ehDiaUtil,
	isWithinWindow,
	nextWindow,
} from "../../domain/business-hours.js";
import type { Db } from "../../infra/db/client.js";
import { killSwitchBody } from "../schemas.js";
import type { PanelCore } from "../server.js";

/** `YYYY-MM-DD` no fuso do negócio — a chave de `daily_counters`. */
const diaLocal = (agora: Date, tz: string): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(agora);

interface LinhaContador {
	readonly kind: string;
	readonly count: number;
}

interface LinhaHandoff {
	readonly id: string;
	readonly conversation_id: string;
	readonly lead_id: string;
	readonly triggered_by: string;
	readonly trigger_detail: string | null;
	readonly trigger_value: string | null;
	readonly excerpt: string;
	readonly bot_stopped_at: string;
	readonly created_at: string;
	readonly name: string | null;
	readonly phone_number: string;
}

export const registrarSystem = (
	app: FastifyInstance,
	core: PanelCore,
): void => {
	app.get("/api/system", async () => {
		const agora = core.agora !== undefined ? core.agora() : new Date();
		const {
			tz,
			windowStartHour,
			windowEndHour,
			dailyMessageLimit,
			dailyMessageCap,
		} = core.dispatchDeps.ctx;

		const modo = await lerModoOperacional(core.db);
		const diaUtil = ehDiaUtil(agora, tz, core.feriados);
		const dentroHorario = isWithinWindow(
			agora,
			tz,
			windowStartHour,
			windowEndHour,
		);
		const janelaAberta = diaUtil && dentroHorario;

		const dia = diaLocal(agora, tz);
		const contadoresLidos = await core.db.execute(sql`
			select kind, count from daily_counters where day = ${dia}
		`);
		const contadores = (contadoresLidos as unknown as { rows: LinhaContador[] })
			.rows;
		const enviadas = contadores.find((c) => c.kind === "sent")?.count ?? 0;
		const novosContatos =
			contadores.find((c) => c.kind === "new_contacts")?.count ?? 0;

		// Fila de handoffs pendentes. A prioridade espelha a taxonomia da UI-SPEC
		// (opt-out e suspeita de automação primeiro; mídia e "demais" por último),
		// por casamento de termo em `trigger_detail` — melhor esforço até a
		// taxonomia exata de `trigger_value` ser fixada. Empate: mais antigo antes.
		const filaLida = await core.db.execute(sql`
			select
				h.id, h.conversation_id, h.lead_id, h.triggered_by,
				h.trigger_detail, h.trigger_value, h.excerpt,
				h.bot_stopped_at, h.created_at,
				l.name, l.phone_number
			from handoff_events h
			join leads l on l.id = h.lead_id
			where h.human_acknowledged_at is null
			order by
				case
					when h.triggered_by = 'opt_out' then 1
					when h.trigger_detail ilike '%autom%' then 2
					when h.trigger_detail ilike '%irrita%' then 3
					when h.trigger_detail ilike '%den%ncia%' then 4
					when h.trigger_detail ilike '%pre%o%' then 5
					when h.trigger_detail ilike '%agenda%' then 6
					when h.triggered_by = 'message_type' then 7
					else 8
				end,
				h.created_at asc
			limit 50
		`);
		const fila = (filaLida as unknown as { rows: LinhaHandoff[] }).rows.map(
			(row) => ({
				id: row.id,
				conversationId: row.conversation_id,
				leadId: row.lead_id,
				leadName: row.name,
				phoneNumber: row.phone_number,
				triggeredBy: row.triggered_by,
				triggerDetail: row.trigger_detail,
				triggerValue: row.trigger_value,
				excerpt: row.excerpt,
				botStoppedAt: row.bot_stopped_at,
				createdAt: row.created_at,
			}),
		);

		return {
			mode: modo,
			now: agora.toISOString(),
			window: {
				aberta: janelaAberta,
				diaUtil,
				inicio: windowStartHour,
				fim: windowEndHour,
				proximaAbertura: janelaAberta
					? null
					: nextWindow(
							agora,
							tz,
							windowStartHour,
							windowEndHour,
							core.feriados,
						).toISOString(),
			},
			counters: {
				day: dia,
				sent: enviadas,
				sentLimit: dailyMessageLimit,
				sentCap: dailyMessageCap,
				newContacts: novosContatos,
			},
			handoffQueue: fila,
		};
	});

	app.post("/api/system/kill-switch", async (req, reply) => {
		const body = killSwitchBody.safeParse(req.body);
		if (!body.success) {
			return reply.code(400).send({
				erro: "kill switch exige confirm: true",
				detalhes: body.error.issues.map((i) => i.message),
			});
		}

		const de = await lerModoOperacional(core.db);
		await core.db.transaction(async (txBruto) => {
			const tx = txBruto as unknown as Db;
			await tx.execute(sql`
				insert into settings (key, value, updated_at)
				values (${CHAVE_MODO_OPERACIONAL}, ${JSON.stringify("paused")}::jsonb, now())
				on conflict (key) do update
					set value = excluded.value, updated_at = now()
			`);
			await tx.execute(sql`
				insert into event_log (event_type, entity_type, payload, severity)
				values (
					'operational_mode_changed',
					'settings',
					${JSON.stringify({
						from: de,
						to: "paused",
						actor: "admin",
						reason: "kill switch do painel",
						source: "panel",
					})}::jsonb,
					'info'
				)
			`);
		});

		return { mode: "paused", from: de };
	});
};
