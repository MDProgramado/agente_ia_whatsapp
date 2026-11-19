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
	metodo: "GET" | "POST" | "PATCH",
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

/**
 * PATCH tipado. Mesma política do POST: 4xx/5xx devolvem o corpo para a UI
 * inspecionar (o PATCH de tarefa devolve `{erro, mensagem}` em 4xx).
 */
export const apiPatch = <T>(caminho: string, corpo: unknown): Promise<T> =>
	requisitar("PATCH", caminho, corpo, {
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
 * Detalhe de UM lead (R-046, R-064) — o contrato da gaveta de detalhe.
 *
 * É o `ResumoLead` mais o que só a rota de detalhe sabe: a data do opt-out
 * (`optOutAt`), o status do funil de vendas (`pipelineStatus`), as etiquetas
 * (`tags`) e o bloco de compliance (base legal, finalidade, registro e se o
 * primeiro contato foi humano).
 */
export interface LeadDetalhe extends ResumoLead {
	optOutAt: string | null;
	pipelineStatus: string | null;
	tags: readonly string[];
	compliance: {
		legalBasis: string | null;
		purpose: string | null;
		legalRegisteredAt: string | null;
		firstContactByHuman: boolean;
	};
}

/** Uma transição de estado registrada em `status_history` (append-only). */
export interface EntradaStatusHistorico {
	id: string;
	conversationId: string;
	fromState: string | null;
	toState: string | null;
	changedBy: string | null;
	reason: string | null;
	changedAt: string | null;
}

/** Um handoff registrado em `handoff_events` (append-only). */
export interface EventoHandoff {
	id: string;
	conversationId: string;
	leadId: string;
	triggeredBy: string;
	triggerDetail: string | null;
	triggerValue: string | null;
	excerpt: string | null;
	simultaneousSendBlocked: boolean | null;
	botStoppedAt: string | null;
	humanAcknowledgedAt: string | null;
	createdAt: string | null;
}

/** Um negativo do gate registrado em `blocked_attempts` (append-only). */
export interface TentativaBloqueada {
	id: string;
	conversationId: string | null;
	leadId: string | null;
	direction: "in" | "out";
	guard: string;
	reasonCode: string;
	ruleReference: string | null;
	excerpt: string | null;
	detail: string | null;
	blockedAt: string | null;
	createdAt: string | null;
}

/** A trilha de auditoria da conversa: as três fontes além das mensagens. */
export interface TrilhaAuditoria {
	statusHistory: readonly EntradaStatusHistorico[];
	handoffEvents: readonly EventoHandoff[];
	blockedAttempts: readonly TentativaBloqueada[];
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

/** Detalhe de um lead (R-046/R-064) — gaveta de detalhe e coluna direita. */
export const buscarLead = (leadId: string): Promise<LeadDetalhe> =>
	apiGet<LeadDetalhe>(`/api/leads/${encodeURIComponent(leadId)}`);

/**
 * Trilha de auditoria da conversa (D-23) — `status_history` + `handoff_events`
 * + `blocked_attempts`. As mensagens têm rota própria (`buscarHistorico`) e a
 * linha do tempo funde as quatro fontes.
 */
export const buscarAuditTrail = (
	conversationId: string,
): Promise<TrilhaAuditoria> =>
	apiGet<TrilhaAuditoria>(
		`/api/conversations/${encodeURIComponent(conversationId)}/audit`,
	);

/**
 * Registra o opt-out MANUAL de um lead (R-024/AR-005, T-03-42).
 *
 * O literal `OPTOUT` é exigência do SERVIDOR (`confirm` exato, case-sensitive):
 * é a prova de que o Admin digitou, e não clicou sem querer. O servidor grava
 * `optout_ledger(source='manual')` + `event_log('optout_manual')` — prova
 * dupla — e a operação é irreversível (não existe rota de reversão).
 *
 * `apiPost` NÃO lança em erro de HTTP: devolve o corpo do servidor. Por isso
 * quem chama precisa conferir `optOut === true` — um 400 devolve
 * `{erro, detalhes}` e não um opt-out.
 */
export const registrarOptOutManual = (
	leadId: string,
): Promise<{ optOut: boolean; mudou: boolean }> =>
	apiPost<{ optOut: boolean; mudou: boolean }>(
		`/api/leads/${encodeURIComponent(leadId)}/opt-out`,
		{ confirm: "OPTOUT" },
	);

// ---------------------------------------------------------------------------
// Rótulos pt-BR dos campos de compliance (R-064)
// ---------------------------------------------------------------------------
//
// A base legal e a finalidade são gravadas no banco como valores técnicos
// (`legitimo_interesse`, `contato_comercial_b2b`) e mostradas ao Admin como
// texto. A tradução mora AQUI — no módulo que define o contrato — para que a
// gaveta, a aba Compliance e a coluna direita nunca discordem do rótulo.

const ROTULO_BASE_LEGAL: Record<string, string> = {
	legitimo_interesse: "Legítimo interesse",
	consentimento: "Consentimento",
};

const ROTULO_FINALIDADE: Record<string, string> = {
	contato_comercial_b2b: "Contato comercial B2B",
	prospectacao_b2b: "Prospecção B2B",
};

/** Rótulo pt-BR da base legal; valor desconhecido passa crudo, nunca some. */
export const rotuloBaseLegal = (valor: string | null): string => {
	if (valor === null || valor === "") return "Não registrada";
	return ROTULO_BASE_LEGAL[valor] ?? valor;
};

/** Rótulo pt-BR da finalidade; valor desconhecido passa crudo, nunca some. */
export const rotuloFinalidade = (valor: string | null): string => {
	if (valor === null || valor === "") return "Não registrada";
	return ROTULO_FINALIDADE[valor] ?? valor;
};

// ---------------------------------------------------------------------------
// Eventos e Falhas do Sistema (R-045, 03-07)
// ---------------------------------------------------------------------------

export type SeveridadeEvento = "debug" | "info" | "warn" | "error" | "critical";

export interface EventoItem {
	id: string;
	eventType: string;
	entityType: string;
	entityId: string | null;
	leadId: string | null;
	conversationId: string | null;
	payload: Record<string, unknown>;
	severity: SeveridadeEvento;
	createdAt: string;
}

export interface RespostaEventos {
	page: number;
	pageSize: number;
	itens: EventoItem[];
}

export interface BuscarEventosParams {
	severity?: SeveridadeEvento;
	page?: number;
	pageSize?: number;
}

/**
 * Busca eventos estruturados de `event_log` (R-045, read-only).
 */
export const buscarEventos = (
	params: BuscarEventosParams = {},
): Promise<RespostaEventos> => {
	const qs = new URLSearchParams();
	if (params.severity) qs.set("severity", params.severity);
	if (params.page !== undefined) qs.set("page", String(params.page));
	if (params.pageSize !== undefined)
		qs.set("pageSize", String(params.pageSize));

	const query = qs.toString();
	const url = query ? `/api/system/events?${query}` : "/api/system/events";
	return apiGet<RespostaEventos>(url);
};

// ---------------------------------------------------------------------------
// Importação de Leads via Planilha (CSV)
// ---------------------------------------------------------------------------

export interface RespostaImportacaoPlanilha {
	totalNoArquivo: number;
	validosIdentificados: number;
	importadosComSucesso: number;
	duplicadosIgnorados: number;
	invalidosNoFormato: number;
	semCotaDisponivel: boolean;
	rejeitados: number;
	detalhesInvalidos: Array<{ linha: number; motivo: string; dado: unknown }>;
}

export const importarPlanilhaCsv = (
	csvConteudo: string,
	origem?: string,
): Promise<RespostaImportacaoPlanilha> =>
	apiPost<RespostaImportacaoPlanilha>("/api/leads/import-csv", {
		csv: csvConteudo,
		origin: origem,
	});
