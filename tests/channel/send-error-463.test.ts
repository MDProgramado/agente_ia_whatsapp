import { randomInt, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	BaileysChannel,
	type SocketDoCanal,
} from "../../src/channel/baileys/adapter.js";
import { translateSendError } from "../../src/channel/baileys/signals.js";
import { env } from "../../src/config/env.js";
import type {
	NotifyInput,
	NotifyPort,
} from "../../src/domain/ports/NotifyPort.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";

const SENTINELA = "rollback-intencional-do-teste";
const ERRO_463 = Object.assign(new Error("status 463"), {
	output: { statusCode: 463 },
});

const rows = <T>(resultado: unknown): T[] => (resultado as { rows: T[] }).rows;

const primeiro = <T>(lista: readonly T[]): T => {
	const [item] = lista;
	if (item === undefined) throw new Error("esperava ao menos uma linha");
	return item;
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

const emTransacaoRevertida = async (
	fn: (tx: Db) => Promise<void>,
): Promise<void> => {
	try {
		await db.transaction(async (txBruto) => {
			await fn(txBruto as unknown as Db);
			throw new Error(SENTINELA);
		});
	} catch (erro) {
		if (!(erro instanceof Error) || erro.message !== SENTINELA) throw erro;
	}
};

describe("erro 463 do Baileys rc14", () => {
	it("classifica como restricao de conta, nao como numero invalido", () => {
		const sinal = translateSendError(ERRO_463);
		expect(sinal.retry).toBe(false);
		expect(sinal.reason).toBe("account_restricted");
	});

	it("notifica a restricao sem marcar o lead como NUMERO_INVALIDO", async () => {
		await emTransacaoRevertida(async (tx) => {
			await tx.execute(sql`
				INSERT INTO channel_accounts (phone_e164, display_name)
				VALUES (${env.CHANNEL_PHONE_E164}, 'teste-463')
				ON CONFLICT (phone_e164) DO NOTHING
			`);
			const conta = rows<{ id: string }>(
				await tx.execute(sql`
					SELECT id FROM channel_accounts
					WHERE phone_e164 = ${env.CHANNEL_PHONE_E164}
				`),
			);
			const telefone = `+55119${randomInt(1_000_000, 9_999_999)}`;
			const lead = rows<{ id: string }>(
				await tx.execute(sql`
					INSERT INTO leads (
						phone_number, origin_source, legal_basis, purpose,
						legal_registered_at, first_contact_by_human, wa_validation_state
					)
					VALUES (
						${telefone}, 'teste', 'legitimo_interesse', 'prospeccao',
						'2025-01-01T12:00:00Z', true, 'VALIDO'
					)
					RETURNING id
				`),
			);
			const conversa = rows<{ id: string }>(
				await tx.execute(sql`
					INSERT INTO conversations (lead_id, channel_account_id, state, engagement_mode)
					VALUES (${primeiro(lead).id}, ${primeiro(conta).id}, 'novo', 'bot_active')
					RETURNING id
				`),
			);

			let tentativas = 0;
			const sock = {
				sendMessage: async () => {
					tentativas += 1;
					throw ERRO_463;
				},
				sendPresenceUpdate: async () => {},
				fetchNewChatMessageCap: async () => null,
				fetchAccountReachoutTimelock: async () => ({ isActive: true }),
			} as unknown as SocketDoCanal;
			const notificacoes: NotifyInput[] = [];
			const notifier: NotifyPort = {
				notify: async (input) => {
					notificacoes.push(input);
				},
			};
			const canal = new BaileysChannel({ db: tx, sock, notifier });

			await expect(
				canal.sendText(
					primeiro(conversa).id,
					"mensagem",
					`463-${randomUUID()}`,
				),
			).rejects.toThrow("status 463");

			expect(tentativas).toBe(1);
			expect(notificacoes[0]?.title).toContain("Restricao de conta");
			const estado = rows<{ wa_validation_state: string }>(
				await tx.execute(sql`
					SELECT wa_validation_state FROM leads WHERE id = ${primeiro(lead).id}
				`),
			);
			expect(primeiro(estado).wa_validation_state).toBe("VALIDO");
		});
	});
});
