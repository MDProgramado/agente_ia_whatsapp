/**
 * O dispatcher com texto LONGO (CONV-13) e a falha em um pedaço.
 *
 * O que estes testes provam, e por que é o coração do plano 01-05:
 *
 * 1. Um texto acima do limite vira vários `sendText` **em ordem**, cada pedaço
 *    com sua própria `idempotency_key` (`chave#n`) — sem isso a unicidade de
 *    `messages` colapsaria os pedaços numa linha só.
 * 2. A falha em um pedaço NÃO deixa os seguintes saírem: a transação reverte e o
 *    job é marcado `failed` de forma **não-retentável** (repetir cego é o burst
 *    que derruba número).
 *
 * Transação revertida (ver nota em `outbox.test.ts`): `messages` é append-only e
 * `leads` não pode ser deletado. O caso de falha usa um `outbox` REAL porque
 * `markFailed` escreve fora da transação revertida — ele é limpo no `finally`.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type DispatchDeps,
	dispatch,
} from "../../src/application/dispatcher.js";
import type { Humanizer } from "../../src/application/humanize.js";
import {
	LIMITE_WHATSAPP,
	splitLongMessage,
} from "../../src/application/humanize.js";
import { env } from "../../src/config/env.js";
import type { ChannelPort } from "../../src/domain/ports/ChannelPort.js";
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

const DENTRO_DA_JANELA = instanteEmZona(TZ, 2026, 9, 29, 13, 0);
const TEXTO_LONGO = "palavra ".repeat(400).trimEnd();

/** Humanizador que não espera: o que está sob teste é a orquestração, não o relógio. */
const HUMANO_RAPIDO: Humanizer = {
	delay: async () => {},
	typing: async () => {},
};

const CTX: DispatchDeps["ctx"] = {
	tz: env.TZ,
	windowStartHour: env.WINDOW_START_HOUR,
	windowEndHour: env.WINDOW_END_HOUR,
	dailyMessageLimit: env.DAILY_MESSAGE_LIMIT,
	dailyMessageCap: 30,
};

const SENTINELA = "rollback-intencional-do-teste";

const rows = <T>(resultado: unknown): T[] => (resultado as { rows: T[] }).rows;

const primeiro = <T>(lista: readonly T[]): T => {
	const [item] = lista;
	if (item === undefined) throw new Error("esperava ao menos uma linha");
	return item;
};

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
		VALUES (${env.CHANNEL_PHONE_E164}, 'teste-chunks')
		ON CONFLICT (phone_e164) DO NOTHING
	`);
	const r = await db.execute(sql`
		SELECT id FROM channel_accounts WHERE phone_e164 = ${env.CHANNEL_PHONE_E164}
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

const inserirLead = async (db: Db, telefone: string): Promise<string> => {
	// `first_contact_by_human = true` (o Admin já falou): o gate LIBERA o envio.
	const r = await db.execute(sql`
		INSERT INTO leads (
			phone_number, origin_source, legal_basis, purpose,
			legal_registered_at, first_contact_by_human, wa_validation_state
		)
		VALUES (
			${telefone}, 'teste', 'legitimo_interesse', 'prospeccao',
			'2025-01-01T12:00:00Z', true, 'VALIDO'
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

describe("dispatch — texto longo vira varios pedacos (CONV-13)", () => {
	it("envia N pedacos em ordem, com idempotency_key distinta por pedaco", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, `+55${Date.now() % 10_000_000_000}`);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const enviados: EnvioFake[] = [];
			const channel = criarFakeChannel(new Map(), enviados);
			const chave = `longo-${randomUUID()}`;

			const r = await dispatch(
				{ db: tx, channel, ctx: CTX, humanizer: HUMANO_RAPIDO },
				{
					conversationId: conversaId,
					text: TEXTO_LONGO,
					now: DENTRO_DA_JANELA,
					idempotencyKey: chave,
				},
			);
			expect(r.action).toBe("sent");

			const esperados = splitLongMessage(TEXTO_LONGO);
			expect(esperados.length).toBeGreaterThan(1);
			expect(enviados.map((e) => e.text)).toEqual(esperados);
			expect(enviados.every((e) => e.text.length <= LIMITE_WHATSAPP)).toBe(
				true,
			);
			expect(new Set(enviados.map((e) => e.idempotencyKey)).size).toBe(
				esperados.length,
			);

			const gravadas = rows<{ idempotency_key: string }>(
				await tx.execute(sql`
					SELECT idempotency_key FROM messages
					WHERE conversation_id = ${conversaId}
					ORDER BY created_at, idempotency_key
				`),
			);
			expect(gravadas).toHaveLength(esperados.length);
		});
	});
});

describe("dispatch — falha em um pedaco (R-067)", () => {
	it("nao envia os pedacos seguintes e marca o job como failed (nao-retentavel)", async () => {
		const contaId = await inserirConta(db);
		// Lead ESTÁVEL (não pode ser deletado): reaproveitado entre execuções.
		await db.execute(sql`
			INSERT INTO leads (
				phone_number, origin_source, legal_basis, purpose,
				legal_registered_at, first_contact_by_human, wa_validation_state
			)
			VALUES (
				'+5511000000001', 'teste', 'legitimo_interesse', 'prospeccao',
				'2025-01-01T12:00:00Z', true, 'VALIDO'
			)
			ON CONFLICT (phone_number) DO NOTHING
		`);
		const leadId = primeiro(
			rows<{ id: string }>(
				await db.execute(
					sql`SELECT id FROM leads WHERE phone_number = '+5511000000001'`,
				),
			),
		).id;
		const conversaId = await inserirConversa(db, leadId, contaId);
		const chave = `falha-${randomUUID()}`;

		const job = await db.execute(sql`
			INSERT INTO outbox (conversation_id, origin, body, idempotency_key, scheduled_for)
			VALUES (${conversaId}, 'bot', ${TEXTO_LONGO}, ${chave}, ${DENTRO_DA_JANELA})
			RETURNING id
		`);
		const jobId = primeiro(rows<{ id: string }>(job)).id;

		try {
			const base = criarFakeChannel();
			let chamadas = 0;
			const channel: ChannelPort = {
				sendText: async (cid, texto, key) => {
					chamadas += 1;
					// O 2º pedaço explode: meia mensagem não existe.
					if (chamadas === 2) throw new Error("whatsapp offline");
					await base.sendText(cid, texto, key);
				},
				readQuota: (d) => base.readQuota(d),
				markNumberInvalid: (p, r) => base.markNumberInvalid(p, r),
			};

			const r = await dispatch(
				{ db, channel, ctx: CTX, humanizer: HUMANO_RAPIDO },
				{
					conversationId: conversaId,
					text: TEXTO_LONGO,
					now: DENTRO_DA_JANELA,
					idempotencyKey: chave,
					origin: "bot",
					outboxJobId: jobId,
				},
			);
			expect(r.action).toBe("silencio");
			// Só o 1º pedaço tentou sair; o 2º falhou e o 3º nunca rodou.
			expect(chamadas).toBe(2);

			const obs = rows<{ status: string; last_error: string | null }>(
				await db.execute(
					sql`SELECT status, last_error FROM outbox WHERE id = ${jobId}`,
				),
			);
			expect(primeiro(obs).status).toBe("failed");
			expect(primeiro(obs).last_error).toContain("whatsapp offline");

			const gravadas = rows<{ id: string }>(
				await db.execute(
					sql`SELECT id FROM messages WHERE conversation_id = ${conversaId}`,
				),
			);
			// Transação revertida: NENHUM pedaço ficou gravado.
			expect(gravadas).toHaveLength(0);
		} finally {
			await db.execute(sql`DELETE FROM outbox WHERE id = ${jobId}`);
			await db.execute(sql`DELETE FROM conversations WHERE id = ${conversaId}`);
		}
	});
});
