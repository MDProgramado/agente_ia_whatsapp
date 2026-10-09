/**
 * Fila por lead (R-067) — uma fila de **um** consumidor por lead.
 *
 * ## Por que por lead, e não uma fila global
 *
 * O objetivo é "nunca dois envios simultâneos para o MESMO lead" — o padrão de
 * cadência de máquina que derruba número. Uma fila global com `concurrency: 1`
 * também evitaria isso, mas serializaria **todos** os leads: um lead lento
 * (envio de rede travando) atrasaria o dreno inteiro. Por lead, o *enviar* de um
 * lead nunca cruza o de outro, e leads distintos seguem em paralelo.
 *
 * ## Por que o teto do `Map`
 *
 * O `Map` cresce com o número de leads já vistos. Um teto com despejo das filas
 * **ociosas mais antigas** mantém a memória limitada sem nunca tirar uma fila que
 * ainda tem trabalho. Nota: `PQueue.size` é "aguardando" e `PQueue.pending` é
 * "executando"; só despejamos quando os dois são zero.
 *
 * Este módulo **não** importa `ChannelPort` nem contém `sendText`: ele só
 * agenda. Quem envia é o dispatcher (choke-point único).
 */
import PQueue from "p-queue";

export interface PerLeadQueue {
	/** Executa `task` na fila do `leadId`, serializando com as demais do mesmo lead. */
	run<T>(leadId: string, task: () => Promise<T>): Promise<T>;
	/** Quantas filas (leads) o `Map` guarda agora — para o teste do teto. */
	readonly size: number;
}

export interface FilaPorLeadOpts {
	/** Padrão 1: um envio por vez, por lead. */
	readonly concurrency?: number;
	/** Padrão 5000 leads. */
	readonly maxLeads?: number;
	/** Observabilidade do despejo (opcional). */
	readonly onEvict?: (leadId: string) => void;
}

interface Entrada {
	readonly fila: PQueue;
	/** Ordem de uso monotônica: a menor é a mais ociosa. */
	ultimoUso: number;
}

export const createPerLeadQueue = (
	opts: FilaPorLeadOpts = {},
): PerLeadQueue => {
	const concurrency = opts.concurrency ?? 1;
	const maxLeads = opts.maxLeads ?? 5_000;
	const filas = new Map<string, Entrada>();
	let relogio = 0;

	/**
	 * Despeja, enquanto houver excesso, a fila **ociosa** usada há mais tempo. Se
	 * todas as excedentes estiverem ocupadas, para — nunca se tira uma fila que
	 * ainda tem trabalho (perderia a serialização).
	 */
	const despejar = (): void => {
		while (filas.size > maxLeads) {
			let candidato: string | undefined;
			let menorUso = Number.POSITIVE_INFINITY;
			for (const [leadId, entrada] of filas) {
				const ociosa = entrada.fila.size === 0 && entrada.fila.pending === 0;
				if (ociosa && entrada.ultimoUso < menorUso) {
					menorUso = entrada.ultimoUso;
					candidato = leadId;
				}
			}
			if (candidato === undefined) return;
			filas.delete(candidato);
			opts.onEvict?.(candidato);
		}
	};

	return {
		run<T>(leadId: string, task: () => Promise<T>): Promise<T> {
			let entrada = filas.get(leadId);
			if (!entrada) {
				entrada = { fila: new PQueue({ concurrency }), ultimoUso: 0 };
				filas.set(leadId, entrada);
			}
			relogio += 1;
			entrada.ultimoUso = relogio;
			despejar();
			return entrada.fila.add(task) as Promise<T>;
		},

		get size(): number {
			return filas.size;
		},
	};
};
