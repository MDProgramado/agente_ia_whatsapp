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
	it("copia a sessão de auth quando IncludeAuth é pedido", () => {
		expect(script).toContain('Join-Path $DataRoot "auth"');
		expect(script).toContain("Copy-Item");
	});
	it("rotaciona por 30 dias usando o timestamp do nome da pasta", () => {
		expect(script).toContain("RotateOnly");
		expect(script).toContain("Get-BackupTimestamp");
		expect(script).toContain("yyyyMMddTHHmmss");
		expect(script).toContain("AddDays(-30)");
		expect(script).toContain("backup_rotacionado");
		expect(script.indexOf("Remove-BackupsExpirados")).toBeLessThan(
			script.indexOf("SHOW server_version"),
		);
	});
	it("mantém um piso de 3 dumps e rota só depois do dump/verify", () => {
		expect(script).toContain("$Manter = 3");
		expect(script).toContain("-Skip $Manter");
		const ultimaChamada = script.lastIndexOf(
			"Remove-BackupsExpirados -Diretorio",
		);
		expect(ultimaChamada).toBeGreaterThan(script.indexOf("if ($Verify)"));
		expect(ultimaChamada).toBeGreaterThan(script.indexOf("pg_dump -Fc falhou"));
	});
	it("guarda a sessão em backups\\auth, fora das pastas datadas", () => {
		expect(script).toContain('Join-Path $BackupsDir "auth"');
		expect(script).toContain("Remove-AuthBackupsAntigos");
		expect(script).toContain("auth_rotacionado");
		expect(
			script.lastIndexOf("Remove-AuthBackupsAntigos -Diretorio"),
		).toBeGreaterThan(script.indexOf("if ($Verify)"));
	});
});
