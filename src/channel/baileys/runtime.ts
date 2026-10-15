/**
 * Runtime do canal — a **única** fábrica de socket e o único ponto que toca o
 * `makeWASocket`/`requestPairingCode`. Existe porque `src/index.ts` NÃO pode
 * importar `@whiskeysockets/baileys` (T-01-12: o SDK de protocolo fica confinado
 * em `src/channel/baileys/**`, verificado por `noRestrictedImports` e pelo gate
 * `grep -rl '@whiskeysockets/baileys' src | grep -v '^src/channel/'`).
 *
 * Aqui mora também a normalização `WAMessage → EventoInbound` (T-01-06): o
 * `idempotency_key` do handler deriva de `provider_msg_id` quando existe, então
 * extrair `key.id` aqui é o que torna a dedup possível. Mídia é DETECTADA, nunca
 * baixada (AR-009/R-038) — nenhuma função de download de mídia é importada em
 * lugar nenhum do projeto.
 *
 * Desde o 02-04 (CR-01) a normalização também CARIMBA o emissor E.164
 * (`senderPhoneE164`): num evento `fromMe` o `remoteJid` é o JID do LEAD (o
 * destinatário), nunca o emissor — o emissor é o próprio socket dedicado
 * (`canalSelfJid`, derivado de `sock.user.id`). Sem esse carimbo, o Gate 0
 * compara o número errado e nunca libera o outbound (R-001/CONV-01).
 */
import {
	type BaileysEventMap,
	makeWASocket,
	type WAMessage,
	type WASocket,
} from "@whiskeysockets/baileys";
import type { EventoInbound } from "../../application/event-bus.js";
import { childLogger } from "../../infra/logger.js";
import { normalizeJid } from "./jid-resolver.js";
import { type SessionState, socketConfigOverrides } from "./session.js";
import { statusHttpDoErro } from "./signals.js";

/** Payloads de evento direto do `BaileysEventMap` — sem tipar à mão e errar. */
export type UpdateConexao = BaileysEventMap["connection.update"];
export type UpsertMensagens = BaileysEventMap["messages.upsert"];

/** Tipos de mídia reconhecidos como RECEBIDA (AR-009). O conteúdo nunca é lido. */
const TIPOS_MIDIA = [
	"imageMessage",
	"videoMessage",
	"audioMessage",
	"documentMessage",
	"stickerMessage",
] as const;

/**
 * Abre o socket com `emitOwnEvents: true` e logger de debug (via
 * `socketConfigOverrides`, WHS-05/R-001). NÃO conecta sozinho: quem espera
 * `connection === 'open'` é o `index.ts`.
 */
export const abrirSocketDoCanal = (session: SessionState): WASocket => {
	const logger = childLogger("baileys_socket");
	return makeWASocket({
		auth: session.authState,
		...socketConfigOverrides(logger),
	});
};

/**
 * Espera o WebSocket do canal ABRIR antes de mandar qualquer nó de handshake.
 *
 * Existe por causa do P-004. `requestPairingCode` é chamado logo depois de
 * `abrirSocketDoCanal`, quando o socket ainda está `CONNECTING`. O `sendRawMessage`
 * do Baileys lança `Boom('Connection Closed')` sempre que `ws.isOpen` é falso
 * (`Socket/socket.js:59-61`) — ele NÃO espera o open. Como `requestPairingCode`
 * gasta ~240 ms no PBKDF2 de `generatePairingKey` (`Utils/crypto.js:112`) antes de
 * enviar, o handshake de rede tinha exatamente essa janela para completar; quando
 * perdia a corrida (rede fria ou máquina sob carga), o boot morria no throw — que
 * `main().catch` só imprimia no console.
 *
 * `waitForSocketOpen` é API pública do socket (`Socket/socket.d.ts:33`): resolve
 * imediatamente se o socket já está aberto (reconexão), rejeita se fechou, e aqui
 * ganha um timeout como backstop para uma rede que nunca completa o handshake.
 */
export const aguardarSocketAberto = async (
	sock: WASocket,
	timeoutMs: number,
): Promise<void> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			sock.waitForSocketOpen(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`socket do canal nao abriu em ${timeoutMs}ms (timeout de pareamento)`,
							),
						),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

/** `messageTimestamp` pode vir como number ou Long; normaliza para number. */
const comoNumero = (valor: unknown): number => {
	if (typeof valor === "number") return valor;
	if (
		valor &&
		typeof (valor as { toNumber?: () => number }).toNumber === "function"
	) {
		return (valor as { toNumber: () => number }).toNumber();
	}
	return Number(valor ?? 0);
};

/** Devolve o nome do campo de mídia presente, ou `null` (texto). */
const midiaDe = (
	conteudo: NonNullable<WAMessage["message"]>,
): string | null => {
	for (const tipo of TIPOS_MIDIA) {
		if (conteudo[tipo]) return tipo;
	}
	return null;
};

/**
 * Normaliza uma `WAMessage` para `EventoInbound`. Devolve `null` para eventos sem
 * conteúdo acionável (recibo, reaction, protocolo): persistir isso encheria
 * `messages` de linhas que não são conversa.
 *
 * `kind: 'text'` sempre — quem separa texto de mídia é `isMedia`. Uma mensagem
 * de mídia com legenda ainda é mídia (AR-009), então o texto da legenda NÃO é
 * enviado como corpo.
 *
 * `canalSelfJid` é o JID do número dedicado (`sock.user.id`). Só ele é o emissor
 * quando `fromMe === true`; quando `fromMe` é falso/null, o emissor é o par
 * (`chatId`). O E.164 sai de `normalizeJid` — nunca chutado. `canalSelfJid`
 * ausente ou em forma LID → `senderPhoneE164: undefined` (fail-closed, R-001).
 */
export const criarEventoInbound = (
	m: WAMessage,
	canalSelfJid?: string,
): EventoInbound | null => {
	const chatId = m.key.remoteJid;
	const conteudo = m.message;
	if (!chatId || !conteudo) return null;

	const midia = midiaDe(conteudo);
	const textoBruto =
		conteudo.conversation ?? conteudo.extendedTextMessage?.text ?? undefined;

	if (midia === null && textoBruto === undefined) return null;

	const fromMe = m.key.fromMe ?? undefined;
	const senderPhoneE164 =
		fromMe === true
			? canalSelfJid
				? normalizeJid(canalSelfJid).e164
				: undefined
			: normalizeJid(chatId).e164;

	return {
		fromMe,
		chatId,
		body: midia === null ? (textoBruto ?? "") : "",
		kind: "text",
		providerMsgId: m.key.id ?? undefined,
		timestamp: comoNumero(m.messageTimestamp),
		senderPhoneE164,
		isMedia: midia !== null,
		mediaType: midia,
	};
};

export interface DepsHandlersCanal {
	/** `connection === 'open'`: hora de ler capabilities (cap/timelock). */
	readonly aoConectar: () => void;
	/** `connection === 'close'`: status do socket já extraído (401/403/…). */
	readonly aoDesconectar: (status: number | null) => void;
	/** Um `EventoInbound` por mensagem acionável. */
	readonly aoEventoInbound: (evt: EventoInbound) => void;
	/**
	 * Getter do JID próprio (`() => sock.user?.id`): `sock.user` só existe após o
	 * registro, então o valor precisa ser reavaliado por mensagem, não capturado
	 * no boot. Ausente → sem carimbo de emissor em `fromMe` (fail-closed).
	 */
	readonly canalSelfJid?: () => string | undefined;
}

/**
 * Cria os dois handlers que o `index.ts` registra no `sock.ev`. Devolve funções
 * nomeadas para que o boot as registre explicitamente — e para que
 * `onBaileysConnectionUpdate`/`onBaileysMessage` existam por nome no arquivo de
 * boot, conforme o contrato do checkpoint de pareamento.
 */
export const criarHandlersDoCanal = (deps: DepsHandlersCanal) => {
	const onBaileysConnectionUpdate = (update: UpdateConexao): void => {
		if (update.connection === "open") {
			deps.aoConectar();
			return;
		}
		if (update.connection === "close") {
			deps.aoDesconectar(statusHttpDoErro(update.lastDisconnect?.error));
		}
	};

	const onBaileysMessage = (upsert: UpsertMensagens): void => {
		for (const mensagem of upsert.messages) {
			const evt = criarEventoInbound(mensagem, deps.canalSelfJid?.());
			if (evt) deps.aoEventoInbound(evt);
		}
	};

	return { onBaileysConnectionUpdate, onBaileysMessage };
};

/**
 * `requestPairingCode` NÃO é chamado aqui: quem pede o par é o `index.ts`, no
 * ponto do boot em que já tem o socket e a sessão em mãos — e escreve o código
 * só em `qr.txt` (arquivo sob `DATA_ROOT`, fora do OneDrive e do git), nunca no
 * log. Este arquivo termina na fábrica, nos handlers e no helper de abertura
 * `aguardarSocketAberto` (P-004), que o `index.ts` chama ANTES de pedir o par.
 */

export type { WASocket };
