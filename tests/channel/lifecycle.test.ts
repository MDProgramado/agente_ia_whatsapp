import { describe, expect, it, vi } from "vitest";
import {
	criarCicloVidaSocket,
	type DepsCicloVidaSocket,
	type SocketCicloVida,
} from "../../src/channel/baileys/lifecycle.js";

type Espera = {
	promise: Promise<void>;
	rejeitar: (erro: Error) => void;
};

const criarSocket = (id: string): SocketCicloVida => ({
	id,
	ev: { on: vi.fn() },
	end: vi.fn(),
});

const criarDeps = (
	overrides: Partial<DepsCicloVidaSocket> = {},
): DepsCicloVidaSocket => ({
	abrirSocket: vi.fn(async () => criarSocket("novo")),
	ligarHandlers: vi.fn(),
	aguardarAbertura: vi.fn(async () => undefined),
	trocarSocket: vi.fn(),
	dormir: vi.fn(async () => undefined),
	random: () => 0,
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
	aoAbrir: vi.fn(),
	aoTerminar: vi.fn(),
	...overrides,
});

describe("ciclo de vida do socket do canal", () => {
	it("reagenda a abertura quando esperar pelo socket falha", async () => {
		const ordem: string[] = [];
		let aberturas = 0;
		const deps = criarDeps({
			abrirSocket: vi.fn(async () => criarSocket(`socket-${++aberturas}`)),
			ligarHandlers: vi.fn(() => {
				ordem.push("handlers");
			}),
			aguardarAbertura: vi.fn(async () => {
				ordem.push("espera");
				if (aberturas === 1) throw new Error("Connection Closed");
			}),
		});
		const gestor = criarCicloVidaSocket(deps);
		gestor.registrarSocketInicial(criarSocket("inicial"));

		gestor.aoDesconectar(515, 0);

		await vi.waitFor(() => expect(deps.trocarSocket).toHaveBeenCalledTimes(1));
		expect(deps.abrirSocket).toHaveBeenCalledTimes(2);
		expect(ordem).toEqual([
			"handlers",
			"handlers",
			"espera",
			"handlers",
			"espera",
		]);
		expect(deps.dormir).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
		expect(deps.dormir).toHaveBeenCalledWith(4_000, expect.any(AbortSignal));
	});

	it("reagenda quando o socket fecha durante a espera de abertura", async () => {
		const esperas: Espera[] = [];
		const deps = criarDeps({
			abrirSocket: vi.fn(async () =>
				criarSocket(`socket-${esperas.length + 1}`),
			),
			aguardarAbertura: vi.fn(
				() =>
					new Promise<void>((_resolve, rejeitar) => {
						esperas.push({
							promise: new Promise<void>(() => undefined),
							rejeitar,
						});
					}),
			),
		});
		const gestor = criarCicloVidaSocket(deps);
		gestor.registrarSocketInicial(criarSocket("inicial"));

		gestor.aoDesconectar(408, 0);
		await vi.waitFor(() => expect(esperas).toHaveLength(1));

		gestor.aoDesconectar(428, gestor.geracao);
		await vi.waitFor(() => expect(deps.abrirSocket).toHaveBeenCalledTimes(2));
		expect(deps.dormir).toHaveBeenCalledTimes(2);
	});

	it("zera o backoff quando open chega e volta ao primeiro atraso na queda seguinte", async () => {
		const resolvers: Array<(erro?: Error) => void> = [];
		const dormir = vi.fn(async (_ms: number, _sinal: AbortSignal) => undefined);
		const deps = criarDeps({
			dormir,
			abrirSocket: vi.fn(async () =>
				criarSocket(`socket-${resolvers.length + 1}`),
			),
			aguardarAbertura: vi.fn(
				() =>
					new Promise<void>((resolve, reject) => {
						resolvers.push((erro) => (erro ? reject(erro) : resolve()));
					}),
			),
		});
		const gestor = criarCicloVidaSocket(deps);
		gestor.registrarSocketInicial(criarSocket("inicial"));

		gestor.aoDesconectar(408, 0);
		await vi.waitFor(() => expect(resolvers).toHaveLength(1));
		resolvers[0]?.(new Error("Connection Closed"));

		await vi.waitFor(() => expect(resolvers).toHaveLength(2));
		gestor.aoConectar(gestor.geracao);

		await vi.waitFor(() => expect(deps.trocarSocket).toHaveBeenCalledTimes(1));
		gestor.aoDesconectar(503, gestor.geracao);

		await vi.waitFor(() => expect(resolvers).toHaveLength(3));
		expect(dormir.mock.calls.map(([ms]) => ms)).toEqual([2_000, 4_000, 2_000]);
		expect(deps.aoAbrir).toHaveBeenCalledTimes(1);
	});

	it.each([401, 403, 500, 411, 440])(
		"nunca reconecta no status terminal %i",
		(status) => {
			const deps = criarDeps();
			const gestor = criarCicloVidaSocket(deps);
			gestor.registrarSocketInicial(criarSocket("inicial"));

			gestor.aoDesconectar(status, 0);

			expect(deps.abrirSocket).not.toHaveBeenCalled();
			expect(deps.dormir).not.toHaveBeenCalled();
			expect(deps.aoTerminar).toHaveBeenCalledTimes(1);
		},
	);

	it("ignora eventos de uma geracao antiga", async () => {
		const resolvers: Array<(erro?: Error) => void> = [];
		const deps = criarDeps({
			aguardarAbertura: vi.fn(
				() =>
					new Promise<void>((resolve, reject) => {
						resolvers.push((erro) => (erro ? reject(erro) : resolve()));
					}),
			),
		});
		const gestor = criarCicloVidaSocket(deps);
		gestor.registrarSocketInicial(criarSocket("inicial"));

		gestor.aoDesconectar(408, 0);
		await vi.waitFor(() => expect(resolvers).toHaveLength(1));

		gestor.aoDesconectar(401, 0);

		expect(deps.aoTerminar).not.toHaveBeenCalled();
		expect(deps.abrirSocket).toHaveBeenCalledTimes(1);
	});

	it("cancela a recuperação pendente quando encerrar é chamado", async () => {
		const deps = criarDeps({
			dormir: vi.fn(
				(_ms: number, sinal: AbortSignal) =>
					new Promise<void>((_resolve, rejeitar) => {
						if (sinal.aborted) {
							rejeitar(new Error("encerrado"));
							return;
						}
						sinal.addEventListener(
							"abort",
							() => rejeitar(new Error("encerrado")),
							{ once: true },
						);
					}),
			),
		});
		const gestor = criarCicloVidaSocket(deps);
		gestor.registrarSocketInicial(criarSocket("inicial"));

		gestor.aoDesconectar(408, 0);
		await vi.waitFor(() => expect(deps.dormir).toHaveBeenCalledTimes(1));

		gestor.encerrar();
		await Promise.resolve();

		expect(deps.abrirSocket).not.toHaveBeenCalled();
	});
});
