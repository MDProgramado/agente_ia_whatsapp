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

describe("migração 0013 — política 90/180 dias", () => {
	let conn: OpenDb;
	let db: Db;

	beforeAll(async () => {
		conn = await openDb(env.DATABASE_URL);
		db = conn.db;
	});

	afterAll(async () => {
		await closeDb(conn);
	});

	it("anonimiza lead de 90 dias e preserva leads dentro do prazo", async () => {
		try {
			await db.transaction(async (txBruto) => {
				const tx = txBruto as unknown as Db;
				const sufixo = String(Date.now() % 100000).padStart(5, "0");
				const [antigo] = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: `+55119${sufixo}901`,
						waJid: `55119${sufixo}901@s.whatsapp.net`,
						lid: `55119${sufixo}901@lid`,
						name: "Nome Sensível",
						addressLine: "Rua Sensível, 123",
						originSource: "cacaleads",
						purpose: "prospeccao_b2b_servicos_digitais",
						legalRegisteredAt: new Date(
							agora.getTime() - 95 * 24 * 60 * 60 * 1000,
						),
						createdAt: new Date("2026-08-20T12:00:00.000Z"),
					})
					.returning();
				const [recente] = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: `+55119${sufixo}902`,
						name: "Nome Recente",
						originSource: "cacaleads",
						purpose: "prospeccao_b2b_servicos_digitais",
						legalRegisteredAt: new Date(
							agora.getTime() - 80 * 24 * 60 * 60 * 1000,
						),
						createdAt: new Date("2026-09-08T12:00:00.000Z"),
					})
					.returning();
				if (!antigo || !recente) throw new Error("leads nao criados");

				const resposta = await tx.execute(sql`
					select fn_aplicar_retencao(${agora}) as resultado
				`);
				const resultado = resposta.rows[0]?.resultado as Record<
					string,
					unknown
				>;
				expect(Number(resultado.leades_anonimizados)).toBeGreaterThanOrEqual(1);

				const antigoDepois = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, antigo.id),
				});
				expect(antigoDepois?.anonymizedAt).toBeInstanceOf(Date);
				expect(antigoDepois?.phoneNumber).toMatch(/^\+55999\d{9}$/);
				expect(antigoDepois?.phoneNumber).not.toBe(`+55119${sufixo}901`);
				expect(antigoDepois?.waJid).toBeNull();
				expect(antigoDepois?.lid).toBeNull();
				expect(antigoDepois?.name).toBeNull();
				expect(antigoDepois?.addressLine).toBeNull();
				expect(antigoDepois?.optOut).toBe(false);
				expect(antigoDepois?.originSource).toBe("cacaleads");
				expect(antigoDepois?.purpose).toBe("prospeccao_b2b_servicos_digitais");

				const recenteDepois = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, recente.id),
				});
				expect(recenteDepois?.anonymizedAt).toBeNull();
				expect(recenteDepois?.phoneNumber).toBe(`+55119${sufixo}902`);
				expect(recenteDepois?.name).toBe("Nome Recente");

				throw sentinel;
			});
		} catch (erro) {
			if (erro !== sentinel) throw erro;
		}
	});

	it("não apaga mensagens de conversa ativa mesmo com atividade antiga", async () => {
		try {
			await db.transaction(async (txBruto) => {
				const tx = txBruto as unknown as Db;
				const sufixo = String(Date.now() % 100000).padStart(5, "0");
				const [conta] = await tx
					.insert(schema.channelAccounts)
					.values({ phoneE164: `+55119${sufixo}903` })
					.onConflictDoNothing()
					.returning({ id: schema.channelAccounts.id });
				const [lead] = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: `+55119${sufixo}904`,
						originSource: "cacaleads",
						purpose: "prospeccao_b2b_servicos_digitais",
						legalRegisteredAt: new Date(
							agora.getTime() - 400 * 24 * 60 * 60 * 1000,
						),
						createdAt: new Date("2025-10-01T12:00:00.000Z"),
					})
					.returning({ id: schema.leads.id });
				if (!conta || !lead) throw new Error("fixture nao criada");

				const [ativa] = await tx
					.insert(schema.conversations)
					.values({
						leadId: lead.id,
						channelAccountId: conta.id,
						state: "novo",
						createdAt: new Date("2026-04-01T12:00:00.000Z"),
						lastInboundAt: new Date("2026-11-20T12:00:00.000Z"),
					})
					.returning({ id: schema.conversations.id });
				const [encerrada] = await tx
					.insert(schema.conversations)
					.values({
						leadId: lead.id,
						channelAccountId: conta.id,
						state: "encerrado",
						closedReason: "sem_resposta",
						closedAt: new Date("2026-04-01T12:00:00.000Z"),
						createdAt: new Date("2026-04-01T12:00:00.000Z"),
					})
					.returning({ id: schema.conversations.id });
				if (!ativa || !encerrada) throw new Error("conversas nao criadas");

				const [msgAtiva] = await tx
					.insert(schema.messages)
					.values({
						conversationId: ativa.id,
						direction: "in",
						origin: "lead",
						body: "mensagem da conversa ativa",
						idempotencyKey: `politica-ativa-${sufixo}`,
					})
					.returning({ id: schema.messages.id });
				const [msgEncerrada] = await tx
					.insert(schema.messages)
					.values({
						conversationId: encerrada.id,
						direction: "out",
						origin: "bot",
						body: "mensagem da conversa encerrada",
						idempotencyKey: `politica-encerrada-${sufixo}`,
					})
					.returning({ id: schema.messages.id });
				if (!msgAtiva || !msgEncerrada)
					throw new Error("mensagens nao criadas");

				await tx.execute(sql`select fn_aplicar_retencao(${agora})`);

				const mAtiva = await tx.query.messages.findFirst({
					where: eq(schema.messages.id, msgAtiva.id),
				});
				const mEncerrada = await tx.query.messages.findFirst({
					where: eq(schema.messages.id, msgEncerrada.id),
				});
				expect(mAtiva?.body).toBe("mensagem da conversa ativa");
				expect(mEncerrada).toBeUndefined();

				throw sentinel;
			});
		} catch (erro) {
			if (erro !== sentinel) throw erro;
		}
	});
});
