/**
 * Guard de auth da sessão — distingue "pareamento em andamento/abandonado" de
 * "creds corrompido" (P-004, achado do 01-03-DIAG).
 *
 * `requestPairingCode` grava `creds.json` com `registered=false` e um
 * `pairingCode`. Ao abandonar a tentativa (Ctrl+C), esse arquivo fica em disco e
 * o guard antigo o lia como corrupção: o boot seguinte abortava com
 * `CREDS_INVALID` antes de qualquer nova tentativa — um pareamento abandonado
 * envenenava o boot. A classificação pura abaixo separa os três estados
 * legítimos sem tocar disco nem o pacote Baileys.
 */
import { describe, expect, it } from "vitest";
import { avaliarGuardDeAuth } from "../../src/channel/baileys/session.js";

describe("avaliarGuardDeAuth — estados de auth em disco", () => {
	it("sessão registrada (registered=true) é sempre válida", () => {
		expect(
			avaliarGuardDeAuth({
				pastaExistiaAntes: true,
				arquivosJson: 3,
				registered: true,
				pairingCode: "ABCD1234",
			}),
		).toEqual({ acao: "sessao_registrada" });
	});

	it("pasta nova (sem credenciais) pede primeiro pareamento", () => {
		expect(
			avaliarGuardDeAuth({
				pastaExistiaAntes: false,
				arquivosJson: 0,
				registered: false,
				pairingCode: undefined,
			}),
		).toEqual({
			acao: "pareamento_pendente",
			motivo: "sem credenciais em disco: primeiro pareamento",
		});
	});

	it("pasta existente porém vazia pede pareamento (não é corrupção)", () => {
		expect(
			avaliarGuardDeAuth({
				pastaExistiaAntes: true,
				arquivosJson: 0,
				registered: false,
				pairingCode: undefined,
			}),
		).toEqual({
			acao: "pareamento_pendente",
			motivo: "sem credenciais em disco: primeiro pareamento",
		});
	});

	it("creds.json com pairingCode e registered=false é pareamento em andamento (re-pareável)", () => {
		const veredicto = avaliarGuardDeAuth({
			pastaExistiaAntes: true,
			arquivosJson: 1,
			registered: false,
			pairingCode: "AB12CD34",
		});
		expect(veredicto.acao).toBe("pareamento_pendente");
	});

	it("JSON em disco, registered=false e SEM pairingCode é auth corrompido", () => {
		const veredicto = avaliarGuardDeAuth({
			pastaExistiaAntes: true,
			arquivosJson: 2,
			registered: false,
			pairingCode: undefined,
		});
		expect(veredicto.acao).toBe("corrompido");
	});

	it("pairingCode vazio não conta como pareamento em andamento", () => {
		const veredicto = avaliarGuardDeAuth({
			pastaExistiaAntes: true,
			arquivosJson: 1,
			registered: false,
			pairingCode: "",
		});
		expect(veredicto.acao).toBe("corrompido");
	});
});
