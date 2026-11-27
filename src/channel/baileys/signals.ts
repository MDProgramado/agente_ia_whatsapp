/**
 * Tradução de sinais do Baileys em eventos nomeados (T-01-01, T-01-14).
 *
 * Duas famílias de sinal, com a mesma forma de saída:
 *
 * - `translateDisconnect(statusCode)` — o `lastDisconnect.error` do
 *   `connection.update`, ou seja, o status do SOCKET.
 * - `translateSendError(erro)` — falha de `sendMessage`, ou seja, o status do
 *   ENVIO. `retry: true` aqui significa uma coisa só: **429 e 5xx**. Todo o resto
 *   é não-retryável por construção, e 463 é o caso que não pode nem parecer que
 *   será retentado.
 *
 * O 463 (`SenderReachoutTimelocked`) NÃO é número inválido: no rc14 ele é
 * `MessageAccountRestriction` — a conta está impedida de iniciar chats novas
 * porque falta tctoken (decode-wa-message.js). Ele chega como ACK de mensagem no
 * handler interno de `messages-recv.js`, assíncrono e invisível para o
 * `sendMessage`. Duas consequências registradas aqui de propósito:
 *
 * 1. Um `try/catch` no envio esperando 463 dá falso negativo — a detecção
 *    primária é leitura de sinais (HealthMonitor), não este catch. Este catch é a
 *    rede de segurança para os caminhos em que o próprio `sendMessage` rejeita
 *    com o código.
 * 2. O que a biblioteca faz com 463 interno é EMISSÃO DE TOKEN DE PRIVACIDADE
 *    (recuperação), deduplicada por JID — **não** é reenvio. Tem cara de retry para
 *    quem lê depressa; não é. Nenhum retry nosso, nenhum reagendamento, e
 *    nenhuma marcação de lead inválido: isso pertence ao `onWhatsApp()`.
 */
import { DisconnectReason } from "@whiskeysockets/baileys";

export type EventoSinal =
	| "logged_out"
	| "rate_limited"
	| "unreachable"
	| "connection_closed"
	| "unknown";

export interface Sinal {
	readonly event: EventoSinal;
	/**
	 * true = parar. `loggedOut`/`forbidden`/401/403 exigem decisão humana
	 * deliberada; reconectar num número deslogado ou bloqueado é o pior cenário
	 * possível (T-01-14).
	 */
	readonly terminal: boolean;
	readonly severity: "critical" | "warn" | "info";
	/** true SÓ para 429 e 5xx. Nunca para 463, nunca para outros 4xx. */
	readonly retry: boolean;
	/** Presente exatamente quando o erro é restrição de reach-out da conta. */
	readonly reason?: "account_restricted";
}

/**
 * Status do socket desconhecido → não reconectar às cegas. Um loop de reconexão
 * num estado que não se entende é a forma de transformar um erro raro em ban.
 */
const DESCONHECIDO: Sinal = {
	event: "unknown",
	terminal: false,
	severity: "warn",
	retry: false,
};

/**
 * 515 (restartRequired): o servidor WhatsApp pede para reiniciar a conexão após
 * pareamento bem-sucedido. Não é terminal, mas o socket do Baileys é destruído
 * pelo end() e o app precisa recriá-lo. Após o re-pareamento, creds.me já está
 * setado (via configureSuccessfulPairing + saveCreds), então o novo socket faz
 * login (não registro) e abre normalmente.
 */
export const isRestartRequired = (status: number | null): boolean =>
	status === DisconnectReason.restartRequired;

export const isReconectavel = (status: number | null): boolean =>
	translateDisconnect(status ?? 0).retry;

/**
 * `DisconnectReason` → evento. Os literais do enum vêm do rc14
 * (`Types/index.d.ts`): 401 loggedOut, 403 forbidden, 408 connectionLost/timedOut,
 * 411 multideviceMismatch, 428 connectionClosed, 440 connectionReplaced,
 * 500 badSession, 503 unavailableService, 515 restartRequired.
 */
export const translateDisconnect = (reason: number): Sinal => {
	switch (reason) {
		// 401: a sessão foi deslogada. Só um novo pareamento DELIBERADO do Admin
		// resolve; automático aqui é exatamente a Armadilha 4.
		case DisconnectReason.loggedOut:
			return {
				event: "logged_out",
				terminal: true,
				severity: "critical",
				retry: false,
			};
		// 403: provável bloqueio da conta. Parar, não reconectar em loop (T-01-14).
		case DisconnectReason.forbidden:
			return {
				event: "unreachable",
				terminal: true,
				severity: "critical",
				retry: false,
			};
		// 500 (sessão inconsistente) e 411 (mismatch multidevice): a sessão atual
		// não serve mais — o caminho é re-parear, nunca reconectar em loop.
		case DisconnectReason.badSession:
		case DisconnectReason.multideviceMismatch:
			return {
				event: "logged_out",
				terminal: true,
				severity: "critical",
				retry: false,
			};
		// 440: outro dispositivo assumiu a conexão. Terminal LOCAL — não é erro do
		// servidor e não resolve reconectando; alguém está usando a conta agora.
		case DisconnectReason.connectionReplaced:
			return {
				event: "connection_closed",
				terminal: true,
				severity: "warn",
				retry: false,
			};
		// 408/428: queda de conexão transitória → reconectar com backoff.
		case 408:
		case 428:
			return {
				event: "connection_closed",
				terminal: false,
				severity: "info",
				retry: true,
			};
		// 429: rate limit do servidor. Rate limit reconectado com backoff agressivo
		// piora a situação — o retry aqui é com espera, nunca imediato.
		case 429:
			return {
				event: "rate_limited",
				terminal: false,
				severity: "warn",
				retry: true,
			};
		// 503/515: serviço indisponível ou restart pedido pelo servidor → volta.
		case DisconnectReason.unavailableService:
		case DisconnectReason.restartRequired:
			return {
				event: "connection_closed",
				terminal: false,
				severity: "info",
				retry: true,
			};
		default:
			return DESCONHECIDO;
	}
};

/**
 * Extrai um status HTTP do erro, quando existe em forma estruturada (Boom põe em
 * `output.statusCode`; Error genérico pode ter `statusCode`).
 *
 * O texto da mensagem só é usado para UMA coisa: detectar o `463` isolado — o
 * regex exige o número fora de uma sequência de dígitos para não casar um telefone
 * que por acaso contenha "463". Não se inventa status a partir de texto solto.
 */
export const statusHttpDoErro = (erro: unknown): number | null => {
	if (erro && typeof erro === "object") {
		const candidatos = erro as {
			output?: { statusCode?: unknown };
			statusCode?: unknown;
			status?: unknown;
		};
		for (const valor of [
			candidatos.output?.statusCode,
			candidatos.statusCode,
			candidatos.status,
		]) {
			if (typeof valor === "number" && Number.isInteger(valor)) return valor;
		}
	}
	const mensagem = erro instanceof Error ? erro.message : String(erro);
	if (/(?<!\d)463(?!\d)/.test(mensagem)) return 463;
	return null;
};

/**
 * Falha de `sendMessage` → sinal.
 *
 * - **463** → `unreachable` + `reason: 'account_restricted'`, NUNCA retry. O
 *   caminho certo é notificar o Admin: a conta não pode iniciar chats novas.
 * - **429** → `rate_limited`, retry com backoff.
 * - **401/403** → `unreachable` crítico e terminal: o envio falhou porque a CONTA
 *   está em problema, não o destinatário — parar.
 * - **5xx** → retry (transitório do servidor).
 * - **outros 4xx** → sem retry: 4xx é requisição que não vai mudar na terceira
 *   tentativa.
 * - **sem status reconhecível** → `unknown`, sem retry: classificar no escuro e
 *   insistir é como se transforma um erro raro em repetição.
 */
export const translateSendError = (erro: unknown): Sinal => {
	const status = statusHttpDoErro(erro);

	// 463: restrição de reach-out da conta (tctoken). Não transitório por decisão
	// nossa, sem retry e sem reagendamento; o lead NÃO é marcado como inválido.
	if (status === 463) {
		return {
			event: "unreachable",
			terminal: false,
			severity: "critical",
			retry: false,
			reason: "account_restricted",
		};
	}
	if (status === 429) {
		return {
			event: "rate_limited",
			terminal: false,
			severity: "warn",
			retry: true,
		};
	}
	if (status === 401 || status === 403) {
		return {
			event: "unreachable",
			terminal: true,
			severity: "critical",
			retry: false,
		};
	}
	if (status !== null && status >= 500 && status < 600) {
		return {
			event: "unreachable",
			terminal: false,
			severity: "warn",
			retry: true,
		};
	}
	if (status !== null && status >= 400 && status < 500) {
		return {
			event: "unreachable",
			terminal: false,
			severity: "warn",
			retry: false,
		};
	}
	return DESCONHECIDO;
};
