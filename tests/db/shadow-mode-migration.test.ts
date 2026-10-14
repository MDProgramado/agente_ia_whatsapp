/**
 * Migração 0006 — `'shadow'` destravado + `llm_runs`/`review_events` append-only.
 *
 * Duas metades, com propósitos diferentes:
 *
 * 1. **`openDb`** (aplica `migrate()` antes de devolver o handle): prova que o
 *    CHECK de `engagement_mode` passou a aceitar `'shadow'` em `conversations` e
 *    em `mode_changes`, e que um valor inválido AINDA viola o CHECK. Se o 0006
 *    faltar do journal, o `UPDATE ... = 'shadow'` estoura `23514` e o teste
 *    reprova.
 *
 * 2. **`Pool` cru**: prova que `llm_runs` e `review_events` são append-only. Não
 *    usa `openDb` de propósito — a metade (1) já rodou `migrate()`, então um
 *    trigger ausente do repositório ainda estaria aplicado no banco por efeito
 *    do runner. Aqui a conexão é crua: o teste afirma o estado do banco como
 *    ele está (mesmo padrão de `tests/gate/kill-switch.test.ts`).
 *
 * A metade (1) roda dentro de `db.transaction` revertida por sentinela; a
 * limpeza é `ROLLBACK`, porque `messages` é append-only (R-043) e `leads` não
 * pode ser deletado (LEAD-04) — `DELETE` de limpeza quebraria a invariante que
 * o teste existe para provar.
 */
import { existsSync, readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import * as schema from "../../src/infra/db/schema.js";

const MIGRATIONS_DIR = "src/infra/db/migrations";

let sequencia = 0;
/** Telefone E.164 de fixture, novo a cada chamada (UNIQUE em leads/channel_accounts). */
const telefoneFixture = (): string => {
	sequencia += 1;
	const bloco = String(Date.now() % 100000).padStart(5, "0");
	return `+55119${bloco}${String(sequencia).padStart(3, "0")}`;
};

describe("migração 0006 — engagement_mode aceita 'shadow' (openDb/migrate)", () => {
	let conn: OpenDb;
	let db: Db;

	beforeAll(async () => {
		conn = await openDb(env.DATABASE_URL);
		db = conn.db;
	});

	afterAll(async () => {
		await closeDb(conn);
	});

	it("UPDATE conversations SET engagement_mode='shadow' NÃO lança; 'invalido' ainda viola o CHECK; mode_changes aceita shadow", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await db.transaction(async (tx) => {
				const contaFone = telefoneFixture();
				await tx
					.insert(schema.channelAccounts)
					.values({ phoneE164: contaFone })
					.onConflictDoNothing();
				const conta = await tx.query.channelAccounts.findFirst({
					where: eq(schema.channelAccounts.phoneE164, contaFone),
				});
				const [lead] = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: telefoneFixture(),
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now() - interval '1 day'`,
					})
					.returning({ id: schema.leads.id });
				const [conv] = await tx
					.insert(schema.conversations)
					.values({ leadId: lead!.id, channelAccountId: conta!.id })
					.returning({ id: schema.conversations.id });
				const conversaId = conv!.id;

				// (a) 'shadow' é aceito — este é o ponto do 0006 (Pitfall 2).
				await tx.execute(
					sql`update conversations set engagement_mode = 'shadow' where id = ${conversaId}`,
				);
				const depois = await tx.query.conversations.findFirst({
					where: eq(schema.conversations.id, conversaId),
				});
				expect(depois?.engagementMode).toBe("shadow");

				// (b) mode_changes aceita bot_active -> shadow.
				await tx.execute(
					sql`insert into mode_changes (conversation_id, from_mode, to_mode, actor)
						values (${conversaId}, 'bot_active', 'shadow', 'admin')`,
				);

				// (c) um valor inválido AINDA viola o CHECK — o CHECK não foi relaxado.
				await tx.execute(sql`savepoint prova`);
				let violou = false;
				try {
					await tx.execute(
						sql`update conversations set engagement_mode = 'invalido' where id = ${conversaId}`,
					);
				} catch {
					violou = true;
					await tx.execute(sql`rollback to savepoint prova`);
				}
				expect(
					violou,
					"engagement_mode='invalido' NÃO foi rejeitado — o CHECK foi relaxado demais",
				).toBe(true);

				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});
});

describe("append-only de llm_runs e review_events (Pool cru)", () => {
	let pool: Pool;

	beforeAll(() => {
		pool = new Pool({
			connectionString: env.DATABASE_URL,
			max: 1,
			application_name: "testes_shadow_migration",
		});
	});

	afterAll(async () => {
		await pool?.end();
	});

	/** `P0001` é o SQLSTATE de `RAISE EXCEPTION` — o que o trigger emite. */
	const P0001 = "P0001";

	const esperaRejeicao = async (
		client: PoolClient,
		sqlTexto: string,
		parametros: unknown[] = [],
	): Promise<{ codigo: string; mensagem: string } | null> => {
		await client.query("savepoint prova");
		try {
			await client.query(sqlTexto, parametros);
			await client.query("rollback to savepoint prova");
			return null;
		} catch (e) {
			await client.query("rollback to savepoint prova");
			const err = e as { code?: string; message?: string };
			return { codigo: err.code ?? "?", mensagem: err.message ?? "?" };
		}
	};

	/** Cria fixtures mínimas (conta, lead, conversa, mensagem) e devolve os ids. */
	const criaFixtures = async (
		client: PoolClient,
	): Promise<{ conversationId: string; messageId: string }> => {
		const conta = await client.query(
			"insert into channel_accounts (phone_e164) values ($1) returning id",
			[telefoneFixture()],
		);
		const lead = await client.query(
			`insert into leads (phone_number, origin_source, purpose, legal_registered_at)
			 values ($1, 'cacaleads', 'prospecao_b2b_servicos_digitais', now() - interval '1 day')
			 returning id`,
			[telefoneFixture()],
		);
		const conversa = await client.query(
			"insert into conversations (lead_id, channel_account_id) values ($1, $2) returning id",
			[lead.rows[0].id, conta.rows[0].id],
		);
		const mensagem = await client.query(
			`insert into messages (conversation_id, direction, origin, body, idempotency_key)
			 values ($1, 'out', 'ai_suggestion', 'rascunho em shadow', $2) returning id`,
			[conversa.rows[0].id, `shadow-${Date.now()}-${Math.random()}`],
		);
		return {
			conversationId: conversa.rows[0].id as string,
			messageId: mensagem.rows[0].id as string,
		};
	};

	/** Roda `corpo` numa transação SEMPRE revertida (limpeza via ROLLBACK). */
	const emTransacaoDescartavel = async <T>(
		corpo: (client: PoolClient) => Promise<T>,
	): Promise<T> => {
		const client = await pool.connect();
		try {
			await client.query("begin");
			try {
				const resultado = await corpo(client);
				await client.query("rollback");
				return resultado;
			} catch (e) {
				await client.query("rollback").catch(() => undefined);
				throw e;
			}
		} finally {
			client.release();
		}
	};

	it("R-043: UPDATE e DELETE em llm_runs são REJEITADOS pelo banco", async () => {
		const { erroUpdate, erroDelete } = await emTransacaoDescartavel(
			async (client) => {
				await client.query(
					`insert into llm_runs (model, prompt_version, policy_version, zod_parse_ok, canary_ok)
					 values ('scripted', 'p1', 'pol1', true, true)`,
				);
				const erroUpdate = await esperaRejeicao(
					client,
					"update llm_runs set model = 'outro'",
				);
				const erroDelete = await esperaRejeicao(client, "delete from llm_runs");
				return { erroUpdate, erroDelete };
			},
		);
		expect(erroUpdate, "UPDATE em llm_runs NÃO foi rejeitado").not.toBeNull();
		expect(erroDelete, "DELETE em llm_runs NÃO foi rejeitado").not.toBeNull();
		expect(erroUpdate?.codigo).toBe(P0001);
		expect(erroDelete?.codigo).toBe(P0001);
		expect(erroUpdate?.mensagem).toContain("append-only");
	});

	it("R-043: UPDATE e DELETE em review_events são REJEITADOS pelo banco", async () => {
		const { erroUpdate, erroDelete } = await emTransacaoDescartavel(
			async (client) => {
				const { messageId } = await criaFixtures(client);
				await client.query(
					`insert into review_events (message_id, decision, actor)
					 values ($1, 'approved', 'admin')`,
					[messageId],
				);
				const erroUpdate = await esperaRejeicao(
					client,
					"update review_events set decision = 'discarded'",
				);
				const erroDelete = await esperaRejeicao(
					client,
					"delete from review_events",
				);
				return { erroUpdate, erroDelete };
			},
		);
		expect(
			erroUpdate,
			"UPDATE em review_events NÃO foi rejeitado",
		).not.toBeNull();
		expect(
			erroDelete,
			"DELETE em review_events NÃO foi rejeitado",
		).not.toBeNull();
		expect(erroUpdate?.codigo).toBe(P0001);
		expect(erroDelete?.codigo).toBe(P0001);
	});

	it("review_events.decision só aceita approved/edited/discarded", async () => {
		const erro = await emTransacaoDescartavel(async (client) => {
			const { messageId } = await criaFixtures(client);
			return esperaRejeicao(
				client,
				`insert into review_events (message_id, decision, actor) values ($1, 'promovido', 'admin')`,
				[messageId],
			);
		});
		expect(
			erro,
			"decision='promovido' foi aceito — CHECK ausente",
		).not.toBeNull();
		expect(erro?.codigo).toBe("23514");
	});
});

describe("arquivos da migração 0006", () => {
	it("_journal.json registra 0006_shadow_and_llm_runs e o snapshot existe", () => {
		const journal = JSON.parse(
			readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, "utf8"),
		) as { entries: { tag: string }[] };
		const tags = journal.entries.map((e) => e.tag);
		expect(tags).toContain("0006_shadow_and_llm_runs");
		expect(existsSync(`${MIGRATIONS_DIR}/meta/0006_snapshot.json`)).toBe(true);
		expect(existsSync(`${MIGRATIONS_DIR}/0006_shadow_and_llm_runs.sql`)).toBe(
			true,
		);
	});
});
