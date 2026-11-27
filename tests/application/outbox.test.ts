/**
 * O outbox durável e o dreno que **reavalia** o gate.
 *
 * ## Por que os testes de caminho feliz usam transação revertida
 *
 * `messages` é append-only (R-043) e `leads` não pode ser deletado
 * (`trg_leads_no_cascade`): não existe forma de limpar o banco depois. Por isso
 * os casos de envio/opt-out/deferimento rodam dentro de uma transação que
 * termina em `rollback` — o que importa é o **estado dentro da transação**, e o
 * banco de desenvolvimento não acumula cota nem histórico.
 *
 * O único caso que **commita** é o de concorrência: provar `FOR UPDATE SKIP
 * LOCKED` exige duas conexões enxergando a mesma linha, e isso é impossível
 * dentro de uma transação não comitada. Ele usa um lead estável (reaproveitado)
 * e limpa o `outbox`/`conversations` no `finally`.
 */
import { randomInt, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	enqueue,
	type OutboxJob,
	requeueStale,
	reserveNext,
} from "../../src/application/outbox.js";
import { drainOnce } from "../../src/application/outbox-worker.js";
import { env } from "../../src/config/env.js";
import { nextWindow } from "../../src/domain/business-hours.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import {
	criarFakeChannel,
	type EnvioFake,
} from "../../src/infra/fake-channel.js";
import { instanteEmZona, TZ } from "../gate/fixtures.js";

/** Terça 29/09/2026 13h SP — dentro da janela. */
const DENTRO_DA_JANELA = instanteEmZona(TZ, 2026, 9, 29, 13, 0);
/** Terça 29/09/2026 18h SP — dia útil, mas fora da janela. */
const FORA_DA_JANELA = instanteEmZona(TZ, 2026, 9, 29, 18, 0);

/** Telefone de fixture: nunca o número real do Admin (R-064). */
const telefoneAleatorio = (): string =>
	`+55${randomInt(10_000_000_000, 99_999_999_999)}`;

const chaveDia = (d: Date): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(d);

const CTX = {
	tz: env.TZ,
	windowStartHour: env.WINDOW_START_HOUR,
	windowEndHour: env.WINDOW_END_HOUR,
	dailyMessageLimit: env.DAILY_MESSAGE_LIMIT,
	dailyMessageCap: 30,
};

const SENTINELA = "rollback-intencional-do-teste";

const rows = <T>(resultado: unknown): T[] => (resultado as { rows: T[] }).rows;

/** A primeira linha, com erro explícito se o SELECT voltou vazio. */
const primeiro = <T>(lista: readonly T[]): T => {
	const [item] = lista;
	if (item === undefined) throw new Error("esperava ao menos uma linha");
	return item;
};

/**
 * `db.execute` cru devolve TIMESTAMP como string ingênua (`2026-09-30 10:00:00`)
 * — o Drizzle sobrescreve o parser de data. Compare SEMPRE em texto (via
 * `::text`), nunca re-ancorando a string: o servidor está em `America/Sao_Paulo`
 * e o round-trip de um `timestamp` sem fuso desloca 3 h.
 */

/** Abre a transação, roda o corpo e **sempre** reverte. */
const emTransacaoRevertida = async (
	fn: (tx: Db) => Promise<void>,
): Promise<void> => {
	try {
		await db.transaction(async (tx) => {
			await fn(tx as unknown as Db);
			throw new Error(SENTINELA);
		});
	} catch (erro) {
		if (!(erro instanceof Error) || erro.message !== SENTINELA) throw erro;
	}
};

const inserirConta = async (db: Db): Promise<string> => {
	await db.execute(sql`
		INSERT INTO channel_accounts (phone_e164, display_name)
		VALUES (${env.CHANNEL_PHONE_E164}, 'teste-outbox')
		ON CONFLICT (phone_e164) DO NOTHING
	`);
	const r = await db.execute(sql`
		SELECT id FROM channel_accounts WHERE phone_e164 = ${env.CHANNEL_PHONE_E164}
	`);
	const id = rows<{ id: string }>(r)[0]?.id;
	if (!id) throw new Error("conta de teste nao encontrada");
	return id;
};

const inserirLead = async (
	db: Db,
	telefone: string,
	optOut: boolean,
): Promise<string> => {
	// `legal_registered_at` no passado FIXO: um `now()` (2026-10) cairia no
	// futuro em relação ao instante do teste (2026-09) e o AR-011 bloquearia.
	const r = await db.execute(sql`
		INSERT INTO leads (
			phone_number, origin_source, legal_basis, purpose,
			legal_registered_at, first_contact_by_human, wa_validation_state, opt_out
		)
		VALUES (
			${telefone}, 'teste', 'legitimo_interesse', 'prospeccao',
			'2025-01-01T12:00:00Z', true, 'VALIDO', ${optOut}
		)
		RETURNING id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

const inserirConversa = async (
	db: Db,
	leadId: string,
	contaId: string,
): Promise<string> => {
	// `state='novo'` e `engagement_mode='bot_active'`: o CHECK de `state` NÃO
	// aceita 'bot_active' (só o de `engagement_mode` aceita) — passar 'bot_active'
	// nos dois viola `conversations_state_check`.
	const r = await db.execute(sql`
		INSERT INTO conversations (lead_id, channel_account_id, state, engagement_mode)
		VALUES (${leadId}, ${contaId}, 'novo', 'bot_active')
		RETURNING id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

let conn: OpenDb;
let db: Db;

beforeAll(async () => {
	conn = await openDb(env.DATABASE_URL);
	db = conn.db;
});

afterAll(async () => {
	await closeDb(conn);
});

const deps = (
	channel: ReturnType<typeof criarFakeChannel>,
	now: Date,
): Parameters<typeof drainOnce>[1] => ({ channel, ctx: CTX, now });

describe("reserveNext — SKIP LOCKED (T-01-16)", () => {
	it("dois workers em paralelo sobre 1 job: exatamente um leva", async () => {
		const contaId = await inserirConta(db);
		// Lead ESTÁVEL: reaproveitado entre execuções (leads não podem ser
		// deletados). A conversa e o job são novos a cada rodada.
		await db.execute(sql`
			INSERT INTO leads (phone_number, origin_source, legal_basis, purpose, legal_registered_at)
			VALUES ('+5511000000000', 'teste', 'legitimo_interesse', 'prospeccao', '2025-01-01T12:00:00Z')
			ON CONFLICT (phone_number) DO NOTHING
		`);
		const leadId = primeiro(
			rows<{ id: string }>(
				await db.execute(sql`
					SELECT id FROM leads WHERE phone_number = '+5511000000000'
				`),
			),
		).id;
		const conversaId = await inserirConversa(db, leadId, contaId);
		const chave = `concorrencia-${randomUUID()}`;
		const agora = new Date();
		await enqueue(db, {
			conversationId: conversaId,
			origin: "bot",
			body: "mensagem concorrente",
			idempotencyKey: chave,
			scheduledFor: new Date(agora.getTime() - 1_000),
		});

		try {
			const [a, b] = await Promise.all([
				reserveNext(db, { now: agora, conversationId: conversaId }),
				reserveNext(db, { now: agora, conversationId: conversaId }),
			]);
			const reservados = [a, b].filter((j): j is OutboxJob => j !== null);
			expect(reservados).toHaveLength(1);
			expect(reservados[0]?.idempotencyKey).toBe(chave);
		} finally {
			await db.execute(
				sql`DELETE FROM outbox WHERE idempotency_key = ${chave}`,
			);
			await db.execute(sql`DELETE FROM conversations WHERE id = ${conversaId}`);
		}
	});
});

describe("sending — janela de envio sem retry automático", () => {
	it("job em sending não é recuperado por requeueStale", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneAleatorio(), false);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const chave = `sending-${randomUUID()}`;
			const id = await enqueue(tx, {
				conversationId: conversaId,
				origin: "followup",
				body: "mensagem em envio",
				idempotencyKey: chave,
				scheduledFor: DENTRO_DA_JANELA,
			});
			if (!id) throw new Error("enqueue nao devolveu id");

			await tx.execute(
				sql`UPDATE outbox SET status = 'sending', reserved_at = now() WHERE id = ${id}`,
			);
			const recuperados = await requeueStale(tx, {
				olderThanMs: 0,
				now: new Date(Date.now() + 10 * 60_000),
				conversationId: conversaId,
			});

			expect(recuperados).toBe(0);
			const status = primeiro(
				rows<{ status: string }>(
					await tx.execute(sql`SELECT status FROM outbox WHERE id = ${id}`),
				),
			);
			expect(status.status).toBe("sending");
		});
	});
});

describe("drainOnce — caminho feliz (cota no envio, R-023)", () => {
	it("job dentro da janela → envia, messages=sent, outbox=sent, cota=1", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneAleatorio(), false);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const chave = `feliz-${randomUUID()}`;
			const enviados: EnvioFake[] = [];
			const channel = criarFakeChannel(new Map(), enviados);
			await enqueue(tx, {
				conversationId: conversaId,
				origin: "bot",
				body: "Boa tarde! Tudo bem?",
				idempotencyKey: chave,
				scheduledFor: DENTRO_DA_JANELA,
			});

			const resultado = await drainOnce(tx, deps(channel, DENTRO_DA_JANELA), {
				conversationId: conversaId,
			});
			expect(resultado).toEqual({
				drained: 1,
				sent: 1,
				blocked: 0,
				deferred: 0,
			});
			expect(enviados).toHaveLength(1);
			expect(enviados[0]?.text).toBe("Boa tarde! Tudo bem?");

			const msgs = rows<{ status: string }>(
				await tx.execute(
					sql`SELECT status FROM messages WHERE idempotency_key = ${chave}`,
				),
			);
			expect(msgs).toHaveLength(1);
			expect(primeiro(msgs).status).toBe("sent");

			const obs = rows<{ status: string }>(
				await tx.execute(
					sql`SELECT status FROM outbox WHERE idempotency_key = ${chave}`,
				),
			);
			expect(primeiro(obs).status).toBe("sent");

			const contador = rows<{ count: number }>(
				await tx.execute(sql`
					SELECT count FROM daily_counters
					WHERE day = ${chaveDia(DENTRO_DA_JANELA)} AND kind = 'sent'
				`),
			);
			expect(contador[0]?.count).toBe(1);
		});
	});
});

describe("drainOnce — reavaliação do gate (T-01-21)", () => {
	it("opt-out gravado antes do dreno → blocked, abandoned, zero sendText", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneAleatorio(), true);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const chave = `optout-${randomUUID()}`;
			const enviados: EnvioFake[] = [];
			const channel = criarFakeChannel(new Map(), enviados);
			await enqueue(tx, {
				conversationId: conversaId,
				origin: "followup",
				body: "Posso ajudar com mais alguma coisa?",
				idempotencyKey: chave,
				scheduledFor: DENTRO_DA_JANELA,
			});

			const resultado = await drainOnce(tx, deps(channel, DENTRO_DA_JANELA), {
				conversationId: conversaId,
			});
			expect(resultado).toEqual({
				drained: 1,
				sent: 0,
				blocked: 1,
				deferred: 0,
			});
			expect(enviados).toHaveLength(0);

			const obs = rows<{ status: string; last_error: string | null }>(
				await tx.execute(
					sql`SELECT status, last_error FROM outbox WHERE idempotency_key = ${chave}`,
				),
			);
			expect(primeiro(obs).status).toBe("abandoned");
			expect(primeiro(obs).last_error).toBe("ar005_opt_out");
		});
	});
});

describe("drainOnce — deferimento (janela)", () => {
	it("fora da janela → deferred, outbox volta a pending na próxima janela", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneAleatorio(), false);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const chave = `deferido-${randomUUID()}`;
			const enviados: EnvioFake[] = [];
			const channel = criarFakeChannel(new Map(), enviados);
			await enqueue(tx, {
				conversationId: conversaId,
				origin: "followup",
				body: "Passando para retomar nosso contato",
				idempotencyKey: chave,
				scheduledFor: FORA_DA_JANELA,
			});

			const resultado = await drainOnce(tx, deps(channel, FORA_DA_JANELA), {
				conversationId: conversaId,
			});
			expect(resultado).toEqual({
				drained: 1,
				sent: 0,
				blocked: 0,
				deferred: 1,
			});
			expect(enviados).toHaveLength(0);

			const esperado = nextWindow(
				FORA_DA_JANELA,
				CTX.tz,
				CTX.windowStartHour,
				CTX.windowEndHour,
			);
			const obs = rows<{ status: string; scheduled_for: string }>(
				await tx.execute(
					sql`SELECT status, scheduled_for FROM outbox WHERE idempotency_key = ${chave}`,
				),
			);
			expect(primeiro(obs).status).toBe("pending");
			// Compara o TEXTO gravado com o que o MESMO driver+servidor gravariam
			// para `esperado`. `outbox.scheduled_for` é `timestamp` SEM fuso: um
			// `esperado.toISOString()` cru daria 3 h de diferença (o servidor converte
			// para o fuso da sessão). O cast `::timestamp::text` paga o mesmo caminho
			// de serialização, então a comparação é imune ao fuso.
			const esperadoGravado = primeiro(
				rows<{ texto: string }>(
					await tx.execute(sql`SELECT ${esperado}::timestamp::text AS texto`),
				),
			).texto;
			expect(primeiro(obs).scheduled_for).toBe(esperadoGravado);
		});
	});
});

describe("requeueStale (T-01-19)", () => {
	it("job preso em reserved volta para pending", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneAleatorio(), false);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const chave = `preso-${randomUUID()}`;
			// Relógio REAL: `reserveNext` grava `reserved_at = now()` (o relógio do
			// banco, ~2026-10), então o `cutoff` do `requeueStale` precisa estar no
			// mesmo referencial — uma data fixa de 2026-09 nunca casaria.
			const agoraBase = new Date();
			await enqueue(tx, {
				conversationId: conversaId,
				origin: "catchup",
				body: "job que travou",
				idempotencyKey: chave,
				scheduledFor: new Date(agoraBase.getTime() - 1_000),
			});
			const reservado = await reserveNext(tx, {
				now: agoraBase,
				conversationId: conversaId,
			});
			expect(reservado?.idempotencyKey).toBe(chave);

			const recuperados = await requeueStale(tx, {
				now: new Date(agoraBase.getTime() + 5_000),
				olderThanMs: 0,
				conversationId: conversaId,
			});
			expect(recuperados).toBe(1);
			const obs = rows<{ status: string }>(
				await tx.execute(
					sql`SELECT status FROM outbox WHERE idempotency_key = ${chave}`,
				),
			);
			expect(primeiro(obs).status).toBe("pending");
		});
	});
});
