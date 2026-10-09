/**
 * O dreno da fila. **Reavalia o gate a cada job.**
 *
 * A reavaliação não é um passo a mais: é estrutural. Entre o enfileiramento (9h)
 * e o dreno (10h) o lead pode ter pedido opt-out (AR-005), o handoff pode ter
 * sido acionado (AR-010) ou a janela pode ter fechado (AR-007). Como o worker
 * chama `dispatch`, e `dispatch` **sempre** roda o gate com snapshot fresco, não
 * existe caminho de envio sem gate (T-01-21).
 *
 * Este arquivo **não** invoca envio — é o `grep`
 * (`tests/lint/choke-point.grep.test.ts`) que garante isso. O worker só reserva,
 * decide o destino do job e conta.
 */
import type { Db } from "../infra/db/client.js";
import { logger } from "../infra/logger.js";
import { type DispatchDeps, dispatch } from "./dispatcher.js";
import { abandon, reserveNext } from "./outbox.js";

/** O worker precisa de tudo que o `dispatch` precisa, mais o relógio. */
export interface WorkerDeps extends Omit<DispatchDeps, "db"> {
	readonly now: Date;
}

export interface DrainResult {
	readonly drained: number;
	readonly sent: number;
	readonly blocked: number;
	readonly deferred: number;
}

export interface DrainOpts {
	/** Filtro opcional por conversa (testes). O dreno de produção não filtra. */
	readonly conversationId?: string;
}

/**
 * Um passo do dreno: reserva no máximo **um** job e o resolve.
 *
 * - fila vazia → tudo zero;
 * - `sent` → o `dispatch` já fechou o job (`markSent`);
 * - `blocked` → o `dispatch` já gravou `blocked_attempts`; aqui o job é
 *   abandonado com o **mesmo** motivo canônico que o `dispatch` devolveu;
 * - `deferred` → o `dispatch` já chamou `markDeferred` (o job volta `pending` na
 *   próxima janela); o deferimento não queima o job nem é violação;
 * - `silencio` → falha fechada (snapshot ausente/erro): o job é abandonado.
 */
export const drainOnce = async (
	db: Db,
	deps: WorkerDeps,
	opts: DrainOpts = {},
): Promise<DrainResult> => {
	const job = await reserveNext(db, {
		now: deps.now,
		conversationId: opts.conversationId,
	});
	if (!job) return { drained: 0, sent: 0, blocked: 0, deferred: 0 };

	const resultado = await dispatch(
		{ db, channel: deps.channel, ctx: deps.ctx },
		{
			conversationId: job.conversationId,
			text: job.body,
			now: deps.now,
			origin: job.origin,
			idempotencyKey: job.idempotencyKey,
			scheduledFor: job.scheduledFor,
			outboxJobId: job.id,
		},
	);

	switch (resultado.action) {
		case "sent":
			return { drained: 1, sent: 1, blocked: 0, deferred: 0 };
		case "blocked":
			await abandon(db, job.id, resultado.reason);
			logger.info(
				{
					event: "outbox_job_abandonado",
					reason: resultado.reason,
					outbox_id: job.id,
				},
				"follow-up cancelado na reavaliacao do gate",
			);
			return { drained: 1, sent: 0, blocked: 1, deferred: 0 };
		case "deferred":
			return { drained: 1, sent: 0, blocked: 0, deferred: 1 };
		case "silencio":
			await abandon(db, job.id, resultado.reason);
			logger.warn(
				{
					event: "outbox_job_silencio",
					reason: resultado.reason,
					outbox_id: job.id,
				},
				"falha fechada: job abandonado sem envio",
			);
			return { drained: 1, sent: 0, blocked: 1, deferred: 0 };
	}
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export interface DrainLoopOpts extends DrainOpts {
	readonly intervalMs?: number;
	/**
	 * O laço para quando o sinal é abortado. O fechamento gracioso importa: um
	 * kill abrupto durante `useMultiFileAuthState` corrompe a pasta de auth, e o
	 * WhatsApp lê isso como um dispositivo novo (STACK §Version Compatibility).
	 */
	readonly signal?: AbortSignal;
}

/**
 * Dreno em ciclo. O startup roda `requeueStale` **antes** (recupera jobs presos
 * de um crash); quem chama monta o `AbortSignal` a partir de `/SIGINT`/`SIGTERM`.
 */
export const drainLoop = async (
	db: Db,
	deps: WorkerDeps,
	opts: DrainLoopOpts = {},
): Promise<void> => {
	const intervalMs = opts.intervalMs ?? 30_000;
	while (!opts.signal?.aborted) {
		await drainOnce(db, deps, opts);
		await sleep(intervalMs);
	}
};
