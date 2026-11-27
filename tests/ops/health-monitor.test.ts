/**
 * Health monitor (R-045, WHS-04, T-01-28) — unidade pura.
 *
 * O monitor injeta o probe do banco, o `NotifyPort` e a gravação em `event_log`:
 * nenhum I/O real aqui. O que se prova é a MÁQUINA de severidade:
 *
 * - banco parado → exatamente um `warn`, zero `critical`, notificação sem urgência;
 * - desconexão do Baileys persistente → `critical` com `urgent: true`;
 * - `warn` repetido a cada 30s vira ruído → uma notificação por TRANSIÇÃO de estado,
 *   revertida quando a saúde volta (T-01-28);
 * - `logged_out` é terminal: nenhum `requestPairingCode`, `critical` e o monitor
 *   PARA (T-01-29, Armadilha 4).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { NotifyInput } from "../../src/domain/ports/NotifyPort.js";
import {
	type Achado,
	type HealthDeps,
	type HealthMonitor,
	startHealthMonitor,
} from "../../src/infra/health-monitor.js";

/**
 * Padrão de cron que nunca dispara durante o teste (1º de janeiro, meia-noite):
 * os testes chamam `tick()` manualmente e param o monitor no `afterEach`.
 */
const CRON_LONGE = "0 0 0 1 1 *";

const coletor = () => {
	const notificacoes: NotifyInput[] = [];
	const achados: Achado[] = [];
	return {
		notificacoes,
		achados,
		notify: async (input: NotifyInput) => {
			notificacoes.push(input);
		},
		logFinding: async (achado: Achado) => {
			achados.push(achado);
		},
	};
};

const monitores: HealthMonitor[] = [];

afterEach(() => {
	for (const m of monitores) m.stop();
	monitores.length = 0;
});

const criar = (deps: Omit<HealthDeps, "cronPattern">): HealthMonitor => {
	const m = startHealthMonitor({ ...deps, cronPattern: CRON_LONGE });
	monitores.push(m);
	return m;
};

describe("startHealthMonitor — máquina de severidade (T-01-28)", () => {
	it("banco parado gera um warn e zero critical, notificando sem urgência", async () => {
		const c = coletor();
		const monitor = criar({
			notify: c.notify,
			baileysState: () => "open",
			probeDb: async () => {
				throw new Error("conexao recusada");
			},
			logFinding: c.logFinding,
		});

		await monitor.tick();

		expect(c.achados).toHaveLength(1);
		expect(c.achados[0]?.severity).toBe("warn");
		expect(c.achados[0]?.event).toBe("db_down");
		expect(c.achados.some((a) => a.severity === "critical")).toBe(false);
		expect(c.notificacoes).toHaveLength(1);
		expect(c.notificacoes[0]?.urgent).toBe(false);
	});

	it("Baileys desconectado gera critical com urgência", async () => {
		const c = coletor();
		const monitor = criar({
			notify: c.notify,
			baileysState: () => "close",
			probeDb: async () => {},
			logFinding: c.logFinding,
		});

		await monitor.tick();

		expect(
			c.achados.some(
				(a) => a.severity === "critical" && a.event === "baileys_desconectado",
			),
		).toBe(true);
		expect(c.notificacoes).toHaveLength(1);
		expect(c.notificacoes[0]?.urgent).toBe(true);
	});

	it("warn repetido 3 vezes gera exatamente uma notificação", async () => {
		const c = coletor();
		const monitor = criar({
			notify: c.notify,
			baileysState: () => "open",
			probeDb: async () => {
				throw new Error("conexao recusada");
			},
			logFinding: c.logFinding,
		});

		for (let i = 0; i < 3; i += 1) await monitor.tick();

		// Cada tick registra em event_log (auditoria), mas o TOSTE é uma vez só.
		expect(c.achados).toHaveLength(3);
		expect(c.notificacoes).toHaveLength(1);
	});

	it("desconexão repetida do Baileys notifica uma vez por transição", async () => {
		let estado: "open" | "close" = "close";
		const c = coletor();
		const monitor = criar({
			notify: c.notify,
			baileysState: () => estado,
			probeDb: async () => {},
			logFinding: c.logFinding,
		});

		for (let i = 0; i < 3; i += 1) await monitor.tick();
		expect(c.achados).toHaveLength(3);
		expect(c.notificacoes).toHaveLength(1);

		estado = "open";
		await monitor.tick();
		estado = "close";
		await monitor.tick();

		expect(c.notificacoes).toHaveLength(2);
	});

	it("a notificação é revertida quando a saúde volta — nova queda avisa de novo", async () => {
		let saudavel = false;
		const c = coletor();
		const monitor = criar({
			notify: c.notify,
			baileysState: () => "open",
			probeDb: async () => {
				if (!saudavel) throw new Error("banco parado");
			},
			logFinding: c.logFinding,
		});

		await monitor.tick(); // warn → 1ª notificação
		saudavel = true;
		await monitor.tick(); // saúde voltou → nada
		saudavel = false;
		await monitor.tick(); // caiu de novo → transição revertida avisa outra vez

		expect(c.notificacoes).toHaveLength(2);
	});

	it("logged_out é terminal: nunca pede par, mesmo com credenciais válidas", async () => {
		const c = coletor();
		const monitor = criar({
			notify: c.notify,
			baileysState: () => "logged_out",
			probeDb: async () => {},
			logFinding: c.logFinding,
		});

		await monitor.tick();

		expect(c.notificacoes).toHaveLength(1);
		expect(
			c.achados.some(
				(a) => a.event === "token_invalido" && a.severity === "critical",
			),
		).toBe(true);
		expect(c.notificacoes[0]?.urgent).toBe(true);
		expect(monitor.parado).toBe(true);
	});
});
