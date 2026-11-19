import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import { calcularDiagnosticoCadencia } from "../../src/ops/calibration.js";

let conn: OpenDb;
let db: Db;

beforeAll(async () => {
	conn = await openDb(env.DATABASE_URL);
	db = conn.db;
});

afterAll(async () => {
	await closeDb(conn);
});

describe("calcularDiagnosticoCadencia (PILO-03)", () => {
	it("retorna estrutura válida mesmo sem dados ou com dados parciais", async () => {
		const diagnostico = await calcularDiagnosticoCadencia(db);
		expect(diagnostico).toBeDefined();
		expect(typeof diagnostico.totalConversas).toBe("number");
		expect(typeof diagnostico.conversasComResposta).toBe("number");
		expect(typeof diagnostico.taxaGeralRespostaPct).toBe("number");
		expect(Array.isArray(diagnostico.toques)).toBe(true);
		expect(diagnostico.toques.length).toBe(5);
	});
});
