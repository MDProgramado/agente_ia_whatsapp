import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import { calcularMetricasPiloto } from "../../src/ops/pilot-metrics.js";

let conn: OpenDb;
let db: Db;

beforeAll(async () => {
	conn = await openDb(env.DATABASE_URL);
	db = conn.db;
});

afterAll(async () => {
	await closeDb(conn);
});

describe("calcularMetricasPiloto (PILO-02, PILO-03)", () => {
	it("retorna estrutura correta com indicadores de metas e auditoria", async () => {
		const m = await calcularMetricasPiloto(db, 30);
		expect(m).toBeDefined();
		expect(typeof m.totalLeads).toBe("number");
		expect(typeof m.leadsContatados).toBe("number");
		expect(typeof m.leadsQualificados).toBe("number");
		expect(typeof m.reunioesAgendadas).toBe("number");
		expect(typeof m.taxaQualificacaoPct).toBe("number");
		expect(typeof m.metaReunioesAtingida).toBe("boolean");
		expect(typeof m.metaQualificacaoAtingida).toBe("boolean");
		expect(typeof m.tentativasBloqueadasPeloGate).toBe("number");
	});
});
