/**
 * Reavaliação do gate no dreno (T-01-21) — versão **estrita**.
 *
 * O `outbox.test.ts` cobre o opt-out gravado **antes** do enfileiramento. Aqui a
 * sequência é a que realmente importa para o R-007/R-024: o job nasce válido, o
 * gate aprovaria o envio, e **depois** o lead pede opt-out. O dreno tem de
 * reavaliar com o estado fresco e barrar — o follow-up não pode sair porque
 * "quando foi agendado, podia".
 *
 * Prova em três passos:
 *   1. monta o snapshot e roda `evaluatePolicy` → `send` (prova que sem a
 *      mudança o envio sairia);
 *   2. `UPDATE leads SET opt_out = true` (false → true é a direção permitida);
 *   3. `drainOnce` → bloqueado, `sendText` nunca chamado, job abandonado com o
 *      motivo canônico.
 *
 * Transação revertida (ver `outbox.test.ts`): nada aqui pode commitar.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueue } from "../../src/application/outbox.js";
import { drainOnce } from "../../src/application/outbox-worker.js";
import { env } from "../../src/config/env.js";
import { evaluatePolicy } from "../../src/domain/gate/index.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import { loadGateSnapshot } from "../../src/infra/db/queries/snapshot.js";
import {
	criarFakeChannel,
	type EnvioFake,
} from "../../src/infra/fake-channel.js";
import { instanteEmZona, TZ } from "../gate/fixtures.js";

/** Terça 29/09/2026 13h SP — dentro da janela. */
const DENTRO_DA_JANELA = instanteEmZona(TZ, 2026, 9, 29, 13, 0);

/** Texto neutro: nenhum guard de conteúdo dispara. */
const CORPO = "Passando para retomar nosso contato";

const CTX = {
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
		VALUES (${env.CHANNEL_PHONE_E164}, 'teste-revalidacao')
		ON CONFLICT (phone_e164) DO NOTHING
	`);
	const r = await db.execute(sql`
		SELECT id FROM channel_accounts WHERE phone_e164 = ${env.CHANNEL_PHONE_E164}
	`);
	const id = rows<{ id: string }>(r)[0]?.id;
	if (!id) throw new Error("conta de teste nao encontrada");
	return id;
};

const inserirLead = async (db: Db): Promise<string> => {
	const r = await db.execute(sql`
		INSERT INTO leads (
			phone_number, origin_source, legal_basis, purpose,
			legal_registered_at, first_contact_by_human, wa_validation_state, opt_out
		)
		VALUES (
			${`+55${Date.now() % 10_000_000_000}`}, 'teste', 'legitimo_interesse', 'prospeccao',
			'2025-01-01T12:00:00Z', true, 'VALIDO', false
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

describe("drainOnce — reavaliação estrita (opt-out após enfileirar)", () => {
	it("job válido no enqueue vira bloqueado quando o opt-out chega antes do dreno", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const chave = `reval-${randomUUID()}`;
			const enviados: EnvioFake[] = [];
			const channel = criarFakeChannel(new Map(), enviados);

			await enqueue(tx, {
				conversationId: conversaId,
				origin: "followup",
				body: CORPO,
				idempotencyKey: chave,
				scheduledFor: DENTRO_DA_JANELA,
			});

			// PASSO 1: com o estado atual, o gate aprovaria — prova que o bloqueio do
			// dreno vem da reavaliação, não de um input já inválido.
			const snapshot = await loadGateSnapshot(
				tx,
				conversaId,
				DENTRO_DA_JANELA,
				{ ...CTX, sentToday: 0, newContactsToday: 0 },
			);
			if (!snapshot)
				throw new Error("snapshot ausente para a conversa de teste");
			const antes = evaluatePolicy({
				...snapshot,
				outbound: { text: CORPO, parts: [{ kind: "text" }] },
			});
			expect(antes.action).toBe("send");

			// PASSO 2: o opt-out chega depois do enfileiramento.
			await tx.execute(
				sql`UPDATE leads SET opt_out = true WHERE id = ${leadId}`,
			);

			// PASSO 3: o dreno reavalia e barra.
			const resultado = await drainOnce(
				tx,
				{ channel, ctx: CTX, now: DENTRO_DA_JANELA },
				{ conversationId: conversaId },
			);
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
