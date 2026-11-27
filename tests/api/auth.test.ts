/**
 * Testes da borda HTTP do painel (D-18, T-03-10..T-03-12).
 *
 * Três camadas, na ordem em que a borda as aplica:
 *   1. `timingSafeEqualStr`/`requireToken` — a comparação em si (unitário);
 *   2. Host guard — `Host: evil.com` → 403 (anti-DNS-rebinding);
 *   3. Token — `/api/*` sem token → 401; com token → passa.
 *
 * `app.inject()` do Fastify: o request atravessa os hooks reais (onRequest) sem
 * abrir socket de rede — é o mesmo pipeline de produção, sem porta.
 */
import { describe, expect, it } from "vitest";
import { requireToken, timingSafeEqualStr } from "../../src/api/auth.js";
import { buildServer } from "../../src/api/server.js";
import { env } from "../../src/config/env.js";

const TOKEN = env.PANEL_TOKEN;

describe("timingSafeEqualStr", () => {
	it("iguais → true", () => {
		expect(timingSafeEqualStr("segredo", "segredo")).toBe(true);
	});

	it("diferentes (mesmo tamanho) → false", () => {
		expect(timingSafeEqualStr("segredo", "segredu")).toBe(false);
	});

	it("comprimentos diferentes → false, sem lançar", () => {
		// O `timingSafeEqual` do crypto LANÇA em buffers de tamanhos distintos;
		// a função deve interceptar antes. Se lançasse, o teste falharia com o
		// throw em vez de devolver false.
		expect(() =>
			timingSafeEqualStr("curto", "um-comprimento-bem-maior"),
		).not.toThrow();
		expect(timingSafeEqualStr("curto", "um-comprimento-bem-maior")).toBe(false);
	});

	it("string vazia vs não-vazia → false, sem lançar", () => {
		expect(timingSafeEqualStr("", "x")).toBe(false);
	});
});

describe("requireToken", () => {
	it("Bearer correto → true", () => {
		expect(requireToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
	});

	it("header ausente → false", () => {
		expect(requireToken(undefined, TOKEN)).toBe(false);
	});

	it("scheme errado → false", () => {
		expect(requireToken(`Basic ${TOKEN}`, TOKEN)).toBe(false);
		expect(requireToken(`bearer ${TOKEN}`, TOKEN)).toBe(false);
	});

	it("token divergente → false", () => {
		expect(requireToken("Bearer outro-token", TOKEN)).toBe(false);
	});
});

/** Rota mínima só para o teste de autenticação da borda (Task 2 adiciona as reais). */
const comRotaDeTeste = () => {
	const app = buildServer();
	app.get("/api/ping", async () => ({ ok: true }));
	return app;
};

describe("guarda de borda do servidor", () => {
	it("Host: evil.com → 403 (anti-DNS-rebinding)", async () => {
		const app = comRotaDeTeste();
		try {
			const res = await app.inject({
				method: "GET",
				url: "/api/ping",
				headers: { host: "evil.com", authorization: `Bearer ${TOKEN}` },
			});
			expect(res.statusCode).toBe(403);
		} finally {
			await app.close();
		}
	}, 30_000);

	it("Host: 127.0.0.1 sem token → 401", async () => {
		const app = comRotaDeTeste();
		try {
			const res = await app.inject({
				method: "GET",
				url: "/api/ping",
				headers: { host: "127.0.0.1" },
			});
			expect(res.statusCode).toBe(401);
		} finally {
			await app.close();
		}
	});

	it("caminho percent-encoded /%61pi/ping sem token → 401", async () => {
		const app = comRotaDeTeste();
		try {
			const res = await app.inject({
				method: "GET",
				url: "/%61pi/ping",
				headers: { host: "127.0.0.1" },
			});
			expect(res.statusCode).toBe(401);
		} finally {
			await app.close();
		}
	});

	it("Host: 127.0.0.1 com token → passa", async () => {
		const app = comRotaDeTeste();
		try {
			const res = await app.inject({
				method: "GET",
				url: "/api/ping",
				headers: { host: "127.0.0.1", authorization: `Bearer ${TOKEN}` },
			});
			expect(res.statusCode).toBe(200);
		} finally {
			await app.close();
		}
	});

	it("Host: localhost com token → passa (mesmo conjunto de hosts)", async () => {
		const app = comRotaDeTeste();
		try {
			const res = await app.inject({
				method: "GET",
				url: "/api/ping",
				headers: { host: "localhost:8787", authorization: `Bearer ${TOKEN}` },
			});
			expect(res.statusCode).toBe(200);
		} finally {
			await app.close();
		}
	});

	it("Host com porta host:porta inválido continua barrado (só o host importa)", async () => {
		const app = comRotaDeTeste();
		try {
			const res = await app.inject({
				method: "GET",
				url: "/api/ping",
				headers: {
					host: "evil.com:8787",
					authorization: `Bearer ${TOKEN}`,
				},
			});
			expect(res.statusCode).toBe(403);
		} finally {
			await app.close();
		}
	});
});
