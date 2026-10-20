/**
 * `readDailyCounter` — o contador de novos contatos do dia vem do BANCO, no
 * ato do dispatch (hotfix pós-review).
 *
 * O que este teste prova:
 *
 * 1. Ausência da linha devolve `0` — dia sem movimento não é falha.
 * 2. Depois do INSERT, a leitura devolve o valor fresco — é a propriedade que
 *    o gate precisa: leads novos entram o dia inteiro e o valor lido uma vez
 *    no boot (bug corrigido) ficaria congelado até o próximo restart.
 * 3. O kind separa contadores: gravar `new_contacts` não muda `sent`.
 *
 * Roda em transação revertida (mesmo padrão de `dispatcher-choke-point.test.ts`):
 * o INSERT nunca sobrevive ao teste, então o `daily_counters` real fica limpo.
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
import { readDailyCounter } from "../../src/infra/db/queries/counters.js";

/** Data futura e descartável: não colide com o dia real de nenhum teste. */
const DIA = "2099-01-15";
const DIA_VAZIA = "2099-01-16";
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

const emTransacaoRevertida = async (fn: (tx: Db) => Promise<void>) => {
	try {
		await db.transaction(async (txBruto) => {
			await fn(txBruto as unknown as Db);
			throw new Error(SENTINELA);
		});
	} catch (erro) {
		if (!(erro instanceof Error) || erro.message !== SENTINELA) throw erro;
	}
};

describe("readDailyCounter", () => {
	it("devolve 0 quando o dia não tem linha em daily_counters", async () => {
		await emTransacaoRevertida(async (tx) => {
			expect(await readDailyCounter(tx, DIA_VAZIA, "new_contacts")).toBe(0);
		});
	});

	it("devolve o valor fresco após o INSERT (nunca um valor congelado)", async () => {
		await emTransacaoRevertida(async (tx) => {
			expect(await readDailyCounter(tx, DIA, "new_contacts")).toBe(0);

			await tx.execute(sql`
				insert into daily_counters (day, kind, count)
				values (${DIA}, 'new_contacts', 3)
			`);

			expect(await readDailyCounter(tx, DIA, "new_contacts")).toBe(3);
			// O kind separa: gravar novos contatos não move o contador de envios.
			expect(await readDailyCounter(tx, DIA, "sent")).toBe(0);
		});
	});

	it("revela incrementalização entre duas leituras no mesmo dia", async () => {
		await emTransacaoRevertida(async (tx) => {
			await tx.execute(sql`
				insert into daily_counters (day, kind, count)
				values (${DIA}, 'new_contacts', 1)
				on conflict (day, kind) do update set count = daily_counters.count + 1
			`);
			expect(await readDailyCounter(tx, DIA, "new_contacts")).toBe(1);

			await tx.execute(sql`
				update daily_counters set count = count + 1
				where day = ${DIA} and kind = 'new_contacts'
			`);
			expect(await readDailyCounter(tx, DIA, "new_contacts")).toBe(2);
		});
	});
});
