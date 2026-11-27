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
const agora = new Date("2026-11-27T12:00:00.000Z");
const corte = new Date("2026-05-30T12:00:00.000Z");

describe("migração 0011 — job de retenção auditada", () => {
	let conn: OpenDb;
	let db: Db;

	beforeAll(async () => {
		conn = await openDb(env.DATABASE_URL);
		db = conn.db;
	});

	afterAll(async () => {
		await closeDb(conn);
	});

	it("destrói só o payload vencido e registra retencao_aplicada", async () => {
		try {
			await db.transaction(async (tx) => {
				const sufixo = String(Date.now() % 100000).padStart(5, "0");
				const [conta] = await tx
					.insert(schema.channelAccounts)
					.values({ phoneE164: `+55119${sufixo}001` })
					.onConflictDoNothing()
					.returning({ id: schema.channelAccounts.id });
				const [lead] = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: `+55119${sufixo}002`,
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now() - interval '400 days'`,
					})
					.returning({ id: schema.leads.id });
				if (!conta || !lead) throw new Error("fixture nao criada");

				const [vencida] = await tx
					.insert(schema.conversations)
					.values({
						leadId: lead.id,
						channelAccountId: conta.id,
						state: "encerrado",
						closedReason: "sem_resposta",
						closedAt: new Date("2026-05-01T12:00:00.000Z"),
						createdAt: new Date("2026-05-01T12:00:00.000Z"),
					})
					.returning({ id: schema.conversations.id });
				const [ativa] = await tx
					.insert(schema.conversations)
					.values({ leadId: lead.id, channelAccountId: conta.id })
					.returning({ id: schema.conversations.id });
				if (!vencida || !ativa) throw new Error("conversas nao criadas");

				const [msgVencida] = await tx
					.insert(schema.messages)
					.values({
						conversationId: vencida.id,
						direction: "out",
						origin: "bot",
						body: "CPF 123.456.789-00",
						providerMsgId: "provider-vencida",
						idempotencyKey: `retencao-vencida-${sufixo}`,
					})
					.returning({ id: schema.messages.id });
				const [msgAtiva] = await tx
					.insert(schema.messages)
					.values({
						conversationId: ativa.id,
						direction: "out",
						origin: "bot",
						body: "mensagem dentro do prazo",
						idempotencyKey: `retencao-ativa-${sufixo}`,
					})
					.returning({ id: schema.messages.id });
				if (!msgVencida || !msgAtiva) throw new Error("mensagens nao criadas");

				await tx.insert(schema.blockedAttempts).values({
					conversationId: vencida.id,
					leadId: lead.id,
					guard: "ar001",
					reasonCode: "preco",
					ruleReference: "R-012",
					excerpt: "R$ 3.500",
					detail: "detalhe sensivel",
					payloadExcerpt: "payload sensivel",
				});
				await tx.insert(schema.eventLog).values({
					eventType: "evento_antigo",
					entityType: "conversation",
					entityId: vencida.id,
					conversationId: vencida.id,
					payload: { segredo: "antigo" },
					severity: "info",
					createdAt: corte,
				});

				const resultado = await tx.execute(sql`
					select fn_aplicar_retencao(${agora}) as resultado
				`);
				const bruto = resultado.rows[0]?.resultado as Record<string, unknown>;
				expect(bruto.mensagens_eliminadas).toBeGreaterThanOrEqual(1);

				const restantes = await tx
					.select({ id: schema.messages.id })
					.from(schema.messages)
					.where(eq(schema.messages.id, msgVencida.id));
				expect(restantes).toHaveLength(0);

				const mantida = await tx.query.messages.findFirst({
					where: eq(schema.messages.id, msgAtiva.id),
				});
				expect(mantida?.body).toBe("mensagem dentro do prazo");

				const tentativa = await tx.query.blockedAttempts.findFirst({
					where: eq(schema.blockedAttempts.conversationId, vencida.id),
				});
				expect(tentativa?.excerpt).toBe("[eliminado]");
				expect(tentativa?.detail).toBeNull();
				expect(tentativa?.payloadExcerpt).toBeNull();

				const eventoAntigo = await tx
					.select({ id: schema.eventLog.id })
					.from(schema.eventLog)
					.where(eq(schema.eventLog.conversationId, vencida.id));
				expect(eventoAntigo).toHaveLength(0);

				const auditoria = await tx.query.eventLog.findFirst({
					where: eq(schema.eventLog.eventType, "retencao_aplicada"),
					orderBy: (t, { desc }) => [desc(t.createdAt)],
				});
				expect(auditoria).toBeDefined();

				let bloqueouDireto = false;
				await tx.execute(sql`savepoint delete_direto`);
				try {
					await tx.execute(sql`delete from messages where id = ${msgAtiva.id}`);
				} catch {
					bloqueouDireto = true;
				}
				await tx.execute(sql`rollback to savepoint delete_direto`);
				expect(bloqueouDireto).toBe(true);

				throw sentinel;
			});
		} catch (erro) {
			if (erro !== sentinel) throw erro;
		}
	});
});
