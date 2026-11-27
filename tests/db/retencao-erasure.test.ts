import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import * as schema from "../../src/infra/db/schema.js";

const sentinel = new Error("TEST_DONE");

describe("migração 0010 — closed_at para retenção/eliminação LGPD", () => {
	let conn: OpenDb;
	let db: Db;

	beforeAll(async () => {
		conn = await openDb(env.DATABASE_URL);
		db = conn.db;
	});

	afterAll(async () => {
		await closeDb(conn);
	});

	it("grava closed_at no instante em que a conversa entra em encerrado", async () => {
		try {
			await db.transaction(async (tx) => {
				const sufixo = String(Date.now() % 100000).padStart(5, "0");
				const fone = `+55119${sufixo}001`;
				await tx
					.insert(schema.channelAccounts)
					.values({ phoneE164: fone })
					.onConflictDoNothing();
				const conta = await tx.query.channelAccounts.findFirst({
					where: eq(schema.channelAccounts.phoneE164, fone),
				});
				const [lead] = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: `+55119${sufixo}002`,
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now() - interval '1 day'`,
					})
					.returning({ id: schema.leads.id });
				if (!conta || !lead) throw new Error("fixture nao criada");
				const [conv] = await tx
					.insert(schema.conversations)
					.values({ leadId: lead.id, channelAccountId: conta.id })
					.returning({ id: schema.conversations.id });
				if (!conv) throw new Error("conversa nao criada");

				const antes = await tx.query.conversations.findFirst({
					where: eq(schema.conversations.id, conv.id),
				});
				expect(antes?.closedAt).toBeNull();

				await tx.execute(sql`
					UPDATE conversations
					SET state = 'encerrado', closed_reason = 'sem_resposta'
					WHERE id = ${conv.id}
				`);
				const depois = await tx.query.conversations.findFirst({
					where: eq(schema.conversations.id, conv.id),
				});
				expect(depois?.closedAt).toBeInstanceOf(Date);

				throw sentinel;
			});
		} catch (erro) {
			if (erro !== sentinel) throw erro;
		}
	});
});
