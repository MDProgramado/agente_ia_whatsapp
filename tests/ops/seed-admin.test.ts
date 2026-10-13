/**
 * EQUP-01: a linha do Admin em `app_users` (R-027).
 *
 * O plano 01-02 diz "um único usuário administrador existe como **linha** em
 * `app_users`" — e a verificação de fase 2026-10-13 pegou `count(*) = 0` com
 * nenhum INSERT no repositório. A migration `0005_seed_admin` faz nascer essa
 * linha.
 *
 * `openDb` roda `migrate()` antes de devolver o handle, então este teste é a
 * prova da migration: se o `0005` faltar do journal (ou o migrator quebrar),
 * `app_users` volta a ficar vazia e o teste falha.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";

describe("seed da linha do Admin (EQUP-01)", () => {
	let conn: OpenDb;
	let db: Db;

	beforeAll(async () => {
		conn = await openDb(env.DATABASE_URL);
		db = conn.db;
	});

	afterAll(async () => {
		await closeDb(conn);
	});

	it("existe ao menos um usuário em `app_users` após a migration 0005", async () => {
		const [linha] = (
			await db.execute(sql`select count(*)::int as n from app_users`)
		).rows as { n: number }[];
		expect(linha?.n ?? 0).toBeGreaterThanOrEqual(1);
	});

	it("a linha seedada é o Admin", async () => {
		const linhas = (
			await db.execute(
				sql`select name, email from app_users where email = 'admin@whatsapp-prospect.local'`,
			)
		).rows;
		expect(linhas).toHaveLength(1);
		expect(linhas[0]).toMatchObject({ name: "Admin" });
	});
});
