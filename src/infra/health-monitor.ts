/**
 * Monitor de sa�de (R-045, WHS-04, T-01-28).
 */
import { Cron } from "croner";
import type { NotifyPort } from "../domain/ports/NotifyPort.js";

export type BaileysState =
	| "open"
	| "close"
	| "connecting"
	| "logged_out"
	| "unknown";

export type Achado = {
	severity: "warn" | "critical";
	event: string;
	message: string;
	urgency: "low" | "high";
};

export type HealthDeps = {
	notify: NotifyPort["notify"];
	baileysState: () => BaileysState | "unknown";
	probeDb: () => Promise<void>;
	logFinding: (a: Achado) => Promise<void>;
	cronPattern: string;
	credsValid?: () => boolean;
	requestPairingCode?: () => Promise<void>;
};

export type HealthMonitor = {
	stop(): void;
	tick(): Promise<void>;
	readonly parado: boolean;
};

export function startHealthMonitor(deps: HealthDeps): HealthMonitor {
	let warned = false;
	let healthOk = true;
	let parado = false;

	const job = new Cron(deps.cronPattern, { maxRuns: Infinity }, async () => {
		if (parado) return;
		await tick();
	});

	async function tick() {
		if (parado) return;
		const state = deps.baileysState();
		if (state === "close" || state === "connecting") {
			const achado: Achado = {
				severity: "critical",
				event: "baileys_desconectado",
				message: "WhatsApp desconectado",
				urgency: "high",
			};
			await deps.logFinding(achado);
			await deps.notify({
				title: "Monitor de sa�de",
				message: achado.message,
				urgent: true,
			});
			return;
		}
		if (state === "logged_out") {
			if (
				deps.credsValid &&
				deps.credsValid() === true &&
				deps.requestPairingCode
			) {
				await deps.requestPairingCode();
				return;
			}
			const achado: Achado = {
				severity: "critical",
				event: "token_invalido",
				message: "Credenciais inv�lidas",
				urgency: "high",
			};
			await deps.logFinding(achado);
			await deps.notify({
				title: "Monitor de sa�de",
				message: achado.message,
				urgent: true,
			});
			parado = true;
			return;
		}
		try {
			await deps.probeDb();
			if (!healthOk) {
				healthOk = true;
				warned = false;
			}
		} catch {
			const achado: Achado = {
				severity: "warn",
				event: "db_down",
				message: "PostgreSQL parado",
				urgency: "low",
			};
			await deps.logFinding(achado);
			if (!warned) {
				await deps.notify({
					title: "Monitor de sa�de",
					message: achado.message,
					urgent: false,
				});
				warned = true;
				healthOk = false;
			}
			return;
		}
		warned = false;
		healthOk = true;
	}

	const monitor: HealthMonitor = {
		stop: () => job.stop(),
		tick,
		get parado() {
			return parado;
		},
	};
	return monitor;
}
