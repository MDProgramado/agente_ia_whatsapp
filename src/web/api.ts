/**
 * Cliente REST tipado do painel (NFRQ-05).
 *
 * Fala com o contrato CONGELADO no 03-03 (`src/api/server.ts` e as rotas). Os
 * nomes de campo abaixo são os do servidor de verdade — `mode`, `window`,
 * `counters`, `handoffQueue`, `action`/`reason`/`detail` — e não os rótulos
 * resumidos que apareciam no bloco `<interfaces>` do plano.
 *
 * Regras:
 *  - Todo request leva `Authorization: Bearer <PANEL_TOKEN>` (T-03-21: o token
 *    nunca vai na URL).
 *  - `401` → `ApiError('token_invalido')`, tratado como "token ausente/inválido"
 *    (a UI mostra uma tela de entrada), NÃO como erro genérico.
 *  - `403` → `ApiError('host_nao_permitido')`: o guard de Host do servidor só
 *    aceita `127.0.0.1`/`localhost`.
 *  - `POST /api/dispatch` NÃO lança em `blocked`/`deferred`/`silencio`: são
 *    desfechos do gate (AR-001..AR-012), não erros de transporte. O corpo é
 *    devolvido inteiro para a UI decidir o que mostrar.
 *
 * O módulo é deliberadamente livre de tipos do DOM (usa `globalThis` com cast)
 * para continuar type-checkável e testável fora do navegador.
 */

export type ApiErrorKind =
	| "sem_token"
	| "token_invalido"
	| "host_nao_permitido"
	| "rede"
	| "servidor";

export class ApiError extends Error {
	readonly kind: ApiErrorKind;
	readonly status: number;
	readonly detalhes: readonly string[];

	constructor(
		kind: ApiErrorKind,
		status: number,
		mensagem: string,
		detalhes: readonly string[] = [],
	) {
		super(mensagem);
		this.name = "ApiError";
		this.kind = kind;
		this.status = status;
		this.detalhes = detalhes;
	}
}

// ---------------------------------------------------------------------------
// Token do painel
// ---------------------------------------------------------------------------

const CHAVE_TOKEN = "painel.token";

interface Armazenamento {
	getItem(chave: string): string | null;
	setItem(chave: string, valor: string): void;
	removeItem(chave: string): void;
}

const armazenamento = (): Armazenamento | null => {
	const g = globalThis as unknown as { localStorage?: Armazenamento };
	return g.localStorage ?? null;
};

const tokenDoQuery = (): string | null => {
	const g = globalThis as unknown as { location?: { search?: string } };
	const busca = g.location?.search;
	if (busca === undefined || busca === "") return null;
	try {
		const valor = new URLSearchParams(busca).get("token");
		return valor !== null && valor !== "" ? valor : null;
	} catch {
		return null;
	}
};

let tokenEmMemoria: string | null = null;

/**
 * Define (ou limpa) o token do painel. Usado tanto pela tela de entrada quanto
 * pelo bootstrap que lê `?token=` da URL. Uma vez definido, sai da URL por
 * `limparTokenDaUrl`.
 */
export const definirToken = (token: string | null): void => {
	tokenEmMemoria = token;
	const store = armazenamento();
	if (store === null) return;
	if (token === null || token === "") store.removeItem(CHAVE_TOKEN);
	else store.setItem(CHAVE_TOKEN, token);
};

/** Token ativo: memória → localStorage → `?token=` da URL. */
export const lerToken = (): string | null => {
	if (tokenEmMemoria !== null && tokenEmMemoria !== "") return tokenEmMemoria;
	const doStore = armazenamento()?.getItem(CHAVE_TOKEN) ?? null;
	if (doStore !== null && doStore !== "") return doStore;
	return tokenDoQuery();
};

/** Remove o `?token=` da barra de endereço, mantendo o histórico limpo. */
export const limparTokenDaUrl = (): void => {
	const g = globalThis as unknown as {
		location?: { search?: string; pathname?: string; hash?: string };
		history?: {
			replaceState: (dados: unknown, titulo: string, url: string) => void;
		};
	};
	if (g.location === undefined || g.history === undefined) return;
	if (!tokenDoQuery()) return;
	const busca = new URLSearchParams(g.location.search ?? "");
	busca.delete("token");
	const query = busca.toString();
	const url = `${g.location.pathname ?? "/"}${query !== "" ? `?${query}` : ""}${g.location.hash ?? ""}`;
	g.history.replaceState(null, "", url);
};

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

const extrairMensagem = (dados: unknown, status: number): string => {
	if (typeof dados === "object" && dados !== null && "erro" in dados) {
		const erro = (dados as { erro?: unknown }).erro;
		if (typeof erro === "string" && erro !== "") return erro;
	}
	return `Falha na requisição (HTTP ${status}).`;
};

const extrairDetalhes = (dados: unknown): readonly string[] => {
	if (typeof dados !== "object" || dados === null || !("detalhes" in dados))
		return [];
	const detalhes = (dados as { detalhes?: unknown }).detalhes;
	if (!Array.isArray(detalhes)) return [];
	return detalhes.filter((d): d is string => typeof d === "string");
};

interface OpcoesRequisicao {
	/** Quando true, um status HTTP de erro 4xx/5xx devolve o corpo em vez de lançar. */
	toleranteAErroHttp: boolean;
}

const requisitar = async (
	metodo: "GET" | "POST",
	caminho: string,
	corpo: unknown,
	opcoes: OpcoesRequisicao,
): Promise<unknown> => {
	const token = lerToken();
	if (token === null) {
		throw new ApiError(
			"sem_token",
			0,
			"Token do painel ausente. Abra o painel com ?token=<PANEL_TOKEN> ou informe o token.",
		);
	}

	const cabecalhos: Record<string, string> = {
		Authorization: `Bearer ${token}`,
	};
	let corpoTexto: string | undefined;
	if (corpo !== undefined) {
		cabecalhos["Content-Type"] = "application/json";
		corpoTexto = JSON.stringify(corpo);
	}

	let resposta: Response;
	try {
		resposta = await fetch(caminho, {
			method: metodo,
			headers: cabecalhos,
			body: corpoTexto,
		});
	} catch (causa) {
		throw new ApiError(
			"rede",
			0,
			"Sem conexão com o painel. O servidor está no ar?",
			[causa instanceof Error ? causa.message : String(causa)],
		);
	}

	if (resposta.status === 401) {
		throw new ApiError(
			"token_invalido",
			401,
			"Token do painel ausente ou inválido.",
		);
	}
	if (resposta.status === 403) {
		throw new ApiError(
			"host_nao_permitido",
			403,
			"Host não permitido. Abra o painel por 127.0.0.1.",
		);
	}

	const dados: unknown = await resposta.json().catch(() => null);

	if (!resposta.ok && !opcoes.toleranteAErroHttp) {
		throw new ApiError(
			"servidor",
			resposta.status,
			extrairMensagem(dados, resposta.status),
			extrairDetalhes(dados),
		);
	}

	return dados;
};

/** GET tipado. Lança `ApiError` em token/host/rede/HTTP de erro. */
export const apiGet = <T>(caminho: string): Promise<T> =>
	requisitar("GET", caminho, undefined, {
		toleranteAErroHttp: false,
	}) as Promise<T>;

/**
 * POST tipado. Só lança em token/host/rede — qualquer status 4xx/5xx devolve o
 * corpo para a UI inspecionar (necessário para o dispatch, que responde
 * `blocked` com 409 e `deferred` com 202).
 */
export const apiPost = <T>(caminho: string, corpo: unknown): Promise<T> =>
	requisitar("POST", caminho, corpo, {
		toleranteAErroHttp: true,
	}) as Promise<T>;

// ---------------------------------------------------------------------------
// Tipos do contrato congelado (03-03)
// ---------------------------------------------------------------------------

export interface JanelaOperacional {
	aberta: boolean;
	diaUtil: boolean;
	inicio: number;
	fim: number;
	proximaAbertura: string | null;
}

export interface ContadoresDiarios {
	day: string;
	sent: number;
	sentLimit: number;
	sentCap: number;
	newContacts: number;
}

export interface ItemFilaHandoff {
	id: string;
	conversationId: string;
	leadId: string;
	leadName: string | null;
	phoneNumber: string;
	triggeredBy: string;
	triggerDetail: string | null;
	triggerValue: string | null;
	excerpt: string;
	botStoppedAt: string;
	createdAt: string;
}

export interface ResumoSistema {
	mode: "active" | "paused";
	now: string;
	window: JanelaOperacional;
	counters: ContadoresDiarios;
	handoffQueue: ItemFilaHandoff[];
}

export interface ResumoLead {
	id: string;
	name: string | null;
	phoneNumber: string;
	originSource: string;
	optOut: boolean;
	conversationId: string | null;
	state: string | null;
	engagementMode: string | null;
	handoffActive: boolean;
	lastInboundAt: string | null;
	lastOutboundAt: string | null;
}

export interface ListaLeads {
	page: number;
	pageSize: number;
	itens: ResumoLead[];
}

export interface ConversaDetalhe {
	id: string;
	state: string;
	engagementMode: string;
	stage: string | null;
	qualification: string | null;
	followUpIndex: number;
	handoffActive: boolean;
	lastInboundAt: string | null;
	lastOutboundAt: string | null;
	createdAt: string;
	lead: {
		id: string;
		name: string | null;
		phoneNumber: string;
		originSource: string;
		optOut: boolean;
	};
}

export interface Mensagem {
	id: string;
	direction: "in" | "out";
	origin: string;
	kind: string;
	body: string;
	status: string;
	authorUserId: string | null;
	createdAt: string;
}

export interface HistoricoMensagens {
	conversationId: string;
	itens: Mensagem[];
}

/**
 * Desfecho de `POST /api/dispatch`. O gate responde com um destes — a UI nunca
 * "chuta" que a mensagem saiu.
 */
export type DesfechoDispatch =
	| { action: "sent"; messageId: string }
	| { action: "deferred"; scheduledFor: string }
	| { action: "blocked"; reason: string; detail?: string }
	| { action: "silencio"; reason: string; detail?: string };

export interface ResultadoAcao {
	action: string;
	state: string;
	engagementMode: string;
}

// ---------------------------------------------------------------------------
// Endpoints nomeados (açúcar sobre apiGet/apiPost)
// ---------------------------------------------------------------------------

export const buscarResumoSistema = (): Promise<ResumoSistema> =>
	apiGet<ResumoSistema>("/api/system");

export const buscarLeads = (params: {
	q?: string;
	status?: string;
	page?: number;
	pageSize?: number;
}): Promise<ListaLeads> => {
	const busca = new URLSearchParams();
	if (params.q !== undefined && params.q !== "") busca.set("q", params.q);
	if (params.status !== undefined && params.status !== "")
		busca.set("status", params.status);
	busca.set("page", String(params.page ?? 1));
	if (params.pageSize !== undefined)
		busca.set("pageSize", String(params.pageSize));
	return apiGet<ListaLeads>(`/api/leads?${busca.toString()}`);
};

export const buscarConversa = (
	conversationId: string,
): Promise<ConversaDetalhe> =>
	apiGet<ConversaDetalhe>(
		`/api/conversations/${encodeURIComponent(conversationId)}`,
	);

export const buscarHistorico = (
	conversationId: string,
	limit?: number,
): Promise<HistoricoMensagens> =>
	apiGet<HistoricoMensagens>(
		`/api/conversations/${encodeURIComponent(conversationId)}/messages${
			limit !== undefined ? `?limit=${limit}` : ""
		}`,
	);

/** Envia texto pelo gate. NUNCA lança por `blocked`/`deferred` — devolve o desfecho. */
export const enviarMensagem = (
	conversationId: string,
	text: string,
): Promise<DesfechoDispatch> =>
	apiPost<DesfechoDispatch>("/api/dispatch", { conversationId, text });

export const acionarAcao = (
	conversationId: string,
	action: string,
): Promise<ResultadoAcao> =>
	apiPost<ResultadoAcao>(
		`/api/conversations/${encodeURIComponent(conversationId)}/actions`,
		{
			action,
		},
	);

export const acionarKillSwitch = (): Promise<{
	mode: "paused";
	from: string | null;
}> =>
	apiPost<{ mode: "paused"; from: string | null }>("/api/system/kill-switch", {
		confirm: true,
	});
