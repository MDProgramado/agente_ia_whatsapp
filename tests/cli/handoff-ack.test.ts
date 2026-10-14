/**
 * Confirmação humana de handoff (02-03 Task 1, D-15).
 *
 * O que este teste prova, e por que ele existe:
 *
 * 1. `handoff:ack <id>` grava `handoff_events.human_acknowledged_at` e UM evento
 *    append-only `handoff_acknowledged` em `event_log`.
 * 2. Idempotente: um segundo ack NÃO reescreve o instante nem duplica o evento.
 * 3. O ack NÃO reativa o bot — `conversations.engagement_mode` fica intacto.
 * 4. Um id inexistente devolve 1; um id malformado devolve 2 (uso).
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runHandoffCli } from "../../src/cli/handoff.js";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";

const SENTINELA = "rollback-intencional-do-teste";

let conn: OpenDb;
let db: Db;

beforeAll(async () => {
	conn = await openDb(env.DATABASE_URL);
	db = conn.db;
});

afterAll(async () => {
	await closeDb(conn);
});

const rows = <T>(resultado: unknown): T[] => (resultado as { rows: T[] }).rows;

const primeiro = <T>(lista: readonly T[]): T => {
	const item = lista[0];
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

const capturar = (): {
	escrever: (linha: string) => void;
	linhas: string[];
} => {
	const linhas: string[] = [];
	return { escrever: (linha: string) => linhas.push(linha), linhas };
};

let seq = 0;
const telefone = (): string => {
	seq += 1;
	return `+55119${String(Date.now() % 100000).padStart(5, "0")}${String(seq).padStart(3, "0")}`;
};

interface Fx {
	readonly conversationId: string;
	readonly handoffId: string;
}

const semearHandoff = async (tx: Db): Promise<Fx> => {
	await tx.execute(sql`
		insert into channel_accounts (phone_e164)
		values (${env.CHANNEL_PHONE_E164})
		on conflict (phone_e164) do nothing
	`);
	const conta = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				select id from channel_accounts where phone_e164 = ${env.CHANNEL_PHONE_E164}
			`),
		),
	);
	const lead = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into leads (
					phone_number, origin_source, legal_basis, purpose,
					legal_registered_at, first_contact_by_human, opt_out
				)
				values (
					${telefone()}, 'teste', 'legitimate_interest', 'prospeccao',
					'2025-01-01T12:00:00Z', true, false
				)
				returning id
			`),
		),
	);
	const conversa = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into conversations (lead_id, channel_account_id, state, engagement_mode)
				values (${lead.id}, ${conta.id}, 'awaiting_human', 'awaiting_human')
				returning id
			`),
		),
	);
	const handoff = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into handoff_events (
					conversation_id, lead_id, channel_account_id, triggered_by,
					excerpt, simultaneous_send_blocked, bot_stopped_at
				)
				values (
					${conversa.id}, ${lead.id}, ${conta.id}, 'intent',
					'lead perguntou preco', true, now()
				)
				returning id
			`),
		),
	);
	return { conversationId: conversa.id, handoffId: handoff.id };
};

const ackDe = async (tx: Db, handoffId: string): Promise<string | null> => {
	const r = await tx.execute(sql`
		select human_acknowledged_at from handoff_events where id = ${handoffId}
	`);
	return (
		rows<{ human_acknowledged_at: string | null }>(r)[0]
			?.human_acknowledged_at ?? null
	);
};

const contarEventosAck = async (tx: Db, handoffId: string): Promise<number> => {
	const r = await tx.execute(sql`
		select count(*)::int as n from event_log
		where event_type = 'handoff_acknowledged' and entity_id = ${handoffId}
	`);
	return primeiro(rows<{ n: number }>(r)).n;
};

const engagementModeDe = async (
	tx: Db,
	conversaId: string,
): Promise<string> => {
	const r = await tx.execute(sql`
		select engagement_mode from conversations where id = ${conversaId}
	`);
	return primeiro(rows<{ engagement_mode: string }>(r)).engagement_mode;
};

describe("handoff:ack — confirmação humana (02-03 Task 1, D-15)", () => {
	it("grava human_acknowledged_at e UM evento append-only", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semearHandoff(tx);
			expect(await ackDe(tx, fx.handoffId)).toBeNull();

			const { escrever } = capturar();
			const codigo = await runHandoffCli(tx, ["ack", fx.handoffId], escrever);
			expect(codigo).toBe(0);

			const quando = await ackDe(tx, fx.handoffId);
			expect(quando).not.toBeNull();
			expect(await contarEventosAck(tx, fx.handoffId)).toBe(1);
		});
	});

	it("idempotente: segundo ack não reescreve o instante nem duplica o evento", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semearHandoff(tx);
			const { escrever } = capturar();

			await runHandoffCli(tx, ["ack", fx.handoffId], escrever);
			const primeiroAck = await ackDe(tx, fx.handoffId);

			const codigo2 = await runHandoffCli(tx, ["ack", fx.handoffId], escrever);
			expect(codigo2).toBe(0);
			const segundoAck = await ackDe(tx, fx.handoffId);

			expect(segundoAck).toBe(primeiroAck);
			expect(await contarEventosAck(tx, fx.handoffId)).toBe(1);
		});
	});

	it("não reativa o bot (engagement_mode intacto)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semearHandoff(tx);
			const { escrever } = capturar();

			await runHandoffCli(tx, ["ack", fx.handoffId], escrever);
			expect(await engagementModeDe(tx, fx.conversationId)).toBe(
				"awaiting_human",
			);
		});
	});

	it("handoff inexistente devolve 1", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { escrever } = capturar();
			const codigo = await runHandoffCli(tx, ["ack", randomUUID()], escrever);
			expect(codigo).toBe(1);
		});
	});

	it("id malformado devolve 2 (erro de uso)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { escrever } = capturar();
			const codigo = await runHandoffCli(tx, ["ack", "nao-e-uuid"], escrever);
			expect(codigo).toBe(2);
		});
	});
});
