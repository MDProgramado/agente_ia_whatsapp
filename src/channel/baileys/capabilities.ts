/**
 * Capacidades da conta no servidor (D-04, D-05, WHS-04, T-01-11).
 *
 * Duas leituras de rede — `fetchNewChatMessageCap()` e
 * `fetchAccountReachoutTimelock()` — mais a validação de wa_id com
 * `onWhatsApp()`. Regras que este arquivo materializa:
 *
 * - **Cache de 15 minutos.** São chamadas de rede; a cada mensagem elas virariam
 *   latência e um vetor de rate limit (T-01-11). O boot lê, e daí o cache governa.
 * - **Falha devolve `null`, nunca `0`.** "Não sei" (null) deixa o limite de
 *   CONFIGURACAO governar (D-05); `0` ("não pode") pararia o sistema. Os dois
 *   levam a decisões opostas, e `0` por engano é o modo de falha silencioso.
 * - **`CAPPED` devolve `0` de verdade** — aí o `0` é decisão do servidor e o
 *   `min(configured, cap)` do `reserveMessageQuota` fecha o envio.
 *
 * Divergência ADR-001 → SUMMARY do 01-03: o plano cita `processCredentials` e um
 * logger como 2º argumento de `useMultiFileAuthState`, e o rc14 não tem essas
 * assinaturas — o código instalado vence; ver `session.ts`.
 */
import {
	NewChatMessageCappingStatusType,
	type NewChatMessageCapInfo,
	type ReachoutTimelockState,
	type WASocket,
} from "@whiskeysockets/baileys";
import { childLogger } from "../../infra/logger.js";

const log = childLogger("capabilities");

export interface Capacidades {
	/**
	 * Mensagens novas que o servidor ainda permite HOJE. `null` = não sei (falha
	 * de leitura ou status sem quota); `0` = o servidor mandou parar.
	 */
	readonly newChatMessageCap: number | null;
	/** Fim da restrição de reach-out, quando ativa e com prazo conhecido. */
	readonly reachoutTimelockUntil: Date | null;
	/**
	 * false = o servidor disse que a conta está sob restrição de reach-out.
	 * Falha de leitura NÃO vira false: quem segura o envio na incerteza é o cap
	 * (null → limite de config), não um booleano que mataria a conta por um
	 * timeout de rede.
	 */
	readonly accountValid: boolean;
}

/** Só as duas leituras de rede — o tipo não arrasta o socket inteiro para os testes. */
export type SocketLeituras = Pick<
	WASocket,
	"fetchNewChatMessageCap" | "fetchAccountReachoutTimelock"
>;

/** 15 minutos (T-01-11). */
export const CACHE_CAP_MS = 15 * 60 * 1000;

let cache: { lidoEm: number; valor: Capacidades } | null = null;

/** Uso em teste: força a próxima leitura a ir à rede. */
export const invalidarCacheDeCapacidades = (): void => {
	cache = null;
};

/**
 * Deriva o cap restante do `NewChatMessageCapInfo`.
 *
 * - `CAPPED` → `0` (decisão do servidor, não "não sei").
 * - `NONE` → `null` (sem cap de servidor: só a config governa).
 * - Warnings com quotas numéricas → `max(total - used, 0)`.
 * - Qualquer coisa sem `total_quota` → `null`. Um warning sem número é "não sei",
 *   e forçar `0` a partir dele pararia o sistema sem que o servidor tivesse mandado.
 */
export const derivaCap = (
	info: NewChatMessageCapInfo | null | undefined,
): number | null => {
	if (!info) return null;
	if (info.capping_status === NewChatMessageCappingStatusType.CAPPED) return 0;
	if (info.capping_status === NewChatMessageCappingStatusType.NONE) return null;
	const { total_quota, used_quota } = info;
	if (typeof total_quota !== "number") return null;
	const usado = typeof used_quota === "number" ? used_quota : 0;
	return Math.max(total_quota - usado, 0);
};

/**
 * Lê cap e timelock com cache de 15 min. `agora` é parâmetro para o teste não
 * depender do relógio de parede; em produção o boot e o HealthMonitor mandam o
 * tempo real.
 *
 * Ambas as leituras têm `try/catch` próprio com log `cap_read_failed`: a falha de
 * uma não pode esconder a outra, e nenhuma delas pode virar `0` silencioso.
 */
export const readCapabilities = async (
	sock: SocketLeituras,
	agora: Date = new Date(),
): Promise<Capacidades> => {
	if (cache && agora.getTime() - cache.lidoEm < CACHE_CAP_MS) {
		return cache.valor;
	}

	let info: NewChatMessageCapInfo | null = null;
	let timelock: ReachoutTimelockState | null = null;
	let capLido = false;
	let timelockLido = false;

	try {
		info = await sock.fetchNewChatMessageCap();
		capLido = true;
	} catch (erro) {
		log.warn(
			{ event: "cap_read_failed", fonte: "fetchNewChatMessageCap" },
			`nao li o cap de mensagens novas: ${erro instanceof Error ? erro.message : String(erro)}`,
		);
	}

	try {
		timelock = await sock.fetchAccountReachoutTimelock();
		timelockLido = true;
	} catch (erro) {
		log.warn(
			{ event: "cap_read_failed", fonte: "fetchAccountReachoutTimelock" },
			`nao li o reachout timelock: ${erro instanceof Error ? erro.message : String(erro)}`,
		);
	}

	const cap = capLido ? derivaCap(info) : null;
	const ativo = timelockLido && timelock?.isActive === true;
	const reachoutTimelockUntil = ativo
		? (timelock?.timeEnforcementEnds ?? null)
		: null;
	if (ativo && !reachoutTimelockUntil) {
		log.warn(
			{ event: "reachout_timelock_sem_fim" },
			"reachout timelock ativo sem horario de termino — trate como restricao aberta",
		);
	}

	// Semântica de `accountValid`: false só quando o SERVIDOR disse "ativo". Uma
	// falha de leitura preserva o último valor (na ausência de histórico, true) —
	// ver doc do campo.
	const anterior = cache?.valor.accountValid ?? true;
	const accountValid = timelockLido ? !ativo : anterior;

	const valor: Capacidades = {
		newChatMessageCap: cap,
		reachoutTimelockUntil,
		accountValid,
	};
	cache = { lidoEm: agora.getTime(), valor };

	// Nomes de evento de propósito estáveis: o checkpoint de pareamento (Task 3)
	// confere `new_chat_message_cap` e `reachout_timelock_until` no app.log. Uma
	// falha NÃO emite essas linhas — só `cap_read_failed` — para o checkpoint
	// acusar a falta em vez de validar um log enganoso.
	if (capLido) {
		log.info(
			{
				event: "new_chat_message_cap",
				new_chat_message_cap: cap,
				capping_status: info?.capping_status ?? null,
			},
			"cap de mensagens novas lido",
		);
	}
	if (timelockLido) {
		log.info(
			{
				event: "reachout_timelock_until",
				reachout_timelock_until: reachoutTimelockUntil
					? reachoutTimelockUntil.toISOString()
					: null,
				account_valid: accountValid,
			},
			"reachout timelock lido",
		);
	}

	return valor;
};

export type EstadoValidacaoWa = "VALIDO" | "NUMERO_INVALIDO" | "DESCONHECIDO";

export interface ResultadoWa {
	readonly estado: EstadoValidacaoWa;
	/** JID PN devolvido pelo servidor — nunca derivado por conta própria. */
	readonly jid: string | null;
	/** O `onWhatsApp` do rc14 não aceita LID (ele próprio descarta com warn). */
	readonly lid: string | null;
}

/**
 * Valida o wa_id com `sock.onWhatsApp(e164)` (LEAD-03).
 *
 * Semântica verificada no fonte (01-PATTERNS §6.3): a implementação consulta o
 * USync e FILTRA o resultado — número inexistente não vem como `{exists:false}`,
 * ele simplesmente não vem no array. Logo:
 *
 * - array vazio / `undefined` → `NUMERO_INVALIDO` (estado terminal, LEAD-03);
 * - `exists: false` explícito → também `NUMERO_INVALIDO` (caso raro, mesmo destino);
 * - exceção (rede, timeout) → `DESCONHECIDO`, nunca `NUMERO_INVALIDO`: marcar
 *   terminal por falha de rede mataria o lead de forma irreversível por um timeout
 *   de USync. O chamador, fail-closed (§5.5), não envia com `DESCONHECIDO`.
 *
 * Cada chamada é um contato de rede: quem chama é responsável pelo cache de
 * 7 dias em `leads.wa_jid`/`leads.lid` (§6.5).
 */
export const validateWaId = async (
	sock: Pick<WASocket, "onWhatsApp">,
	e164: string,
): Promise<ResultadoWa> => {
	try {
		const resultado = await sock.onWhatsApp(e164);
		if (!resultado || resultado.length === 0) {
			return { estado: "NUMERO_INVALIDO", jid: null, lid: null };
		}
		const primeiro = resultado[0];
		if (!primeiro || primeiro.exists === false || !primeiro.jid) {
			return { estado: "NUMERO_INVALIDO", jid: null, lid: null };
		}
		return { estado: "VALIDO", jid: primeiro.jid, lid: null };
	} catch (erro) {
		log.error(
			{ event: "wa_id_validation_failed" },
			`onWhatsApp falhou (sem conclusao sobre o numero): ${erro instanceof Error ? erro.message : String(erro)}`,
		);
		return { estado: "DESCONHECIDO", jid: null, lid: null };
	}
};
