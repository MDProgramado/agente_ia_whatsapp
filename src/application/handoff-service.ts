/**
 * Handoff atômico + silêncio total + notificação (02-02 Task 2, D-11/D-12/D-13).
 *
 * Handoff não é "avisar um humano": é o bot PARAR de falar no mesmo instante em
 * que registra a parada. As quatro escritas moram numa transação única porque um
 * estado parcial é uma violação de compliance — se `handoff_events` gravasse e
 * `engagement_mode` não, o sistema teria registrado que ia parar e continuaria
 * falando (AR-010/R-012). A coluna `simultaneous_send_blocked` existe para provar
 * que a parada foi EFEITO, não intenção (`schema.ts:399-403`).
 *
 * ## O que é gravado, e por que os quatro juntos
 *
 * 1. `handoff_events` — a linha append-only do porquê (R-012/R-065/R-022), com
 *    todas as colunas NOT NULL: `lead_id` e `channel_account_id` lidos da
 *    conversa, `excerpt` do gatilho, `simultaneous_send_blocked=true` e
 *    `bot_stopped_at=now()`.
 * 2. `mode_changes` — de/para do `engagement_mode` (R-066/COMP-05). `from` é o
 *    modo REAL lido da conversa (inclusive `shadow`), nunca um literal chutado.
 * 3. `conversations.engagement_mode='awaiting_human'` + `handoff_active=true` —
 *    o estado que faz o gate (R-066) e o dispatcher calarem.
 * 4. `status_history` — a transição de `state` (R-022), via `resolveNextState`
 *    (a FSM decide; não há `set` cru).
 *
 * ## Idempotência
 *
 * A conversa é lida `FOR UPDATE`; se já está em handoff ativo, NADA é gravado e
 * NADA é notificado. Repetir o gatilho é inofensivo — um segundo
 * `handoff_events` para a mesma parada seria ruído no relatório, e uma segunda
 * notificação treinaria o Admin a ignorar o alerta.
 *
 * ## Notificação que nunca interrompe o handoff
 *
 * A notificação sai FORA da transação e o `notify` é envolvido em `try/catch`.
 * A porta já promete não lançar (NotifyPort), mas a promessa é do contrato, não
 * do runtime: um `throw` de um mock (ou de um bug na implementação) não pode
 * desfazer um handoff já commitado (T-02-10).
 */
import { sql } from "drizzle-orm";
import {
	type Estado,
	resolveNextState,
} from "../domain/orchestrator/transitions.js";
import type { NotifyPort } from "../domain/ports/NotifyPort.js";
import type { Db } from "../infra/db/client.js";
import { recordStatusChange } from "../infra/db/queries/status-history.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger("handoff");

/** Um dos valores do CHECK `handoff_events_triggered_by_check`. */
export type HandoffTriggeredBy =
	| "keyword"
	| "intent"
	| "message_type"
	| "opt_out"
	| "validation_error"
	| "low_confidence"
	| "user_defined";

/** Um dos valores do CHECK `mode_changes_actor_check`. */
export type HandoffActor = "bot" | "admin" | "system";

export interface HandoffInput {
	readonly conversationId: string;
	/** Motivo legível do gatilho — vai para `trigger_detail` e para a notificação. */
	readonly reason: string;
	readonly triggeredBy: HandoffTriggeredBy;
	readonly triggerDetail?: string | null;
	readonly triggerValue?: string | null;
	/** Trecho da mensagem-gatilho. NOT NULL no schema; default = `reason`. */
	readonly excerpt?: string | null;
	readonly actor?: HandoffActor;
	/** Instante do fato; injetável para determinismo. Default `new Date()`. */
	readonly agora?: Date;
}

export interface HandoffResult {
	/** `false` quando a conversa já estava em handoff (idempotente). */
	readonly disparado: boolean;
	readonly handoffId: string | null;
}

/** Dependências externas à transação; a notificação é o único efeito de borda. */
export interface HandoffDeps {
	readonly notifier?: NotifyPort;
}

/** Corte do `excerpt`, igual ao do painel/trigger (280 caracteres). */
const CORTE_EXCERPT = 280;

interface ConversaLock {
	readonly id: string;
	readonly lead_id: string;
	readonly channel_account_id: string;
	readonly state: string;
	readonly engagement_mode: string;
	readonly handoff_active: boolean;
	readonly name: string | null;
}

/**
 * Dispara o handoff. `dispararHandoff(db, input)` é a forma do plano; `deps`
 * carrega o notificador (opcional — sem ele o handoff acontece e só não notifica,
 * o que mantém testes e boot degradado válidos).
 */
export const dispararHandoff = async (
	db: Db,
	input: HandoffInput,
	deps: HandoffDeps = {},
): Promise<HandoffResult> => {
	const agora = input.agora ?? new Date();
	const actor: HandoffActor = input.actor ?? "bot";
	const excerpt = (input.excerpt ?? input.triggerDetail ?? input.reason).slice(
		0,
		CORTE_EXCERPT,
	);

	const resultado = await db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;

		// `FOR UPDATE OF c` trava só a conversa: serializa dois gatilhos
		// concorrentes sem travar `leads` (que tem trigger de DELETE).
		const lido = await tx.execute(sql`
			select c.id, c.lead_id, c.channel_account_id, c.state,
				c.engagement_mode, c.handoff_active, l.name
			from conversations c
			join leads l on l.id = c.lead_id
			where c.id = ${input.conversationId}
			for update of c
		`);
		const conv = (lido as unknown as { rows: ConversaLock[] }).rows[0];
		if (!conv) {
			throw new Error(
				`dispararHandoff: conversa ${input.conversationId} nao encontrada`,
			);
		}

		// Idempotência: já está em handoff → não duplica evento nem notificação.
		if (conv.handoff_active) {
			return {
				disparado: false as const,
				handoffId: null,
				leadName: conv.name,
			};
		}

		const inserido = await tx.execute(sql`
			insert into handoff_events (
				conversation_id, lead_id, channel_account_id, triggered_by,
				trigger_detail, trigger_value, excerpt,
				simultaneous_send_blocked, bot_stopped_at
			)
			values (
				${conv.id},
				${conv.lead_id},
				${conv.channel_account_id},
				${input.triggeredBy},
				${input.triggerDetail ?? input.reason},
				${input.triggerValue ?? null},
				${excerpt},
				true,
				${agora}
			)
			returning id
		`);
		const handoffId = (inserido as unknown as { rows: { id: string }[] })
			.rows[0]?.id;
		if (!handoffId) {
			throw new Error(
				"dispararHandoff: o INSERT de handoff_events nao devolveu id",
			);
		}

		await tx.execute(sql`
			insert into mode_changes (conversation_id, from_mode, to_mode, actor, reason)
			values (${conv.id}, ${conv.engagement_mode}, 'awaiting_human', ${actor}, ${input.reason})
		`);

		// A FSM decide o `state`; a parada já está provada por `handoff_active`.
		const proximo = resolveNextState(conv.state as Estado, undefined, {
			handoffDisparado: true,
		});
		await tx.execute(sql`
			update conversations
			set engagement_mode = 'awaiting_human', handoff_active = true, state = ${proximo}
			where id = ${conv.id}
		`);

		if (proximo !== conv.state) {
			await recordStatusChange(tx, {
				conversationId: conv.id,
				fromState: conv.state,
				toState: proximo,
				changedBy: actor,
				reason: input.reason,
				changedAt: agora,
			});
		}

		return {
			disparado: true as const,
			handoffId,
			leadName: conv.name,
			proximo,
			stateAnterior: conv.state,
		};
	});

	if (!resultado.disparado) {
		log.info(
			{ event: "handoff_idempotente", conversation_id: input.conversationId },
			"conversa ja em handoff ativo — nada duplicado",
		);
		return { disparado: false, handoffId: null };
	}

	// Notificação fora da transação; `try/catch` porque o contrato promete não
	// lançar, mas um handoff commitado não pode ser desfeito por um `notify`.
	try {
		await deps.notifier?.notify({
			title: `Handoff: ${resultado.leadName ?? "lead sem nome"}`,
			message:
				`${input.reason} — ${excerpt}\n` +
				`Ação: npm run handoff:ack ${resultado.handoffId}`,
			urgent: true,
			sound: true,
		});
	} catch (erro) {
		const motivo = erro instanceof Error ? erro.message : String(erro);
		log.error(
			{
				event: "handoff_notify_falhou",
				conversation_id: input.conversationId,
			},
			`notificacao de handoff falhou (ignorada): ${motivo}`,
		);
	}

	log.warn(
		{
			event: "handoff_disparado",
			conversation_id: input.conversationId,
			handoff_id: resultado.handoffId,
			triggered_by: input.triggeredBy,
			state: resultado.proximo,
		},
		`sinal de handoff — automacao em silencio total (${input.reason})`,
	);

	return { disparado: true, handoffId: resultado.handoffId };
};
