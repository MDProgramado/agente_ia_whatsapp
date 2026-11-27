import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("KILL_SWITCH (R-042)", () => {
	it("hard-stop: boot encerra sem abrir banco, painel ou canal", async () => {
		const raiz = mkdtempSync(join(tmpdir(), "kill-switch-"));
		try {
			const resultado = await new Promise<{
				codigo: number | null;
				saida: string;
			}>((resolvePromise, reject) => {
				const filho = spawn(
					process.execPath,
					["--import", "tsx", resolve(process.cwd(), "src/index.ts")],
					{
						cwd: process.cwd(),
						env: {
							...process.env,
							KILL_SWITCH: "1",
							DATA_ROOT: raiz,
							DATABASE_URL: "postgres://kill:kill@127.0.0.1:1/kill_switch",
							CHANNEL_PHONE_E164: "+5511999999999",
							PANEL_TOKEN: "token-de-teste",
							BOOT_CHECK_ONLY: "0",
						},
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				let saida = "";
				filho.stdout.on("data", (pedaco) => {
					saida += String(pedaco);
				});
				filho.stderr.on("data", (pedaco) => {
					saida += String(pedaco);
				});
				const timer = setTimeout(() => {
					filho.kill("SIGKILL");
					reject(new Error("boot nao parou com KILL_SWITCH=1"));
				}, 90_000);
				filho.on("error", (erro) => {
					clearTimeout(timer);
					reject(erro);
				});
				filho.on("close", (codigo) => {
					clearTimeout(timer);
					resolvePromise({ codigo, saida });
				});
			});

			expect(resultado.codigo).toBe(0);
			expect(resultado.saida).toContain("KILL_SWITCH");
		} finally {
			rmSync(raiz, { recursive: true, force: true });
		}
	}, 120_000);
});
