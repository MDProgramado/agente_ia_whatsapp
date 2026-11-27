import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	backoffComJitter,
	criarReferenciaSocket,
	pedirCodigoDoSocket,
	registrarPersistenciaCreds,
} from "../../src/channel/baileys/runtime.js";
import { isReconectavel } from "../../src/channel/baileys/signals.js";

type SocketComEventos = Parameters<typeof registrarPersistenciaCreds>[0];
type SocketDePareamento = Parameters<typeof pedirCodigoDoSocket>[0];

const criarSocketComEventos = (): {
	sock: SocketComEventos;
	handlers: Array<() => void>;
} => {
	const handlers: Array<() => void> = [];
	const sock = {
		ev: {
			on: (evento: string, callback: () => void) => {
				if (evento === "creds.update") handlers.push(callback);
			},
		},
	} as unknown as SocketComEventos;
	return { sock, handlers };
};

describe("Fase 0.5 — sockets do canal", () => {
	it("registra creds.update em cada socket aberto", async () => {
		const session = { saveCreds: vi.fn(async () => undefined) };
		const primeiro = criarSocketComEventos();
		const segundo = criarSocketComEventos();

		registrarPersistenciaCreds(primeiro.sock, session);
		registrarPersistenciaCreds(segundo.sock, session);

		expect(primeiro.handlers).toHaveLength(1);
		expect(segundo.handlers).toHaveLength(1);
		primeiro.handlers[0]?.();
		segundo.handlers[0]?.();
		await vi.waitFor(() => expect(session.saveCreds).toHaveBeenCalledTimes(2));
	});

	it("serializa saveCreds quando creds.update dispara em sequencia", async () => {
		const ordem: string[] = [];
		let emCurso = false;
		const session = {
			saveCreds: vi.fn(async () => {
				if (emCurso) throw new Error("saveCreds sobreposto");
				emCurso = true;
				ordem.push("inicio");
				await new Promise((resolve) => setTimeout(resolve, 10));
				ordem.push("fim");
				emCurso = false;
			}),
		};
		const { sock, handlers } = criarSocketComEventos();
		registrarPersistenciaCreds(sock, session);

		handlers[0]?.();
		handlers[0]?.();
		await vi.waitFor(() => expect(ordem).toHaveLength(4));

		expect(ordem).toEqual(["inicio", "fim", "inicio", "fim"]);
	});

	it("usa backoff exponencial com jitter e teto de 2 minutos", () => {
		expect(backoffComJitter(1, () => 0)).toBe(2_000);
		expect(backoffComJitter(2, () => 0)).toBe(4_000);
		expect(backoffComJitter(20, () => 1)).toBe(120_000);
	});

	it("mantem identidade estavel do proxy ao trocar o socket por baixo", () => {
		type Socket = Parameters<typeof criarReferenciaSocket>[0];
		const primeiro = {
			id: "primeiro",
			sendMessage(this: { id: string }) {
				return this.id;
			},
		} as unknown as Socket;
		const segundo = {
			id: "segundo",
			sendMessage(this: { id: string }) {
				return this.id;
			},
		} as unknown as Socket;
		const ref = criarReferenciaSocket(primeiro);
		const observador = ref.proxy;

		expect(
			(ref.proxy as unknown as { sendMessage(): string }).sendMessage(),
		).toBe("primeiro");
		ref.trocar(segundo);
		expect(ref.proxy).toBe(observador);
		expect(
			(observador as unknown as { sendMessage(): string }).sendMessage(),
		).toBe("segundo");
		expect((observador as unknown as { id: string }).id).toBe("segundo");
	});

	it("classifica 408/428/503/515 como reconectaveis e 401/403 como terminais", () => {
		expect(isReconectavel(408)).toBe(true);
		expect(isReconectavel(428)).toBe(true);
		expect(isReconectavel(503)).toBe(true);
		expect(isReconectavel(515)).toBe(true);
		expect(isReconectavel(401)).toBe(false);
		expect(isReconectavel(403)).toBe(false);
	});

	it("pede codigo com o numero descartavel e grava qr.txt", async () => {
		const raiz = mkdtempSync(join(tmpdir(), "pairing-"));
		try {
			const destino = join(raiz, "qr.txt");
			const sock = {
				waitForSocketOpen: vi.fn(async () => undefined),
				requestPairingCode: vi.fn(async () => "AB12CD34"),
			} as unknown as SocketDePareamento;

			const par = await pedirCodigoDoSocket(
				sock,
				"+5571982166238",
				1_000,
				destino,
			);

			expect(par).toBe("AB12CD34");
			expect(sock.requestPairingCode).toHaveBeenCalledWith("5571982166238");
			expect(readFileSync(destino, "utf8")).toBe("AB12CD34");
		} finally {
			rmSync(raiz, { recursive: true, force: true });
		}
	});
});
