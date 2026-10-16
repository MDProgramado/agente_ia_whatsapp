/**
 * O tick de 30s do scheduler — produtor do `outbox`, NUNCA sender.
 *
 * ## Por que estes testes usam transação revertida
 *
 * `messages` é append-only e `leads` não pode ser deletado (os mesmos motivos do
 * `outbox.test.ts`): não há como limpar o banco depois. Cada caso roda dentro de
 * uma transação que termina em `rollback` — o que importa é o estado DENTRO da
 * transação, e a base de desenvolvimento não acumula `scheduled_tasks`, `outbox`
 * nem cota.
 *
 * ## Por que a âncora é semeada com `to_timestamp(... AT TIME ZONE ...)`
 *
 * `conversations.last_outbound_at` é `timestamp` SEM fuso (wall time de São
 * Paulo). Semear com um `Date` dependeria de o fuso do processo Node coincidir
 * com o da sessão do banco — verdadeiro aqui, mas frágil. `to_timestamp(epoch)
 * AT TIME ZONE 'America/Sao_Paulo'` grava o wall time SP a partir de um epoch
 * EXPLÍCITO (`ANCORA.getTime()`), então o valor lido de volta é, por construção,
 * o mesmo instante de `ANCORA`, em qualquer máquina.
 */
import { randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startScheduler } from "../../src/application/scheduler.js";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import { scheduledTaskPendente } from "../../src/infra/db/queries/scheduler.js";
import { instanteEmZona, TZ } from "../gate/fixtures.js";

/** Terça 29/09/2026 11h SP — o instante do último outbound (a âncora). */
const ANCORA = instanteEmZona(TZ, 2026, 9, 29, 11, 0);
/** Terça 29/09/2026 13h SP — o relógio do tick (dentro da janela). */
const AGORA = instanteEmZona(TZ, 2026, 9, 29, 13, 0);
/** O alvo do toque 0 é ANCORA + 1h = 12h SP (já vencido em AGORA). */
const ALVO_0 = new Date(ANCORA.getTime() + 3_600_000);
const DIA_MS = 86_400_000;

/** Cron que NÃO dispara durante o teste: só se chama `tick()` à mão. */
const CRON_NAO_DISPARA = "0 0 0 1 1 *";

const SENTINELA = "rollback-intencional-do-teste";

const rows = <T>(resultado: unknown): T[] => (resultado as { rows: T[] }).rows;

const primeiro = <T>(lista: readonly T[]): T => {
	const [item] = lista;
	if (item === undefined) throw new Error("esperava ao menos uma linha");
	return item;
};

const telefoneAleatorio = (): string =>
	`+55${randomInt(10_000_000_000, 99_999_999_999)}`;

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

const inserirConta = async (db: Db): Promise<string> => {
	await db.execute(sql`
		INSERT INTO channel_accounts (phone_e164, display_name)
		VALUES (${env.CHANNEL_PHONE_E164}, 'teste-scheduler')
		ON CONFLICT (phone_e164) DO NOTHING
	`);
	const id = rows<{ id: string }>(
		await db.execute(sql`
			SELECT id FROM channel_accounts WHERE phone_e164 = ${env.CHANNEL_PHONE_E164}
		`),
	)[0]?.id;
	if (!id) throw new Error("conta de teste nao encontrada");
	return id;
};

interface LeadOpts {
	readonly firstContactByHuman?: boolean;
	readonly optOut?: boolean;
	readonly nome?: string | null;
}

const inserirLead = async (
	db: Db,
	telefone: string,
	opts: LeadOpts = {},
): Promise<string> => {
	const r = await db.execute(sql`
		INSERT INTO leads (
			phone_number, origin_source, legal_basis, purpose,
			legal_registered_at, first_contact_by_human, wa_validation_state, opt_out, name
		)
		VALUES (
			${telefone}, 'teste', 'legitimo_interesse', 'prospeccao',
			'2025-01-01T12:00:00Z', ${opts.firstContactByHuman ?? true}, 'VALIDO',
			${opts.optOut ?? false}, ${opts.nome ?? null}
		)
		RETURNING id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

/**
 * Conversa elegível por padrão: `state='novo'`, `engagement_mode='bot_active'`,
 * âncora em ANCORA, cursor 0. `last_outbound_at` é gravado a partir do epoch de
 * ANCORA via `AT TIME ZONE` (ver o cabeçalho).
 */
const inserirConversa = async (
	db: Db,
	leadId: string,
	contaId: string,
	ancora: Date = ANCORA,
): Promise<string> => {
	const ancoraWall = sql`(to_timestamp(${ancora.getTime()}::double precision / 1000.0) AT TIME ZONE ${TZ})`;
	const r = await db.execute(sql`
		INSERT INTO conversations (
			lead_id, channel_account_id, state, engagement_mode, last_outbound_at, follow_up_index
		)
		VALUES (${leadId}, ${contaId}, 'novo', 'bot_active', ${ancoraWall}, 0)
		RETURNING id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

const tasksDaConversa = (db: Db, conversaId: string) =>
	db
		.execute(sql`
			SELECT status, cancelled_reason, follow_up_index, scheduled_for::text AS scheduled_for
			FROM scheduled_tasks
			WHERE conversation_id = ${conversaId}
			ORDER BY follow_up_index
		`)
		.then(
			rows<{
				status: string;
				cancelled_reason: string | null;
				follow_up_index: number;
				scheduled_for: string;
			}>,
		);

const jobsDaConversa = (db: Db, conversaId: string) =>
	db
		.execute(sql`
			SELECT status, idempotency_key, body
			FROM outbox
			WHERE conversation_id = ${conversaId}
			ORDER BY idempotency_key
		`)
		.then(rows<{ status: string; idempotency_key: string; body: string }>);

/** Scheduler de teste com o relógio fixo. O chamador para o cron no fim. */
const criarScheduler = (tx: Db, agora: Date = AGORA) =>
	startScheduler({
		db: tx,
		now: () => agora,
		feriados: [],
		maxToques: 4,
		cronPattern: CRON_NAO_DISPARA,
	});

let conn: OpenDb;
let db: Db;

beforeAll(async () => {
	conn = await openDb(env.DATABASE_URL);
	db = conn.db;
});

afterAll(async () => {
	await closeDb(conn);
});

describe("scheduler.tick — agendamento idempotente e ancorado (D-01/D-05)", () => {
	it("dois ticks ⇒ exatamente 1 task e 1 job; scheduled_for não muda (Pitfall 2)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneAleatorio(), {
				nome: "Maria Silva",
			});
			const conversaId = await inserirConversa(tx, leadId, contaId);

			const sched = criarScheduler(tx);
			try {
				await sched.tick();
				const depois1 = await scheduledTaskPendente(tx, conversaId, 0);
				expect(depois1?.scheduledFor.getTime()).toBe(ALVO_0.getTime());

				await sched.tick();
				const depois2 = await scheduledTaskPendente(tx, conversaId, 0);
				expect(depois2?.scheduledFor.getTime()).toBe(ALVO_0.getTime());
			} finally {
				sched.stop();
			}

			const tasks = await tasksDaConversa(tx, conversaId);
			expect(tasks).toHaveLength(1);
			expect(primeiro(tasks).status).toBe("pending");
			expect(Number(primeiro(tasks).follow_up_index)).toBe(0);

			const jobs = await jobsDaConversa(tx, conversaId);
			expect(jobs).toHaveLength(1);
			expect(primeiro(jobs).idempotency_key).toBe(`flup:${conversaId}:0`);
			// O texto renderiza o primeiro nome e nunca vaza o placeholder.
			expect(primeiro(jobs).body).toContain("Maria");
			expect(primeiro(jobs).body).not.toContain("[Nome]");
		});
	});
});

describe("scheduler.tick — cancelamento auditável (FLUP-02, Pattern 3)", () => {
	it("pausa manual ⇒ task abandoned com motivo + job abandoned; sem DELETE", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneAleatorio());
			const conversaId = await inserirConversa(tx, leadId, contaId);

			const sched = criarScheduler(tx);
			try {
				// Tick 1: agenda e enfileira.
				await sched.tick();
				expect(await tasksDaConversa(tx, conversaId)).toHaveLength(1);

				// A conversa sai de cadência (pausa manual) ANTES do tick 2.
				await tx.execute(sql`
					UPDATE conversations SET engagement_mode = 'pausado' WHERE id = ${conversaId}
				`);

				// Tick 2: cancela o interrompido.
				await sched.tick();
			} finally {
				sched.stop();
			}

			const tasks = await tasksDaConversa(tx, conversaId);
			expect(tasks).toHaveLength(1);
			expect(primeiro(tasks).status).toBe("abandoned");
			expect(primeiro(tasks).cancelled_reason).toBe("pausa_manual");

			const jobs = await jobsDaConversa(tx, conversaId);
			expect(jobs).toHaveLength(1);
			expect(primeiro(jobs).status).toBe("abandoned");
		});
	});
});

describe("scheduler.tick — contato frio nunca é automatizado (R-001/D-08)", () => {
	it("first_contact_by_human=false ⇒ 0 tasks e 0 jobs", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneAleatorio(), {
				firstContactByHuman: false,
			});
			const conversaId = await inserirConversa(tx, leadId, contaId);

			const sched = criarScheduler(tx);
			try {
				await sched.tick();
			} finally {
				sched.stop();
			}

			expect(await tasksDaConversa(tx, conversaId)).toHaveLength(0);
			expect(await jobsDaConversa(tx, conversaId)).toHaveLength(0);
		});
	});
});

describe("scheduler.tick — reconciliação do ledger com o outbox (D-01)", () => {
	it("job já sent ⇒ fecha task done, avança cursor e agenda o próximo toque", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneAleatorio());
			const conversaId = await inserirConversa(tx, leadId, contaId);

			const sched = criarScheduler(tx);
			try {
				// Tick 1: agenda o toque 0 e enfileira.
				await sched.tick();

				// Simula um envio que não fechou o ledger: o job vira `sent`, mas a
				// task continua `pending` e o cursor não avançou.
				await tx.execute(sql`
					UPDATE outbox SET status = 'sent'
					WHERE idempotency_key = ${`flup:${conversaId}:0`}
				`);

				// Tick 2: o reconciliador percebe o envio, fecha a task e avança.
				await sched.tick();
			} finally {
				sched.stop();
			}

			const tasks = await tasksDaConversa(tx, conversaId);
			expect(tasks).toHaveLength(2);
			expect(tasks[0]?.status).toBe("done");
			expect(Number(tasks[0]?.follow_up_index)).toBe(0);
			expect(tasks[1]?.status).toBe("pending");
			expect(Number(tasks[1]?.follow_up_index)).toBe(1);

			const cursor = rows<{ follow_up_index: number }>(
				await tx.execute(sql`
					SELECT follow_up_index FROM conversations WHERE id = ${conversaId}
				`),
			);
			expect(Number(primeiro(cursor).follow_up_index)).toBe(1);

			// O próximo toque é 1d após a âncora (ANCORA + 1 dia), e como ainda não
			// venceu (AGORA é 13h do mesmo dia), NÃO gera novo job.
			const toque1 = await scheduledTaskPendente(tx, conversaId, 1);
			expect(toque1?.scheduledFor.getTime()).toBe(ANCORA.getTime() + DIA_MS);
			expect(await jobsDaConversa(tx, conversaId)).toHaveLength(1);
		});
	});
});
