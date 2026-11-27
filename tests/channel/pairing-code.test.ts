import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	criarPedidoCodigoPorSocket,
	mensagemPareamentoInicialTerminal,
	pedirCodigoDoSocket,
	type UpdateConexao,
} from "../../src/channel/baileys/runtime.js";

type SocketDePareamento = Parameters<typeof pedirCodigoDoSocket>[0];
type Ouvinte = (update: UpdateConexao) => void;

const criarSocket = () => {
	const ouvintes: Ouvinte[] = [];
	const sock = {
		ev: {
			on: vi.fn((evento: string, callback: Ouvinte) => {
				if (evento === "connection.update") ouvintes.push(callback);
			}),
			off: vi.fn((evento: string, callback: Ouvinte) => {
				if (evento !== "connection.update") return;
				const indice = ouvintes.indexOf(callback);
				if (indice >= 0) ouvintes.splice(indice, 1);
			}),
		},
		requestPairingCode: vi.fn(async () => "AB12CD34"),
	} as unknown as SocketDePareamento & {
		requestPairingCode: ReturnType<typeof vi.fn>;
	};
	return {
		sock,
		emitir: (update: UpdateConexao) => {
			for (const ouvinte of [...ouvintes]) ouvinte(update);
		},
	};
};

describe("pareamento por codigo", () => {
	it("pede o codigo somente no primeiro connection.update com qr", async () => {
		const raiz = mkdtempSync(join(tmpdir(), "pairing-code-"));
		try {
			const destino = join(raiz, "qr.txt");
			const { sock, emitir } = criarSocket();

			const promessa = pedirCodigoDoSocket(
				sock,
				"+5511900000001",
				1_000,
				destino,
			);
			await Promise.resolve();
			emitir({ connection: "connecting", qr: undefined });
			await Promise.resolve();
			expect(sock.requestPairingCode).not.toHaveBeenCalled();

			emitir({ qr: "qr-de-teste" });
			await expect(promessa).resolves.toBe("AB12CD34");
			expect(sock.requestPairingCode).toHaveBeenCalledTimes(1);
			expect(sock.requestPairingCode).toHaveBeenCalledWith("5511900000001");
			expect(readFileSync(destino, "utf8")).toBe("AB12CD34");
		} finally {
			rmSync(raiz, { recursive: true, force: true });
		}
	});

	it("abertura sem qr nao pede codigo", async () => {
		const raiz = mkdtempSync(join(tmpdir(), "pairing-open-"));
		try {
			const { sock, emitir } = criarSocket();
			const promessa = pedirCodigoDoSocket(
				sock,
				"+5511900000001",
				1_000,
				join(raiz, "qr.txt"),
			);
			await Promise.resolve();
			emitir({ connection: "open" });
			await expect(promessa).resolves.toBeUndefined();
			expect(sock.requestPairingCode).not.toHaveBeenCalled();
		} finally {
			rmSync(raiz, { recursive: true, force: true });
		}
	});

	it("pede uma vez por socket e renova no socket reaberto", async () => {
		const pedir = vi.fn(async () => undefined);
		const pedirUmaVez = criarPedidoCodigoPorSocket(pedir);
		const primeiro = {};
		const segundo = {};

		expect(pedirUmaVez(primeiro)).toBe(true);
		expect(pedirUmaVez(primeiro)).toBe(false);
		expect(pedirUmaVez(segundo)).toBe(true);
		await vi.waitFor(() => expect(pedir).toHaveBeenCalledTimes(2));
	});

	it("terminal no pareamento inicial orienta a limpar a sessao", () => {
		expect(mensagemPareamentoInicialTerminal("logged_out")).toContain(
			"limpe auth_info_baileys e tente de novo",
		);
		expect(mensagemPareamentoInicialTerminal("forbidden")).toContain(
			"pareamento abortado (forbidden)",
		);
	});
});
