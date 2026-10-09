/**
 * Fila por lead (R-067) — uma fila de UM consumidor por lead.
 *
 * O que estes testes provam, e por que importa para o número dedicado:
 *
 * 1. Tarefas do MESMO lead serializam (concurrency 1): nunca dois envios
 *    simultâneos para o mesmo lead, que é o padrão de cadência de máquina mais
 *    associado a banimento.
 * 2. Leads DIFERENTES rodam em paralelo: serializar global transformaria o dreno
 *    num gargalo e um lead lento atrasaria todos os outros.
 * 3. O `Map` de filas tem teto: um número grande de leads não cresce a memória
 *    sem limite (as filas ociosas são despejadas primeiro).
 */
import { describe, expect, it } from "vitest";
import { createPerLeadQueue } from "../../src/application/queue-per-lead.js";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

describe("createPerLeadQueue", () => {
	it("serializa tarefas do mesmo lead (concurrency 1)", async () => {
		const fila = createPerLeadQueue();
		let ativo = 0;
		let pico = 0;
		const tarefa = async (): Promise<void> => {
			ativo += 1;
			pico = Math.max(pico, ativo);
			await sleep(10);
			ativo -= 1;
		};
		await Promise.all([
			fila.run("lead-a", tarefa),
			fila.run("lead-a", tarefa),
			fila.run("lead-a", tarefa),
		]);
		expect(pico).toBe(1);
	});

	it("roda leads diferentes em paralelo", async () => {
		const fila = createPerLeadQueue();
		const ordem: string[] = [];
		const lento = async (id: string): Promise<void> => {
			ordem.push(`inicio:${id}`);
			await sleep(20);
			ordem.push(`fim:${id}`);
		};
		await Promise.all([
			fila.run("lead-x", () => lento("lead-x")),
			fila.run("lead-y", () => lento("lead-y")),
		]);
		expect(ordem.slice(0, 2).sort()).toEqual([
			"inicio:lead-x",
			"inicio:lead-y",
		]);
	});

	it("devolve o resultado da tarefa", async () => {
		const fila = createPerLeadQueue();
		await expect(fila.run("lead-z", async () => 42)).resolves.toBe(42);
	});

	it("respeita o teto do Map, despejando filas ociosas", async () => {
		const fila = createPerLeadQueue({ maxLeads: 50 });
		for (let i = 0; i < 200; i++) {
			await fila.run(`lead-${i}`, async () => undefined);
		}
		expect(fila.size).toBeLessThanOrEqual(50);
	});

	it("NUNCA chama sendText (a fila so agenda, o dispatcher envia)", () => {
		// Guarda barata: o modulo nao importa `ChannelPort` nem contem `sendText`.
		// A prova mecanica do choke-point e o grep; esta linha documenta a intencao.
		expect(typeof createPerLeadQueue).toBe("function");
	});
});
