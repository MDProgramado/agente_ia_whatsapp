/**
 * Fonte de leads HTTP — o **único** arquivo do projeto que faz `fetch` (Task 2,
 * passo 3). O importador de banco não conhece esta classe: ele fala com
 * `LeadSourcePort`, e a rede fica atrás desta fronteira.
 *
 * Retry: **só 429 e 5xx**, com backoff exponencial e teto de 3 tentativas. 4xx
 * (exceto 429) NÃO é retryável — a requisição não vai mudar na terceira tentativa,
 * e insistir só gasta cota. Timeout de 10s via `AbortSignal.timeout`, para que uma
 * fonte pendurada não segure o importador indefinidamente.
 */
import type { Lead, LeadSourcePort } from "../domain/ports/LeadSourcePort.js";
import { childLogger } from "./logger.js";

const log = childLogger("lead_source_http");

/** 1 original + 2 retries. Igual ao adaptador de canal, por simetria de comportamento. */
export const TENTATIVAS_MAX = 3;
const TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;

const dormirPadrao = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

export interface HttpLeadSourceOpts {
	/** Base da API do caça-leads, sem barra final. */
	readonly baseUrl: string;
	/** Token de autenticação, quando a fonte exigir. */
	readonly token?: string;
	/** Injeção para teste; default usa o `fetch` global do Node 24. */
	readonly fetchImpl?: typeof fetch;
	/** Injeção para teste; default usa `setTimeout`. */
	readonly dormir?: (ms: number) => Promise<void>;
	readonly timeoutMs?: number;
}

const drena = (resposta: Response): void => {
	// Consome o corpo para liberar o socket; nunca propaga o conteúdo no erro.
	void resposta.text().catch(() => undefined);
};

export class HttpLeadSourceAdapter implements LeadSourcePort {
	private readonly baseUrl: string;
	private readonly token: string | undefined;
	private readonly fetchImpl: typeof fetch;
	private readonly dormir: (ms: number) => Promise<void>;
	private readonly timeoutMs: number;

	constructor(opts: HttpLeadSourceOpts) {
		this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
		this.token = opts.token;
		this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
		this.dormir = opts.dormir ?? dormirPadrao;
		this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
	}

	private headers(): Record<string, string> {
		const h: Record<string, string> = { accept: "application/json" };
		if (this.token) h.authorization = `Bearer ${this.token}`;
		return h;
	}

	/**
	 * GET com retry só em 429/5xx. Cada tentativa tem `AbortSignal.timeout` próprio
	 * (um sinal compartilhado expiraria para todas).
	 */
	private async getJson<T>(caminho: string): Promise<T> {
		let ultimoErro: unknown = null;
		for (let tentativa = 1; tentativa <= TENTATIVAS_MAX; tentativa++) {
			try {
				const resposta = await this.fetchImpl(`${this.baseUrl}${caminho}`, {
					method: "GET",
					headers: this.headers(),
					signal: AbortSignal.timeout(this.timeoutMs),
				});

				if (resposta.ok) {
					return (await resposta.json()) as T;
				}

				const retryavel = resposta.status === 429 || resposta.status >= 500;
				drena(resposta);

				if (retryavel && tentativa < TENTATIVAS_MAX) {
					const backoff = BACKOFF_BASE_MS * 2 ** (tentativa - 1);
					log.warn(
						{
							event: "lead_source_retry",
							caminho,
							status: resposta.status,
							tentativa,
							backoff_ms: backoff,
						},
						"retry transitorio (429/5xx apenas)",
					);
					await this.dormir(backoff);
					continue;
				}

				// 4xx (e 429/5xx esgotado): sem retry.
				throw new Error(
					`lead_source_http: GET ${caminho} devolveu HTTP ${resposta.status}`,
				);
			} catch (erro) {
				ultimoErro = erro;
				// Erro de rede/timeout: também é transitório, mas só retenta se houver
				// tentativa sobrando — o teto é o mesmo, sem loop infinito.
				if (tentativa < TENTATIVAS_MAX) {
					const backoff = BACKOFF_BASE_MS * 2 ** (tentativa - 1);
					await this.dormir(backoff);
					continue;
				}
				throw erro;
			}
		}
		throw ultimoErro instanceof Error
			? ultimoErro
			: new Error("lead_source_http: tentativas esgotadas");
	}

	async fetchNewLeads(): Promise<Lead[]> {
		const corpo = await this.getJson<{ leads?: Lead[] }>("/leads");
		return corpo.leads ?? [];
	}

	async markValidNewLead(e164: string): Promise<void> {
		const resposta = await this.fetchImpl(`${this.baseUrl}/leads/validar`, {
			method: "POST",
			headers: { ...this.headers(), "content-type": "application/json" },
			body: JSON.stringify({ phone: e164 }),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!resposta.ok) {
			drena(resposta);
			throw new Error(
				`lead_source_http: POST /leads/validar devolveu HTTP ${resposta.status}`,
			);
		}
		drena(resposta);
	}

	async fetchNewChatMessageCap(): Promise<number | null> {
		const corpo = await this.getJson<{ new_chat_message_cap?: number | null }>(
			"/conta/cap",
		);
		return typeof corpo.new_chat_message_cap === "number"
			? corpo.new_chat_message_cap
			: null;
	}

	async fetchAccountReachoutTimelock(): Promise<Date | null> {
		const corpo = await this.getJson<{
			reachout_timelock_until?: string | null;
		}>("/conta/reachout-timelock");
		const iso = corpo.reachout_timelock_until;
		if (!iso) return null;
		const quando = new Date(iso);
		return Number.isNaN(quando.getTime()) ? null : quando;
	}
}
