import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apagarTitularNaTransacao } from "../../src/application/erasure.js";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import * as schema from "../../src/infra/db/schema.js";

const sentinel = new Error("TEST_DONE");
const agora = new Date("2026-11-27T12:00:00.000Z");

describe("apagarTitular — eliminação por pedido do titular", () => {
	let conn: OpenDb;
	let db: Db;

	beforeAll(async () => {
		conn = await openDb(env.DATABASE_URL);
		db = conn.db;
	});

	afterAll(async () => {
		await closeDb(conn);
	});

	it("anonimiza, encerra a cadência e grava as duas trilhas auditáveis", async () => {
		try {
			await db.transaction(async (tx) => {
				const txDb = tx as unknown as Db;
				const sufixo = String(Date.now() % 100000).padStart(5, "0");
				const [conta] = await txDb
					.insert(schema.channelAccounts)
					.values({ phoneE164: `+55119${sufixo}001` })
					.onConflictDoNothing()
					.returning({ id: schema.channelAccounts.id });
				const [lead] = await txDb
					.insert(schema.leads)
					.values({
						phoneNumber: `+55119${sufixo}002`,
						name: "Nome Sensível",
						addressLine: "Rua Sensível, 123",
						waJid: `55119${sufixo}002@s.whatsapp.net`,
						lid: `${sufixo}@lid`,
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: agora,
					})
					.returning({ id: schema.leads.id });
				if (!conta || !lead) throw new Error("fixture nao criada");

				const [conversa] = await txDb
					.insert(schema.conversations)
					.values({ leadId: lead.id, channelAccountId: conta.id })
					.returning({ id: schema.conversations.id });
				if (!conversa) throw new Error("conversa nao criada");

				const resultado = await apagarTitularNaTransacao(
					txDb,
					{
						leadId: lead.id,
						rawContent: "titular pediu eliminacao pelo email do encarregado",
						occurredAt: new Date("2026-11-26T12:00:00.000Z"),
					},
					agora,
				);

				expect(resultado.conversasEncerradas).toBe(1);

				const atualizado = await txDb.query.leads.findFirst({
					where: eq(schema.leads.id, lead.id),
				});
				expect(atualizado?.optOut).toBe(true);
				expect(atualizado?.name).toBeNull();
				expect(atualizado?.addressLine).toBeNull();
				expect(atualizado?.waJid).toBeNull();
				expect(atualizado?.lid).toBeNull();
				expect(atualizado?.phoneNumber).toBe(`+55119${sufixo}002`);

				const fechada = await txDb.query.conversations.findFirst({
					where: eq(schema.conversations.id, conversa.id),
				});
				expect(fechada?.state).toBe("encerrado");
				expect(fechada?.closedReason).toBe("opt_out");
				expect(fechada?.closedAt).toBeInstanceOf(Date);

				const ledger = await txDb.query.optoutLedger.findFirst({
					where: eq(schema.optoutLedger.leadId, lead.id),
				});
				expect(ledger?.eventType).toBe("erasure_request");
				expect(ledger?.source).toBe("manual");
				expect(ledger?.detectedBy).toBeNull();
				expect(ledger?.legalBasis).toBe("legitimate_interest");
				expect(ledger?.purpose).toBe("prospecao_b2b_servicos_digitais");

				const auditoria = await txDb.query.eventLog.findFirst({
					where: eq(schema.eventLog.leadId, lead.id),
				});
				expect(auditoria?.eventType).toBe("erasure_request");
				expect(auditoria?.entityType).toBe("lead");

				throw sentinel;
			});
		} catch (erro) {
			if (erro !== sentinel) throw erro;
		}
	});

	it("rejeita leadId fora do formato UUID", async () => {
		await expect(
			apagarTitularNaTransacao(
				db,
				{ leadId: "nao-e-uuid", rawContent: "pedido" },
				agora,
			),
		).rejects.toThrow("leadId invalido");
	});
});
