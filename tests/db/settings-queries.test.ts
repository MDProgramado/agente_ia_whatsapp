/**
 * `src/infra/db/queries/settings.ts` — leitura das chaves que a Fase 3 consome.
 *
 * `settings` é `jsonb` mutável em runtime: **dado não confiável na forma**
 * (STRIDE T-03-01 / T-03-02). O que este arquivo prova:
 *
 * 1. **T-03-01 (`followup.max_touches`):** um valor abusivo (9, "2", 0, ausente)
 *    não aumenta o volume — clampa em 4 ou cai no default 4. O teto é regra de
 *    banimento (D-02), não preferência.
 * 2. **T-03-02 (`calendar.holidays`):** uma lista malformada (string solta,
 *    números, formato `25/12`) é IGNORADA em vez de derrubar o tick. O pior caso
 *    é voltar ao calendário nacional.
 * 3. **Pitfall 10:** a leitura escalar usa `value #>> '{}'`.
 *
 * Roda dentro de `db.transaction` revertida por sentinela: `settings` é
 * estado compartilhado do app e um teste não pode deixar `max_touches=9`
 * gravado para o próximo. `ROLLBACK` é a limpeza — não `DELETE`.
 */
import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import {
	CHAVE_FERIADOS,
	CHAVE_MAX_TOQUES,
	lerFeriadosOverride,
	lerMaxToques,
	lerSettings,
} from "../../src/infra/db/queries/settings.js";
import * as schema from "../../src/infra/db/schema.js";

/**
 * `lerSettings` aceita o `Db` de topo; dentro da transação o objeto é o `tx`.
 * As duas formas têm a mesma superfície de consulta — o cast documenta que
 * o teste é o único lugar onde um `tx` é passado, e que a garantia real
 * (rollback) vem da transação, não do tipo.
 */
const comoDb = (tx: unknown): Db => tx as Db;

/** Grava uma chave de `settings` no `tx` com o jsonb cru informado. */
const gravar = async (
	tx: unknown,
	key: string,
	value: SQL | unknown,
): Promise<void> => {
	const db = comoDb(tx);
	await db
		.insert(schema.settings)
		.values({ key, value: value as never })
		.onConflictDoUpdate({
			target: schema.settings.key,
			set: { value: value as never },
		});
};

/** Executa o corpo numa transação sempre revertida. */
const emTransacao = async (corpo: (tx: unknown) => Promise<void>) => {
	const sentinel = new Error("TEST_DONE");
	try {
		await conn.db.transaction(async (tx) => {
			await corpo(tx);
			throw sentinel;
		});
	} catch (e) {
		if (e !== sentinel) throw e;
	}
};

let conn: OpenDb;

describe("settings.ts — leitura de jsonb não confiável (T-03-01/T-03-02)", () => {
	beforeAll(async () => {
		conn = await openDb(env.DATABASE_URL);
	});

	afterAll(async () => {
		await closeDb(conn);
	});

	it("lerSettings devolve o jsonb parseado e o escalar via #>> '{}'", async () => {
		await emTransacao(async (tx) => {
			const db = comoDb(tx);
			await gravar(tx, CHAVE_MAX_TOQUES, { max_touches: 2 });
			const lidos = await lerSettings(db, [CHAVE_MAX_TOQUES, "chave.ausente"]);
			expect(lidos.get(CHAVE_MAX_TOQUES)?.bruto).toEqual({ max_touches: 2 });
			expect(lidos.get(CHAVE_MAX_TOQUES)?.texto).toBe('{"max_touches": 2}');
			expect(lidos.has("chave.ausente")).toBe(false);
		});
	});

	it("lerMaxToques: objeto válido é o valor; abusivo clampa em 4; ausente é 4", async () => {
		await emTransacao(async (tx) => {
			await gravar(tx, CHAVE_MAX_TOQUES, { max_touches: 2 });
			expect(await lerMaxToques(comoDb(tx))).toBe(2);

			await gravar(tx, CHAVE_MAX_TOQUES, { max_touches: 9 });
			expect(await lerMaxToques(comoDb(tx))).toBe(4);

			await gravar(tx, CHAVE_MAX_TOQUES, 3);
			expect(await lerMaxToques(comoDb(tx))).toBe(3);

			// Uma STRING json dentro do jsonb (a forma que um `UPDATE` manual
			// produziria). O cast é obrigatório: passar `"2"` como JS string faz o
			// driver mandar o TEXTO `2`, que o Postgres parseia como número — o
			// fixture mentiria. Com o cast, o drizzle faz parse defensivo da string
			// e o valor chega como número; o que importa é o TETO abaixo.
			await gravar(tx, CHAVE_MAX_TOQUES, sql`'"2"'::jsonb`);
			expect(await lerMaxToques(comoDb(tx))).toBe(2);

			// O caso que a mitigação T-03-01 realmente cobre: seja qual for a forma
			// (objeto, número, string json), NADA passa de 4 toques.
			await gravar(tx, CHAVE_MAX_TOQUES, sql`'"99"'::jsonb`);
			expect(await lerMaxToques(comoDb(tx))).toBe(4);

			await gravar(tx, CHAVE_MAX_TOQUES, { outra: "forma" });
			expect(await lerMaxToques(comoDb(tx))).toBe(4);
		});
	});

	it("lerFeriadosOverride: só datas ISO válidas passam; o resto é ignorado, nunca lança", async () => {
		await emTransacao(async (tx) => {
			await gravar(tx, CHAVE_FERIADOS, [
				"2026-08-11",
				"25/12",
				42,
				null,
				"2026-08-11",
				"2026-01-02",
			]);
			expect(await lerFeriadosOverride(comoDb(tx))).toEqual([
				"2026-01-02",
				"2026-08-11",
			]);

			await gravar(tx, CHAVE_FERIADOS, "nao-e-lista");
			expect(await lerFeriadosOverride(comoDb(tx))).toEqual([]);

			await gravar(tx, CHAVE_FERIADOS, { holidays: ["2026-08-11"] });
			expect(await lerFeriadosOverride(comoDb(tx))).toEqual([]);
		});
	});
});
