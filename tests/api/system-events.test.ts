/**
 * Testes TDD do endpoint `GET /api/system/events` (03-07 Task 1, R-045).
 *
 * Valida:
 *   1. Listagem paginada padrão (200 { page, pageSize, itens: [...] }) ordenada por createdAt desc.
 *   2. Filtro de severidade (?severity=error) devolve apenas eventos com essa severidade.
 *   3. Severidade inválida (?severity=bogus) -> 400.
 *   4. pageSize acima do teto (?pageSize=500 > 200) -> 400.
 *   5. Sem eventos -> 200 { itens: [] }.
 *   6. Read-only: nenhum método de mutação.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type PanelCore } from "../../src/api/server.js";
import type { DispatchDeps } from "../../src/application/dispatcher.js";
import { BarramentoEventos } from "../../src/application/event-bus.js";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import { criarFakeChannel } from "../../src/infra/fake-channel.js";
import { instanteEmZona, TZ } from "../gate/fixtures.js";

const DENTRO_DA_JANELA = instanteEmZona(TZ, 2026, 9, 29, 13, 0);
const SENTINELA = "rollback-intencional-do-teste";
const AUTORIZADO = { authorization: `Bearer ${env.PANEL_TOKEN}` };
const HOST_OK = { host: "127.0.0.1" };

let openDbInstance: OpenDb;
let db: Db;

beforeAll(async () => {
	openDbInstance = await openDb(env.DATABASE_URL);
	db = openDbInstance.db;
});

afterAll(async () => {
	if (openDbInstance) {
		await closeDb(openDbInstance);
	}
});

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

const montarCore = (tx: Db): PanelCore => {
	const channel = criarFakeChannel();
	const ctx: DispatchDeps["ctx"] = {
		tz: env.TZ,
		windowStartHour: env.WINDOW_START_HOUR,
		windowEndHour: env.WINDOW_END_HOUR,
		dailyMessageLimit: env.DAILY_MESSAGE_LIMIT,
		dailyMessageCap: 30,
	};
	return {
		db: tx,
		bus: new BarramentoEventos(tx),
		dispatchDeps: { db: tx, channel, ctx },
		feriados: [],
		agora: () => DENTRO_DA_JANELA,
	};
};

describe("GET /api/system/events (R-045, 03-07 Task 1)", () => {
	it("devolve 200 com itens ordenados por createdAt desc", async () => {
		await emTransacaoRevertida(async (tx) => {
			const core = montarCore(tx);
			const app = buildServer({ core });

			// Insere 2 eventos com timestamps distintos
			await tx.execute(sql`
				insert into event_log (id, event_type, entity_type, payload, severity, created_at)
				values
					(${randomUUID()}, 'teste_1', 'system', '{"seq": 1}'::jsonb, 'info', now() - interval '2 minutes'),
					(${randomUUID()}, 'teste_2', 'system', '{"seq": 2}'::jsonb, 'warn', now() - interval '1 minute')
			`);

			const res = await app.inject({
				method: "GET",
				url: "/api/system/events",
				headers: { ...AUTORIZADO, ...HOST_OK },
			});

			expect(res.statusCode).toBe(200);
			const body = res.json() as {
				page: number;
				pageSize: number;
				itens: Array<{
					id: string;
					eventType: string;
					entityType: string;
					severity: string;
					payload: Record<string, unknown>;
					createdAt: string;
				}>;
			};

			expect(body.page).toBe(1);
			expect(body.pageSize).toBe(50);
			expect(body.itens.length).toBeGreaterThanOrEqual(2);

			const idx2 = body.itens.findIndex((i) => i.eventType === "teste_2");
			const idx1 = body.itens.findIndex((i) => i.eventType === "teste_1");
			expect(idx2).toBeGreaterThanOrEqual(0);
			expect(idx1).toBeGreaterThanOrEqual(0);
			expect(idx2).toBeLessThan(idx1); // teste_2 é mais recente que teste_1
		});
	});

	it("filtra por severidade (?severity=error)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const core = montarCore(tx);
			const app = buildServer({ core });

			await tx.execute(sql`
				insert into event_log (id, event_type, entity_type, payload, severity)
				values
					(${randomUUID()}, 'err_1', 'system', '{"msg": "falha"}'::jsonb, 'error'),
					(${randomUUID()}, 'info_1', 'system', '{"msg": "ok"}'::jsonb, 'info')
			`);

			const res = await app.inject({
				method: "GET",
				url: "/api/system/events?severity=error",
				headers: { ...AUTORIZADO, ...HOST_OK },
			});

			expect(res.statusCode).toBe(200);
			const body = res.json() as {
				itens: Array<{ eventType: string; severity: string }>;
			};
			expect(body.itens.every((i) => i.severity === "error")).toBe(true);
			expect(body.itens.some((i) => i.eventType === "err_1")).toBe(true);
			expect(body.itens.some((i) => i.eventType === "info_1")).toBe(false);
		});
	});

	it("rejeita severidade inválida com 400", async () => {
		await emTransacaoRevertida(async (tx) => {
			const core = montarCore(tx);
			const app = buildServer({ core });

			const res = await app.inject({
				method: "GET",
				url: "/api/system/events?severity=bogus",
				headers: { ...AUTORIZADO, ...HOST_OK },
			});

			expect(res.statusCode).toBe(400);
		});
	});

	it("rejeita pageSize acima do teto de 200 com 400", async () => {
		await emTransacaoRevertida(async (tx) => {
			const core = montarCore(tx);
			const app = buildServer({ core });

			const res = await app.inject({
				method: "GET",
				url: "/api/system/events?pageSize=500",
				headers: { ...AUTORIZADO, ...HOST_OK },
			});

			expect(res.statusCode).toBe(400);
		});
	});

	it("responde 200 com lista vazia para página muito alta sem eventos", async () => {
		await emTransacaoRevertida(async (tx) => {
			const core = montarCore(tx);
			const app = buildServer({ core });

			const res = await app.inject({
				method: "GET",
				url: "/api/system/events?page=999999",
				headers: { ...AUTORIZADO, ...HOST_OK },
			});

			expect(res.statusCode).toBe(200);
			const body = res.json() as { itens: unknown[] };
			expect(body.itens).toEqual([]);
		});
	});
});

