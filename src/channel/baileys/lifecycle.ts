import { backoffComJitter } from "./runtime.js";
import { translateDisconnect } from "./signals.js";

export interface SocketCicloVida {
	readonly id?: unknown;
	readonly ev: {
		readonly on: (
			evento: string,
			callback: (...args: unknown[]) => void,
		) => void;
	};
	readonly end?: (erro?: Error) => void;
}

export interface LogCicloVida {
	readonly info: (contexto: unknown, mensagem: string) => void;
	readonly warn: (contexto: unknown, mensagem: string) => void;
	readonly error: (contexto: unknown, mensagem: string) => void;
}

export interface DepsCicloVidaSocket {
	readonly abrirSocket: () => Promise<SocketCicloVida>;
	readonly ligarHandlers: (sock: SocketCicloVida, geracao: number) => void;
	readonly aguardarAbertura: (sock: SocketCicloVida) => Promise<void>;
	readonly trocarSocket: (sock: SocketCicloVida) => void;
	readonly dormir: (ms: number, sinal: AbortSignal) => Promise<void>;
	readonly random: () => number;
	readonly log: LogCicloVida;
	readonly aoAbrir: () => void;
	readonly aoTerminar: (motivo: string) => void;
}

export interface CicloVidaSocket {
	readonly geracao: number;
	registrarSocketInicial(sock: SocketCicloVida): void;
	aoConectar(geracao: number): void;
	aoDesconectar(status: number | null, geracao: number): void;
	encerrar(): void;
}

const fecharCandidato = (sock: SocketCicloVida | undefined): void => {
	if (!sock?.end) return;
	try {
		sock.end();
	} catch {
		return;
	}
};

export const criarCicloVidaSocket = (
	deps: DepsCicloVidaSocket,
): CicloVidaSocket => {
	const abort = new AbortController();
	let geracao = 0;
	let tentativas = 0;
	let emRecuperacao = false;
	let resolverAbertura: (() => void) | undefined;
	let rejeitarAbertura: ((erro: Error) => void) | undefined;

	const limparEspera = (): void => {
		resolverAbertura = undefined;
		rejeitarAbertura = undefined;
	};

	const abrirComHandlers = async (): Promise<SocketCicloVida> => {
		const candidato = await deps.abrirSocket();
		if (abort.signal.aborted) {
			fecharCandidato(candidato);
			throw new Error("encerrado");
		}
		geracao += 1;
		deps.ligarHandlers(candidato, geracao);
		const abertura = new Promise<void>((resolve, reject) => {
			resolverAbertura = resolve;
			rejeitarAbertura = reject;
		});
		try {
			await Promise.race([deps.aguardarAbertura(candidato), abertura]);
		} finally {
			limparEspera();
		}
		if (abort.signal.aborted) {
			fecharCandidato(candidato);
			throw new Error("encerrado");
		}
		return candidato;
	};

	const recuperar = async (
		motivo: string,
		status: number | null,
	): Promise<void> => {
		if (emRecuperacao || abort.signal.aborted) return;
		emRecuperacao = true;
		try {
			while (!abort.signal.aborted) {
				const tentativa = ++tentativas;
				const espera = backoffComJitter(tentativa, deps.random);
				deps.log.info(
					{
						step: "channel_recreate",
						motivo,
						status,
						tentativa,
						espera_ms: espera,
					},
					"reabrindo socket do canal",
				);
				try {
					await deps.dormir(espera, abort.signal);
				} catch (erro: unknown) {
					if (abort.signal.aborted) return;
					deps.log.warn(
						{
							step: "channel_recreate",
							motivo,
							tentativa,
							err: erro instanceof Error ? erro.message : String(erro),
						},
						"backoff interrompido; agendando proxima tentativa",
					);
					continue;
				}
				if (abort.signal.aborted) return;
				try {
					const candidato = await abrirComHandlers();
					deps.trocarSocket(candidato);
					deps.log.info(
						{ step: "channel_recreated", motivo, tentativa },
						"socket recriado com sucesso",
					);
					return;
				} catch (erro: unknown) {
					if (abort.signal.aborted) return;
					deps.log.warn(
						{
							step: "channel_recreate",
							motivo,
							tentativa,
							err: erro instanceof Error ? erro.message : String(erro),
						},
						"tentativa de reabertura falhou; agendando proxima",
					);
				}
			}
		} finally {
			emRecuperacao = false;
		}
	};

	return {
		get geracao() {
			return geracao;
		},
		registrarSocketInicial(sock) {
			geracao = 0;
			tentativas = 0;
			deps.ligarHandlers(sock, geracao);
		},
		aoConectar(g) {
			if (g !== geracao || abort.signal.aborted) return;
			tentativas = 0;
			deps.aoAbrir();
			resolverAbertura?.();
		},
		aoDesconectar(status, g) {
			if (g !== geracao || abort.signal.aborted) return;
			const sinal = translateDisconnect(status ?? 0);
			deps.log.warn(
				{
					step: "channel_disconnected",
					sinal: sinal.event,
					terminal: sinal.terminal,
					retry: sinal.retry,
					severity: sinal.severity,
				},
				"socket do canal caiu",
			);
			if (rejeitarAbertura && sinal.retry) {
				rejeitarAbertura(
					new Error(`socket fechou durante a abertura (${sinal.event})`),
				);
				return;
			}
			if (rejeitarAbertura && sinal.terminal) {
				rejeitarAbertura(
					new Error(`socket fechou na abertura (${sinal.event})`),
				);
			}
			if (sinal.retry) {
				void recuperar(sinal.event, status);
				return;
			}
			if (sinal.terminal) {
				deps.aoTerminar(sinal.event);
			}
		},
		encerrar() {
			abort.abort();
			rejeitarAbertura?.(new Error("encerrado"));
			limparEspera();
		},
	};
};
