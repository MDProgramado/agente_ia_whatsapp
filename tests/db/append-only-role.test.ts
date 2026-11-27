import { sql } from "drizzle-orm";
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

const linhas = <T>(resultado: unknown): T[] =>
	(resultado as { rows: T[] }).rows;

describe("migração 0012 — append-only sem bypass por GUC", () => {
	let conn: OpenDb;
	let db: Db;

	beforeAll(async () => {
		conn = await openDb(env.DATABASE_URL);
		db = conn.db;
	});

	afterAll(async () => {
		await closeDb(conn);
	});

	it("cria o papel whatsapp_retencao NOLOGIN e transfere a propriedade da retenção", async () => {
		const papeis = linhas<{ nome: string; podeLogar: boolean }>(
			await db.execute(sql`
				select rolname as nome, rolcanlogin as "podeLogar"
				from pg_roles where rolname = 'whatsapp_retencao'
			`),
		);
		expect(papeis).toEqual([{ nome: "whatsapp_retencao", podeLogar: false }]);

		const funcoes = linhas<{ nome: string; dono: string }>(
			await db.execute(sql`
				select p.proname as nome, pg_get_userbyid(p.proowner) as dono
				from pg_proc p
				where p.proname in ('fn_aplicar_retencao', 'fn_aplicar_erasure')
				order by p.proname
			`),
		);
		expect(funcoes).toEqual([
			{ nome: "fn_aplicar_erasure", dono: "whatsapp_retencao" },
			{ nome: "fn_aplicar_retencao", dono: "whatsapp_retencao" },
		]);

		const defs = linhas<{ definicao: string }>(
			await db.execute(sql`
				select pg_get_functiondef(p.oid) as definicao
				from pg_proc p
				join pg_namespace n on n.oid = p.pronamespace
				where p.proname = 'fn_append_only' and n.nspname = 'public'
			`),
		);
		expect(defs).toHaveLength(1);
		expect(defs[0]?.definicao).not.toContain("app.retencao_autorizada");
		expect(defs[0]?.definicao).toContain("whatsapp_retencao");
	});

	it("SET app.retencao_autorizada=on não autoriza DELETE direto", async () => {
		try {
			await db.transaction(async (txBruto) => {
				const tx = txBruto as unknown as Db;
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
						purpose: "prospeccao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now() - interval '1 day'`,
					})
					.returning({ id: schema.leads.id });
				if (!conta || !lead) throw new Error("fixture nao criada");
				const [conv] = await tx
					.insert(schema.conversations)
					.values({
						leadId: lead.id,
						channelAccountId: conta.id,
					})
					.returning({ id: schema.conversations.id });
				const [msg] = await tx
					.insert(schema.messages)
					.values({
						conversationId: conv?.id ?? "",
						direction: "out",
						origin: "bot",
						body: "mensagem protegida",
						idempotencyKey: `append-only-guc-${sufixo}`,
					})
					.returning({ id: schema.messages.id });
				if (!conv || !msg) throw new Error("mensagem nao criada");

				let bloqueou = false;
				await tx.execute(sql`savepoint tentativa_guc`);
				try {
					await tx.execute(sql`SET LOCAL app.retencao_autorizada = 'on'`);
					await tx.execute(sql`delete from messages where id = ${msg.id}`);
				} catch {
					bloqueou = true;
				} finally {
					await tx.execute(sql`rollback to savepoint tentativa_guc`);
					await tx.execute(sql`RESET app.retencao_autorizada`);
				}
				expect(bloqueou).toBe(true);

				throw sentinel;
			});
		} catch (erro) {
			if (erro !== sentinel) throw erro;
		}
	});
});
