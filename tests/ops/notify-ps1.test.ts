/**
 * Teste ESTÁTICO de `scripts/notify.ps1` (R-013, D-07).
 *
 * O comportamento dinâmico (toast real, som, AUMID) foi verificado por humano
 * no 01-01, task 6. O que este teste impede é a REGRESSÃO silenciosa: trocar o
 * token `PKEY_AppUserModel_ID` por string vazia, remover o `Add-Content`,
 * quebrar o `-LogOnly` — nada disso aparece no Windows se ninguém rodar o
 * script, e um teste estático falha no CI.
 *
 * Nota de grafia: o plano verifica `AppUserModelId`; o script verificado em
 * 01-01 grava `PKEY_AppUserModel_ID` (property store) e
 * `System.AppUserModel.ID` — o mecanismo é o mesmo, os tokens literais não
 * coincidem. O teste exige o token REAL (ver desvios no SUMMARY).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(resolve("scripts/notify.ps1"), "utf8");

describe("notify.ps1 — tokens estáticos (R-013)", () => {
	it("registra AppUserModelID via PKEY_AppUserModel_ID e emite com CreateToastNotifier", () => {
		expect(script).toContain("PKEY_AppUserModel_ID");
		expect(script).toContain("System.AppUserModel.ID");
		expect(script).toContain("CreateToastNotifier");
	});

	it("toca som do sistema antes do toast (sinal mais difícil de descartar)", () => {
		expect(script).toContain("SystemSounds");
	});

	it("grava log em APPEND e nunca o título (R-064)", () => {
		expect(script).toContain("Add-Content");
		expect(script).toContain("title_chars");
	});

	it("tem o switch -LogOnly e sai 0 sem emitir toast", () => {
		// O script DEFINE `[switch]$LogOnly`; o `-LogOnly` só aparece em quem o
		// invoca. O token estático que o teste exige é a definição.
		expect(script).toContain("LogOnly");
		expect(script).toContain("toast_skipped");
		expect(script).toContain("exit 0");
	});

	it("não é o node-notifier (STACK: repo sem push desde 2024)", () => {
		expect(script.toLowerCase()).not.toContain("node-notifier");
	});
});