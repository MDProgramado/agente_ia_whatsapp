import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const script = resolve("scripts/backup.ps1");

const nome = (dias: number): string => {
	const data = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
	const parteData = data.toISOString().slice(0, 10).replaceAll("-", "");
	const parteHora = data.toISOString().slice(11, 19).replaceAll(":", "");
	return `${parteData}T${parteHora}_pg18`;
};

const nomeAuth = (dias: number): string => {
	const data = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
	const parteData = data.toISOString().slice(0, 10).replaceAll("-", "");
	const parteHora = data.toISOString().slice(11, 19).replaceAll(":", "");
	return `${parteData}T${parteHora}`;
};

const rodar = (raiz: string): string =>
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

const criarBackups = (raiz: string): string => {
	const backups = join(raiz, "backups");
	mkdirSync(backups, { recursive: true });
	return backups;
};

const contar = (saida: string, evento: string): number =>
	(saida.match(new RegExp(evento, "g")) ?? []).length;

describe("backup.ps1 — rotação dos dumps (30 dias + piso de 3)", () => {
	const raiz = mkdtempSync(join(tmpdir(), "backup-rotacao-"));
	const nomesAntigos = [nome(40), nome(35), nome(31), nome(32), nome(33)];
	let backups: string;

	afterAll(() => {
		rmSync(raiz, { recursive: true, force: true });
	});

	it("mantém os 3 dumps mais recentes mesmo com mais de 30 dias", () => {
		backups = criarBackups(raiz);
		for (const dir of nomesAntigos) mkdirSync(join(backups, dir));
		mkdirSync(join(backups, "pasta-sem-carimbo"));

		const saida = rodar(raiz);
		const restantes = readdirSync(backups);

		expect(restantes).not.toContain(nomesAntigos[0]);
		expect(restantes).not.toContain(nomesAntigos[1]);
		expect(restantes).toContain(nomesAntigos[2]);
		expect(restantes).toContain(nomesAntigos[3]);
		expect(restantes).toContain(nomesAntigos[4]);
		expect(restantes).toContain("pasta-sem-carimbo");
		expect(contar(saida, "backup_rotacionado")).toBe(2);
	}, 30_000);
});

describe("backup.ps1 — piso de 3 nunca apaga até ter 3 dumps", () => {
	const raiz = mkdtempSync(join(tmpdir(), "backup-piso-"));

	afterAll(() => {
		rmSync(raiz, { recursive: true, force: true });
	});

	it("não apaga nada quando só há 2 dumps antigos", () => {
		const backups = criarBackups(raiz);
		const antigos = [nome(31), nome(45)];
		for (const dir of antigos) mkdirSync(join(backups, dir));

		const saida = rodar(raiz);
		const restantes = readdirSync(backups);

		expect(restantes).toEqual(expect.arrayContaining(antigos));
		expect(restantes).toHaveLength(2);
		expect(saida).not.toContain("backup_rotacionado");
	}, 30_000);
});

describe("backup.ps1 — apaga só o que passa de 30 dias fora do piso", () => {
	const raiz = mkdtempSync(join(tmpdir(), "backup-fora-do-piso-"));

	afterAll(() => {
		rmSync(raiz, { recursive: true, force: true });
	});

	it("com 1 recente e 3 antigas, remove apenas a mais antiga", () => {
		const backups = criarBackups(raiz);
		const recente = nome(5);
		const antigas = [nome(31), nome(32), nome(33)];
		mkdirSync(join(backups, recente));
		for (const dir of antigas) mkdirSync(join(backups, dir));

		const saida = rodar(raiz);
		const restantes = readdirSync(backups);

		expect(restantes).toContain(recente);
		expect(restantes).toContain(antigas[0]);
		expect(restantes).toContain(antigas[1]);
		expect(restantes).not.toContain(antigas[2]);
		expect(restantes).toHaveLength(3);
		expect(contar(saida, "backup_rotacionado")).toBe(1);
	}, 30_000);
});

describe("backup.ps1 — sessão fora das pastas datadas, contagem de 3", () => {
	const raiz = mkdtempSync(join(tmpdir(), "backup-auth-"));

	afterAll(() => {
		rmSync(raiz, { recursive: true, force: true });
	});

	it("mantém as 3 cópias mais recentes de auth por contagem, ignorando a idade", () => {
		const backups = criarBackups(raiz);
		const authRoot = join(backups, "auth");
		mkdirSync(authRoot, { recursive: true });
		const copias = [nomeAuth(45), nomeAuth(40), nomeAuth(35), nomeAuth(1)];
		for (const dir of copias) mkdirSync(join(authRoot, dir));
		mkdirSync(join(authRoot, "pasta-x"));

		const saida = rodar(raiz);
		const restantes = readdirSync(authRoot);

		expect(restantes).toContain(copias[1]);
		expect(restantes).toContain(copias[2]);
		expect(restantes).toContain(copias[3]);
		expect(restantes).not.toContain(copias[0]);
		expect(restantes).toContain("pasta-x");
		expect(restantes).toHaveLength(4);
		expect(contar(saida, "auth_rotacionado")).toBe(1);
	}, 30_000);
});
