import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const raiz = mkdtempSync(join(tmpdir(), "backup-rotacao-"));
const backups = join(raiz, "backups");
const script = resolve("scripts/backup.ps1");

const nome = (dias: number): string => {
	const data = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
	const parteData = data.toISOString().slice(0, 10).replaceAll("-", "");
	const parteHora = data.toISOString().slice(11, 19).replaceAll(":", "");
	return `${parteData}T${parteHora}_pg18`;
};

const rodar = (): string =>
	execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			script,
			"-RotateOnly",
		],
		{
			encoding: "utf8",
			env: { ...process.env, DATA_ROOT: raiz, PGBIN: "C:\\inexistente" },
		},
	);

describe("backup.ps1 — rotação por data do nome", () => {
	const antigo = nome(31);
	const recente = nome(29);

	beforeAll(() => {
		mkdirSync(backups, { recursive: true });
		for (const diretorio of [antigo, recente]) {
			mkdirSync(join(backups, diretorio));
		}
		mkdirSync(join(backups, "pasta-sem-carimbo"));
	});

	afterAll(() => {
		rmSync(raiz, { recursive: true, force: true });
	});

	it("remove só o backup com mais de 30 dias no nome", () => {
		const saida = rodar();
		const restantes = readdirSync(backups);
		expect(restantes).toContain(recente);
		expect(restantes).toContain("pasta-sem-carimbo");
		expect(restantes).not.toContain(antigo);
		expect(saida).toContain("backup_rotacionado");
	}, 30_000);
});
