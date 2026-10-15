/**
 * `aguardarSocketAberto` — guarda da corrida `requestPairingCode` x WS open (P-004).
 *
 * `sendRawMessage` do Baileys lança `Boom('Connection Closed')` sempre que
 * `ws.isOpen` é falso (`Socket/socket.js:59-61`), sem esperar o `open`. O
 * `requestPairingCode` gasta ~240 ms no PBKDF2 de `generatePairingKey`
 * (`Utils/crypto.js:112`) antes de enviar — então o handshake de rede tem só essa
 * janela para completar. `aguardarSocketAberto` fecha a corrida esperando o open
 * (`sock.waitForSocketOpen()`, `Socket/socket.d.ts:33`) com timeout de backstop.
 *
 * Aqui o socket é um fake: só o método `waitForSocketOpen` é exercido, e o teste
 * NÃO toca o protocolo nem o número dedicado.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	aguardarSocketAberto,
	type WASocket,
} from "../../src/channel/baileys/runtime.js";

const sockCom = (waitForSocketOpen: () => Promise<void>): WASocket =>
	({ waitForSocketOpen }) as unknown as WASocket;

afterEach(() => {
	vi.useRealTimers();
});

describe("aguardarSocketAberto — corrida requestPairingCode x WS open (P-004)", () => {
	it("resolve quando o socket ja esta aberto", async () => {
		const sock = sockCom(() => Promise.resolve());
		await expect(aguardarSocketAberto(sock, 1_000)).resolves.toBeUndefined();
	});

	it("propaga a rejeicao quando o socket fecha antes de abrir", async () => {
		const sock = sockCom(() => Promise.reject(new Error("Connection Closed")));
		await expect(aguardarSocketAberto(sock, 1_000)).rejects.toThrow(
			"Connection Closed",
		);
	});

	it("rejeita com timeout quando o socket nunca abre (backstop)", async () => {
		vi.useFakeTimers();
		const sock = sockCom(() => new Promise<void>(() => {}));
		const promessa = aguardarSocketAberto(sock, 30_000);
		const assercao = expect(promessa).rejects.toThrow("nao abriu em 30000ms");
		await vi.advanceTimersByTimeAsync(30_000);
		await assercao;
	});

	it("nao deixa timer pendente quando o socket abre antes do timeout", async () => {
		vi.useFakeTimers();
		const sock = sockCom(() => Promise.resolve());
		await aguardarSocketAberto(sock, 30_000);
		expect(vi.getTimerCount()).toBe(0);
	});
});
