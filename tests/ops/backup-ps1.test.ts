import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(resolve("scripts/backup.ps1"), "utf8");

describe("backup.ps1 - tokens estaticos", () => {
	it("usa pg_dump no formato -Fc e consulta server_version", () => {
		expect(script).toContain("pg_dump");
		expect(script).toContain("-Fc");
		expect(script).toContain("server_version");
	});
	it("verifica mismatch de major entre pg_dump e servidor", () => {
		expect(script).toContain("PGDUMP_VERSION_MISMATCH");
	});
	it("cria whatsapp_restore_test e derruba ao final", () => {
		expect(script).toContain("whatsapp_restore_test");
		expect(script).toContain("DROP DATABASE IF EXISTS");
	});
	it("nao inclui auth_info_baileys por padrao", () => {
		expect(script).toContain("IncludeAuth");
		expect(script).not.toMatch(/Copy-Item.*auth_info_baileys/);
	});
	it("tem LogOnly para modo dry-run", () => {
		expect(script).toContain("LogOnly");
	});
});
