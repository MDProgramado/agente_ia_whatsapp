/**
 * A fila de saída durável (R-007, R-043) — o que sobrevive a um crash, a um
 * reboot e a um PC desligado a noite inteira.
 *
 * ## Por que a reserva é uma transação com `FOR UPDATE SKIP LOCKED`
 *
 * Dois workers drenando a mesma fila não podem pegar o mesmo job. A leitura
 * ingênua (`SELECT` depois `UPDATE`) é um TOCTOU: os dois leem a mesma linha,
 * os dois acham que reservaram, e a mensagem chega **duas vezes** ao lead — que é
 * o padrão de cadência de máquina mais associado a banimento (R-059). O
 * `SELECT ... FOR UPDATE SKIP LOCKED` faz a segunda transação **pular** a linha
 * lacrada em vez de esperar por ela, então exatamente um worker leva o job.
 *
 * ## Por que a cota NÃO é reservada aqui
 *
 * `reserveNext` não toca `daily_counters`. Reservar cota para um job que o gate
 * ainda pode bloquear (opt-out no meio do caminho, janela fechada) gastaria o
 * dia do lead sem nenhum envio (R-023). A cota é reservada **no envio**, dentro
 * da transação do `dispatch`, depois do gate.
 *
 * ## `ON CONFLICT` no `enqueue` é a primeira das três barreiras de duplicata
 *
 * (1) `outbox.idempotency_key` UNIQUE + `ON CONFLICT DO NOTHING` impede o
 * re-enfileiramento; (2) `SKIP LOCKED` impede dois workers; (3)
 * `messages.idempotency_key` UNIQUE impede a duplicata mesmo se as duas
 * primeiras falharem (T-01-16).
 */
import { sql } from "drizzle-orm";
import type { Db } from "../infra/db/client.js";
import { outbox } from "../infra/db/schema.js";

/** Os valores do `CHECK outbox_origin_check` (`0003`). */
export type OutboxOrigin = "bot" | "admin" | "followup" | "catchup";

const ORIGENS: readonly OutboxOrigin[] = [
	"bot",
	"admin",
	"followup",
	"catchup",
];

/** Um valor inesperado no banco nunca vira lixo para o chamador — cai em `bot`. */
const paraOrigin = (bruto: string): OutboxOrigin =>
	ORIGENS.find((o) => o === bruto) ?? "bot";

/** Um job reservado, já com os nomes do domínio (camelCase). */
export interface OutboxJob {
	readonly id: string;
	readonly conversationId: string;
	readonly body: string;
	readonly origin: OutboxOrigin;
	readonly idempotencyKey: string;
	readonly scheduledFor: Date;
	/** Já **incrementado** pela reserva — é o número após esta tentativa. */
	readonly attempts: number;
}

export interface EnqueueInput {
	readonly conversationId: string;
	readonly origin: OutboxOrigin;
	readonly body: string;
	readonly idempotencyKey: string;
	readonly scheduledFor?: Date;
}

export interface ReserveNextOpts {
	/**
	 * Instante de referência. Obrigatório no caminho do worker (o relógio é
	 * injetável), opcional aqui só para os testes chamarem sem construir um.
	 */
	readonly now?: Date;
	/**
	 * Filtro opcional por conversa. **Desvio do plano**, introduzido para que o
	 * teste de concorrência isole o job dele numa base de desenvolvimento
	 * compartilhada sem competir com jobs de outros testes. Em produção o dreno
	 * passa sem filtro (pega o próximo de qualquer conversa).
	 */
	readonly conversationId?: string;
}

export interface MarkFailedOpts {
	/** **Padrão `false`**: o padrão é NÃO repetir um envio que falhou. */
	readonly retryable?: boolean;
	readonly maxAttempts?: number;
	readonly backoffMs?: number;
	readonly now?: Date;
}

export interface RequeueStaleOpts {
	readonly olderThanMs?: number;
	readonly now?: Date;
	readonly conversationId?: string;
}

/**
 * Enfileira um job. Devolve o `id` novo, ou `null` se a `idempotency_key` já
 * existia — e `null` é a resposta **correta** para um re-enfileiramento: o job
 * já está na fila e um segundo INSERT não deve criar um segundo envio.
 */
export const enqueue = async (
	db: Db,
	input: EnqueueInput,
): Promise<string | null> => {
	const resultado = await db.execute(sql`
		INSERT INTO ${outbox} (conversation_id, origin, body, idempotency_key, scheduled_for)
		VALUES (
			${input.conversationId},
			${input.origin},
			${input.body},
			${input.idempotencyKey},
			${input.scheduledFor ?? new Date()}
		)
		ON CONFLICT (idempotency_key) DO NOTHING
		RETURNING id
	`);
	const rows = (resultado as unknown as { rows: { id: string }[] }).rows;
	return rows[0]?.id ?? null;
};

/**
 * Reserva o próximo job vencido, atomicamente. `null` quando a fila está vazia.
 *
 * A transação abre **aqui**, não no chamador: o `SELECT ... FOR UPDATE` só
 * segura o lock enquanto a transação viver, e a transação tem de ser tão curta
 * quanto a reserva. O envio acontece depois, fora do lock — prender o lock
 * durante a chamada de rede serializaria todo o dreno atrás de um lead lento.
 */
export const reserveNext = async (
	db: Db,
	opts: ReserveNextOpts = {},
): Promise<OutboxJob | null> => {
	const agora = opts.now ?? new Date();
	const filtroConversa = opts.conversationId
		? sql`AND conversation_id = ${opts.conversationId}`
		: sql``;

	return db.transaction(async (tx) => {
		const selecao = await tx.execute(sql`
			SELECT id, conversation_id, body, origin, idempotency_key, scheduled_for, attempts
			FROM ${outbox}
			WHERE status = 'pending' AND scheduled_for <= ${agora} ${filtroConversa}
			ORDER BY scheduled_for, id
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		`);
		const row = (
			selecao as unknown as {
				rows: {
					id: string;
					conversation_id: string;
					body: string;
					origin: string;
					idempotency_key: string;
					scheduled_for: Date;
					attempts: number;
				}[];
			}
		).rows[0];
		if (!row) return null;

		await tx.execute(sql`
			UPDATE ${outbox}
			SET status = 'reserved', reserved_at = now(), attempts = attempts + 1
			WHERE id = ${row.id}
		`);

		return {
			id: row.id,
			conversationId: row.conversation_id,
			body: row.body,
			origin: paraOrigin(row.origin),
			idempotencyKey: row.idempotency_key,
			scheduledFor: row.scheduled_for,
			attempts: row.attempts + 1,
		};
	});
};

/**
 * Marca o job como enviado e o liga à mensagem gravada.
 *
 * **Não** faz `UPDATE messages.status`. O plano original pedia
 * `UPDATE messages SET status = 'sent', provider_msg_id = $2`, mas `messages` é
 * **append-only** (R-043, `trg_messages_append_only`): um UPDATE ali levanta
 * exceção e derruba a transação inteira. A correção é gravar a mensagem já com
 * `status = 'sent'` na transação do `dispatch` (o envio já aconteceu antes do
 * INSERT; se o INSERT falhar, a transação reverte e a mensagem não é registrada).
 * Aqui só se fecha o job e se grava o vínculo `outbox.message_id`.
 *
 * `providerMsgId` não existe: `ChannelPort.sendText` devolve `void` (o
 * adaptador Baileys preenche `messages.provider_msg_id` na sua própria trilha).
 */
export const markSent = async (
	db: Db,
	id: string,
	messageId?: string,
): Promise<void> => {
	await db.execute(sql`
		UPDATE ${outbox}
		SET status = 'sent',
		    message_id = COALESCE(${messageId ?? null}, message_id),
		    reserved_at = NULL
		WHERE id = ${id}
	`);
};

/**
 * Trata uma falha de envio. `retryable` é **`false` por padrão** — o padrão é
 * não repetir um envio que falhou, porque repetir cego é exatamente o burst que
 * derruba número. Só com `retryable: true` e `attempts < maxAttempts` (3) o job
 * volta para `pending` com backoff; acima disso, ou sem retry, vai para `failed`.
 */
export const markFailed = async (
	db: Db,
	id: string,
	error: string,
	opts: MarkFailedOpts = {},
): Promise<void> => {
	const retryable = opts.retryable ?? false;
	const maxAttempts = opts.maxAttempts ?? 3;
	const backoffMs = opts.backoffMs ?? 60_000;
	const agora = opts.now ?? new Date();

	const atual = await db.execute(
		sql`SELECT attempts FROM ${outbox} WHERE id = ${id}`,
	);
	const attempts = (atual as unknown as { rows: { attempts: number }[] })
		.rows[0]?.attempts;

	if (retryable && attempts !== undefined && attempts < maxAttempts) {
		const proxima = new Date(agora.getTime() + backoffMs);
		await db.execute(sql`
			UPDATE ${outbox}
			SET status = 'pending', scheduled_for = ${proxima}, last_error = ${error}, reserved_at = NULL
			WHERE id = ${id}
		`);
		return;
	}
	await db.execute(sql`
		UPDATE ${outbox}
		SET status = 'failed', last_error = ${error}
		WHERE id = ${id}
	`);
};

/**
 * Devolve um job à fila para a próxima janela. O job continua **durável**: não
 * sai da fila e não é re-inserido — um novo `enqueue` com a mesma
 * `idempotency_key` seria um no-op e perderia o agendamento.
 */
export const markDeferred = async (
	db: Db,
	id: string,
	scheduledFor: Date,
): Promise<void> => {
	await db.execute(sql`
		UPDATE ${outbox}
		SET status = 'pending', scheduled_for = ${scheduledFor}, attempts = attempts + 1, reserved_at = NULL
		WHERE id = ${id}
	`);
};

/**
 * Abandona um job que o gate **reprovou** no dreno (opt-out, handoff, etc.). O
 * `motivo` é o `GateReason` canônico devolvido pelo `dispatch`, nunca um motivo
 * inventado pelo worker.
 */
export const abandon = async (
	db: Db,
	id: string,
	motivo: string,
): Promise<void> => {
	await db.execute(sql`
		UPDATE ${outbox}
		SET status = 'abandoned', last_error = ${motivo}
		WHERE id = ${id}
	`);
};

/**
 * Recupera jobs presos em `reserved` após um crash. Roda no boot do worker,
 * **antes** do primeiro dreno. Sem isso, um crash entre `reserveNext` e
 * `markSent` perde o follow-up R-007 em silêncio. O job volta para `pending`
 * onde **será reavaliado pelo gate** — nunca reenviado cegamente (T-01-19).
 */
export const requeueStale = async (
	db: Db,
	opts: RequeueStaleOpts = {},
): Promise<number> => {
	const olderThanMs = opts.olderThanMs ?? 5 * 60_000;
	const corte = new Date((opts.now ?? new Date()).getTime() - olderThanMs);
	const filtroConversa = opts.conversationId
		? sql`AND conversation_id = ${opts.conversationId}`
		: sql``;
	const resultado = await db.execute(sql`
		UPDATE ${outbox}
		SET status = 'pending', reserved_at = NULL
		WHERE status = 'reserved' AND reserved_at < ${corte} ${filtroConversa}
		RETURNING id
	`);
	return (resultado as unknown as { rows: unknown[] }).rows.length;
};
