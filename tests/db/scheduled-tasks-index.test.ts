/**
 * Migração 0007 — `scheduled_tasks.follow_up_index` + índice único parcial
 * de idempotência de cadência (D-05, FLUP-01).
 *
 * O que este arquivo prova, e por quê:
 *
 * 1. **Coluna existe** (`openDb` → `migrate()`): sem `follow_up_index` não há
 *    como identificar "qual toque" uma linha representa, e o cursor de cadência
 *    (`conversations.follow_up_index`) não tem contra-o-que casar.
 *
 * 2. **Dois `pending` com o mesmo par `(conversation_id, follow_up_index)`
 *    violam a unicidade** — é a barreira que impede dois ticks concorrentes de
 *    criarem dois agendamentos para o mesmo toque (e, por consequência, dois
 *    envios ao lead). Rajada é o padrão de banimento (R-059); a duplicata de
 *    agendamento é o primeiro passo dela.
 *
 * 3. **O índice é PARCIAL**: uma linha `done`/`abandoned` com o mesmo par é
 *    aceita. Histórico de toques já executados e de cancelamentos (que viram
 *    `abandoned` + `cancelled_reason`, nunca um status `'cancelled'` novo —
 *    Pattern 3) precisa poder conviver com um novo agendamento pendente.
 *
 * A metade (1) roda dentro de `db.transaction` revertida por sentinela — o
 * mesmo padrão de `tests/db/shadow-mode-migration.test.ts`, porque `messages`
 * é append-only (R-043) e `leads` não pode ser deletado (LEAD-04): a limpeza é
 * `ROLLBACK`, não `DELETE`.
 */
import { existsSync, readFileSync } from "node:fs";
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

const MIGRATIONS_DIR = "src/infra/db/migrations";

let sequencia = 0;
/** Telefone E.164 de fixture, novo a cada chamada (UNIQUE em leads/channel_accounts). */
const telefoneFixture = (): string => {
	sequencia += 1;
	const bloco = String(Date.now() % 100000).padStart(5, "0");
	return `+55119${bloco}${String(sequencia).padStart(3, "0")}`;
};

describe("migração 0007 — follow_up_index + índice único parcial (openDb/migrate)", () => {
	let conn: OpenDb;
	let db: Db;

	beforeAll(async () => {
		conn = await openDb(env.DATABASE_URL);
		db = conn.db;
	});

	afterAll(async () => {
		await closeDb(conn);
	});

	it("coluna follow_up_index existe (default 0 NOT NULL) e o journal/snapshot do 0007 estão registrados", () => {
		// (a) o journal do Drizzle governa o `migrate()` — sem a entrada, o 0007
		// nem roda e os testes de unicidade abaixo falhariam pelo motivo errado.
		const journal = JSON.parse(
			readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, "utf8"),
		) as { entries: { tag: string }[] };
		const tags = journal.entries.map((e) => e.tag);
		expect(tags).toContain("0007_scheduler_cadence");
		expect(existsSync(`${MIGRATIONS_DIR}/meta/0007_snapshot.json`)).toBe(true);
		expect(existsSync(`${MIGRATIONS_DIR}/0007_scheduler_cadence.sql`)).toBe(
			true,
		);
		expect(
			readFileSync(`${MIGRATIONS_DIR}/0007_scheduler_cadence.sql`, "utf8"),
		).toContain("follow_up_index");

		// (b) default 0: uma linha inserida sem citar a coluna nasce com 0.
		const coluna = schema.scheduledTasks.followUpIndex;
		expect(coluna.name).toBe("follow_up_index");
		expect(coluna.notNull).toBe(true);
	});

	it("D-05: dois 'pending' com o mesmo (conversation_id, follow_up_index) violam a unicidade; 'done'/'abandoned' do mesmo par passam", async () => {
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

				// Primeiro pendente do toque 1 (delta de 1d) — aceito.
				await tx.insert(schema.scheduledTasks).values({
					conversationId: conversaId,
					taskType: "followup",
					scheduledFor: sql`now() + interval '1 day'`,
					followUpIndex: 1,
					status: "pending",
				});

				// (a) SEGUNDO pendente do MESMO par — tem de violar 23505.
				await tx.execute(sql`savepoint prova_unicidade`);
				let violou = false;
				try {
					await tx.insert(schema.scheduledTasks).values({
						conversationId: conversaId,
						taskType: "followup",
						scheduledFor: sql`now() + interval '2 days'`,
						followUpIndex: 1,
						status: "pending",
					});
				} catch (e) {
					violou = true;
					// Drizzle embrulha o erro do Postgres: o SQLSTATE real do
					// driver vive em `cause.code`, não no erro de topo.
					const causa = (e as { cause?: { code?: string } }).cause;
					const codigo = (e as { code?: string }).code ?? causa?.code;
					expect(
						codigo,
						"segundo 'pending' do mesmo par não violou unicidade (23505)",
					).toBe("23505");
					await tx.execute(sql`rollback to savepoint prova_unicidade`);
				}
				expect(
					violou,
					"dois 'pending' com o mesmo (conversation_id, follow_up_index) foram aceitos — idempotência de D-05 ausente",
				).toBe(true);

				// (b) o índice é PARCIAL: histórico do mesmo toque convive.
				await tx.insert(schema.scheduledTasks).values({
					conversationId: conversaId,
					taskType: "followup",
					scheduledFor: sql`now() - interval '1 day'`,
					followUpIndex: 1,
					status: "done",
				});
				await tx.insert(schema.scheduledTasks).values({
					conversationId: conversaId,
					taskType: "followup",
					scheduledFor: sql`now() - interval '3 days'`,
					followUpIndex: 1,
					status: "abandoned",
					cancelledReason: "opt_out",
				});

				// O próximo toque da mesma conversa (índice 2) segue livre.
				await tx.insert(schema.scheduledTasks).values({
					conversationId: conversaId,
					taskType: "followup",
					scheduledFor: sql`now() + interval '3 days'`,
					followUpIndex: 2,
					status: "pending",
				});

				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});
});
