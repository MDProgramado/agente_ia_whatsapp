/**
 * Contrato de build e do cliente REST do painel (NFRQ-05, T-03-21).
 *
 * Prova três coisas de uma vez:
 *   1. o SPA compila de verdade para `dist/web` (o `@fastify/static` do 03-03
 *      serve exatamente esse diretório — sem ele, `/` devolve 404);
 *   2. `vite.config.ts` aponta para `dist/web` e NÃO usa `baseUrl` (erro duro do
 *      TS 7);
 *   3. o cliente `api.ts` fala com o contrato congelado no 03-03: manda
 *      `Authorization: Bearer`, distingue `401` (token inválido) do erro genérico
 *      e NÃO lança em `blocked`/`deferred` do dispatch (são desfechos do gate,
 *      não erros de transporte).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiGet, apiPost, definirToken } from "../../src/web/api";

/** Raiz do repositório (`tests/web/` → dois níveis acima). */
const RAIZ = fileURLToPath(new URL("../../", import.meta.url));

const lerArquivo = (relativo: string): string =>
	readFileSync(new URL(relativo, new URL("../../", import.meta.url)), "utf8");

const respostaJson = (status: number, corpo: unknown): Response =>
	new Response(JSON.stringify(corpo), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("build do SPA (dist/web)", () => {
	beforeAll(() => {
		// Compila sob demanda: o teste é a prova de que `npm run web:build`
		// produz o bundle. Rodar o build dentro do próprio teste mantém a
		// afirmação honesta mesmo num clone que nunca buildou.
		if (!existsSync(`${RAIZ}dist/web/index.html`)) {
			execSync("npm run web:build", {
				cwd: RAIZ,
				stdio: "pipe",
				shell: true,
			});
		}
	}, 180_000);

	it("gera dist/web/index.html com um <script> de entrada", () => {
		const indicePath = `${RAIZ}dist/web/index.html`;
		expect(existsSync(indicePath)).toBe(true);
		const html = readFileSync(indicePath, "utf8");
		expect(html).toContain("<script");
	});

	it("vite.config.ts emite para dist/web e não usa baseUrl", () => {
		const config = lerArquivo("vite.config.ts");
		expect(config).toContain("dist/web");
		expect(config).not.toContain("baseUrl");
	});
});

describe("cliente REST (api.ts)", () => {
	afterEach(() => {
		definirToken(null);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("apiGet envia Authorization: Bearer <token>", async () => {
		const fetchFalso = vi.fn(async () =>
			respostaJson(200, { page: 1, pageSize: 50, itens: [] }),
		);
		vi.stubGlobal("fetch", fetchFalso);
		definirToken("segredo-de-teste");

		await apiGet("/api/leads");

		expect(fetchFalso).toHaveBeenCalledTimes(1);
		const [caminho, init] = fetchFalso.mock.calls[0] as [
			string,
			{ headers: Record<string, string> },
		];
		expect(caminho).toBe("/api/leads");
		expect(init.headers.Authorization).toBe("Bearer segredo-de-teste");
	});

	it("trata 401 como token ausente/inválido (não erro genérico)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				respostaJson(401, { erro: "token ausente ou invalido" }),
			),
		);
		definirToken("token-expirado");

		await expect(apiGet("/api/leads")).rejects.toMatchObject({
			kind: "token_invalido",
			status: 401,
		});
	});

	it("apiPost de dispatch não lança em blocked (409): devolve o corpo do gate", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				respostaJson(409, {
					action: "blocked",
					reason: "ar001_preco",
					detail: "preco detectado",
				}),
			),
		);
		definirToken("segredo-de-teste");

		const resultado = await apiPost<{ action: string; reason: string }>(
			"/api/dispatch",
			{ conversationId: "c1", text: "Fica R$ 3.500" },
		);
		expect(resultado.action).toBe("blocked");
		expect(resultado.reason).toBe("ar001_preco");
	});

	it("apiPost de dispatch não lança em deferred (202)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				respostaJson(202, {
					action: "deferred",
					scheduledFor: "2026-10-17T10:00:00.000Z",
				}),
			),
		);
		definirToken("segredo-de-teste");

		const resultado = await apiPost<{ action: string }>("/api/dispatch", {
			conversationId: "c1",
			text: "bom dia",
		});
		expect(resultado.action).toBe("deferred");
	});
});
