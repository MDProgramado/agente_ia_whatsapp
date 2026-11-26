/**
 * `ChannelPort` real sobre Baileys — **somente texto** (CONV-11/AR-004).
 *
 * O que este arquivo pode fazer é tão importante quanto o que não pode:
 *
 * - **Não há envio de mídia.** `ChannelPort` não declara o método, o CHECK
 *   `messages_kind_check` (`text`,`link`) rejeita o payload no banco, e
 *   nenhuma API de download de mídia do Baileys é importada — importar seria uma
 *   API de mídia no processo (a barreira do lint em `src/channel/baileys/**` cuida do resto).
 *   R-038 é "registrar e acionar handoff", não "baixar e entender".
 * - **Retry só em 429 e 5xx**, com backoff exponencial e teto de 3 tentativas.
 *   Nenhum retry em outros 4xx e, em especial, **nenhum em 463** — o bloco do 463
 *   não contém chamada de retry nem de espera, de propósito.
 * - **463 = número inválido** (T-01-01): `markNumberInvalid` + notificação local,
 *   sem reagendamento. Número morto não recebe segunda tentativa nossa.
 *
 * `readQuota` NÃO pergunta ao WhatsApp: conta `daily_counters` do dia e usa o cap
 * lido por `capabilities.ts` (cache de 15 min — T-01-11).
 */

import type { WASocket } from "@whiskeysockets/baileys";
import { sql } from "drizzle-orm";
import { env } from "../../config/env.js";
import type { ChannelPort } from "../../domain/ports/ChannelPort.js";
import type { NotifyPort } from "../../domain/ports/NotifyPort.js";
import type { Db } from "../../infra/db/client.js";
import { childLogger } from "../../infra/logger.js";
import { readCapabilities } from "./capabilities.js";
import { jidDeEnvio } from "./jid-resolver.js";
import { translateSendError } from "./signals.js";

const log = childLogger("channel_baileys");

/** Só o que o adaptador usa do socket — e nada além disso entra no tipo. */
export type SocketDoCanal = Pick<
	WASocket,
	"sendMessage" | "fetchNewChatMessageCap" | "fetchAccountReachoutTimelock"
>;

export interface DepsCanal {
	readonly db: Db;
	readonly sock: SocketDoCanal;
	readonly notifier: NotifyPort;
	/** Espera injetável (teste); o default usa `setTimeout`. */
	readonly dormir?: (ms: number) => Promise<void>;
}

/** Teto de tentativas: 1 original + 2 retries (só 429/5xx). */
export const TENTATIVAS_MAX = 3;

/** Backoff exponencial: 1s, 2s. Sem jitter aqui — a serialização do outbox (Fase 02) é quem ritma. */
const BACKOFF_BASE_MS = 1_000;

const dormirPadrao = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/** `db.execute` devolve `QueryResult`; o valor vive em `.rows` (padrão do 01-01). */
const linhasDe = <T>(resultado: unknown): T[] =>
	(resultado as { rows: T[] }).rows;

/** `YYYY-MM-DD` no fuso do negócio — a chave de `daily_counters` (D-05). */
const diaLocal = (agora: Date): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: env.TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(agora);

export class BaileysChannel implements ChannelPort {
	private readonly db: Db;
	private sock: SocketDoCanal;
	private readonly notifier: NotifyPort;
	private readonly dormir: (ms: number) => Promise<void>;

	constructor(deps: DepsCanal) {
		this.db = deps.db;
		this.sock = deps.sock;
		this.notifier = deps.notifier;
		this.dormir = deps.dormir ?? dormirPadrao;
	}

	/**
	 * Substitui a referência do socket internamente. Usado após recriação do
	 * socket do Baileys (ex.: stream error 515 / restartRequired após pareamento).
	 * Todos os consumidores (drainLoop, dispatcher via dispatchDeps, painel) que
	 * seguram a mesma instância de BaileysChannel passam a usar o novo socket.
	 */
	setSock(sock: SocketDoCanal): void {
		this.sock = sock;
	}

	/**
	 * Envia texto para a conversa, com idempotência e retry mínimo.
	 *
	 * Idempotência é checagem PRÉVIA por `idempotency_key`: se a chave já está em
	 * `messages`, o texto já saiu e não se reenvia. O INSERT final usa `on
	 * conflict do nothing` como segunda trava — `messages` é append-only (trigger
	 * do 01-02), então `status = 'sent'` e `provider_msg_id` entram numa única
	 * gravação pós-envio; não existe UPDATE para "consertar" depois.
	 *
	 * Race aceito e documentado: duas chamadas simultâneas com a MESMA chave podem
	 * ambas enviar. O choke-point único é o `dispatcher`, que é sequencial; aqui a
	 * defesa é contra retry de caller, não contra concorrência arbitrária.
	 */
	async sendText(
		conversationId: string,
		text: string,
		idempotencyKey: string,
	): Promise<void> {
		const repetida = await this.db.execute(
			sql`select id from messages where idempotency_key = ${idempotencyKey}`,
		);
		if (linhasDe<{ id: string }>(repetida)[0]) {
			log.info(
				{
					event: "channel_send_duplicado",
					conversation_id: conversationId,
					idempotency_key: idempotencyKey,
				},
				"idempotencia: a chave ja existe em messages, nada a enviar",
			);
			return;
		}

		const alvo = await this.db.execute(sql`
			select l.phone_number
			from conversations c
			join leads l on l.id = c.lead_id
			where c.id = ${conversationId}
		`);
		const lead = linhasDe<{ phone_number: string }>(alvo)[0];
		if (!lead) {
			// O snapshot do dispatcher já filtra conversa sem lead; chegar aqui é bug.
			throw new Error(
				`sendText: conversa ${conversationId} sem lead vinculado — nada para enviar`,
			);
		}

		// Alvo derivado de `phone_number` (coluna estável), nunca de `remoteJid`
		// (reescrito pela migração PN→LID — T-01-15).
		const jid = jidDeEnvio(lead.phone_number);
		const dormir = this.dormir;

		for (let tentativa = 1; tentativa <= TENTATIVAS_MAX; tentativa++) {
			const inicio = Date.now();
			try {
				// `quoted` fica OMITIDO de propósito: resposta nunca é reply.
				const resposta = await this.sock.sendMessage(jid, { text });
				const latencyMs = Date.now() - inicio;
				const providerMsgId = resposta?.key?.id ?? null;

				await this.db.execute(sql`
					insert into messages (
						conversation_id, direction, origin, kind, body,
						status, provider_msg_id, idempotency_key, latency_ms
					)
					values (
						${conversationId}, 'out', 'bot', 'text', ${text},
						'sent', ${providerMsgId}, ${idempotencyKey}, ${latencyMs}
					)
					on conflict (idempotency_key) do nothing
				`);

				// `char_count` e id, nunca o corpo (R-043/T-01-13): o corpo pertence
				// só à tabela `messages`, que sobrevive sob controle de retenção.
				log.info(
					{
						event: "channel_send",
						conversation_id: conversationId,
						provider_msg_id: providerMsgId,
						char_count: text.length,
						latency_ms: latencyMs,
						tentativa,
					},
					"mensagem enviada",
				);
				return;
			} catch (erro) {
				const sinal = translateSendError(erro);
				const motivo = erro instanceof Error ? erro.message : String(erro);

				// (c) 463: número inválido/inacessível. Este bloco NÃO tem retry,
				// não tem espera e não tem reagendamento — marca, notifica e
				// propaga (o envio NÃO aconteceu; engolir o erro faria o dispatcher
				// registrar sucesso de um envio que falhou).
				if (sinal.reason === "invalid_number") {
					await this.markNumberInvalid(lead.phone_number, "unreachable");
					await this.notifier.notify({
						title: "Numero invalido ou inacessivel (463)",
						message: `Envio recusado na conversa ${conversationId}. Lead marcado como NUMERO_INVALIDO (LEAD-03); sem retry e sem reagendamento.`,
						urgent: true,
						sound: true,
					});
					log.error(
						{
							event: "channel_463_numero_invalido",
							conversation_id: conversationId,
							severity: sinal.severity,
						},
						"463: numero invalido — sem retry, sem reagendamento",
					);
					throw erro;
				}

				// Retry SÓ em 429/5xx (sinal.retry) e com tentativas restantes.
				if (sinal.retry && tentativa < TENTATIVAS_MAX) {
					const backoff = BACKOFF_BASE_MS * 2 ** (tentativa - 1);
					log.warn(
						{
							event: "channel_send_retry",
							conversation_id: conversationId,
							tentativa,
							backoff_ms: backoff,
							sinal: sinal.event,
						},
						"retry transitorio (429/5xx apenas)",
					);
					await dormir(backoff);
					continue;
				}

				log.error(
					{
						event: "channel_send_falhou",
						conversation_id: conversationId,
						sinal: sinal.event,
						severity: sinal.severity,
						terminal: sinal.terminal,
					},
					`envio abortado: ${motivo}`,
				);
				throw erro;
			}
		}

		// Inalcançável: cada `try` retorna ou lança. Falhar aqui em silêncio seria
		// pior que qualquer caminho acima.
		throw new Error(`sendText: esgotadas as ${TENTATIVAS_MAX} tentativas`);
	}

	/**
	 * Contagem de hoje + cap (T-01-11): nenhuma chamada de rede por invocação —
	 * `readCapabilities` tem cache de 15 min, e o SELECT é só do contador local.
	 *
	 * `cap` vindo `null` ("não sei") vira o limite de CONFIGURACAO (D-05): quem
	 * decide o teto quando o servidor não responde é o `.env`, nunca `0` por
	 * engano.
	 */
	async readQuota(today: Date): Promise<{ sent: number; cap: number }> {
		const dia = diaLocal(today);
		const contagem = await this.db.execute(
			sql`select count from daily_counters where day = ${dia} and kind = 'sent'`,
		);
		const primeira = linhasDe<{ count: number | string }>(contagem)[0];
		const sent = Number(primeira?.count ?? 0);

		const capacidades = await readCapabilities(this.sock, today);
		const cap = capacidades.newChatMessageCap ?? env.DAILY_MESSAGE_LIMIT;
		return { sent, cap };
	}

	/**
	 * Estado terminal `NUMERO_INVALIDO` (LEAD-03, R-019) + trilha de negativo.
	 *
	 * `blocked_attempts` recebe `guard = 'lead_numero_invalido'` e
	 * `rule_reference = 'R-019'` explicitamente (o trigger só deriva valores
	 * nulos, então os três campos entram escolhidos). Nenhuma dessas duas
	 * operações faz retry: o estado só muda por decisão humana.
	 */
	async markNumberInvalid(
		phoneE164: string,
		reason: "invalid" | "unreachable",
	): Promise<void> {
		const selecionado = await this.db.execute(
			sql`select id from leads where phone_number = ${phoneE164}`,
		);
		const lead = linhasDe<{ id: string }>(selecionado)[0] ?? null;

		await this.db.execute(sql`
			update leads
			set wa_validation_state = 'NUMERO_INVALIDO', wa_validated_at = now()
			where phone_number = ${phoneE164}
		`);

		const detalhe =
			reason === "unreachable"
				? "numero inacessivel no WhatsApp (463); estado terminal NUMERO_INVALIDO (LEAD-03/R-019)"
				: "numero invalido no WhatsApp; estado terminal NUMERO_INVALIDO (LEAD-03/R-019)";

		await this.db.execute(sql`
			insert into blocked_attempts (
				lead_id, conversation_id, direction, guard, reason_code,
				rule_reference, excerpt, detail
			)
			values (
				${lead?.id ?? null},
				(
					select c.id
					from conversations c
					join leads l on l.id = c.lead_id
					where l.phone_number = ${phoneE164}
					order by c.created_at
					limit 1
				),
				'out',
				'lead_numero_invalido',
				'lead_numero_invalido',
				'R-019',
				${detalhe},
				${detalhe}
			)
		`);

		// Log SEM o telefone (o E.164 é PII e o logger redigiria mesmo assim);
		// `lead_id` + origem é o que a auditoria de LEAD-03 pede (§6.5).
		log.error(
			{
				event: "numero_invalido",
				lead_id: lead?.id ?? null,
				motivo: reason,
				guard: "lead_numero_invalido",
				rule_reference: "R-019",
			},
			"numero marcado como NUMERO_INVALIDO (terminal, sem retry)",
		);
	}
}

/** Fábrica para o boot (Task 3) e para testes. */
export const criarBaileysChannel = (deps: DepsCanal): BaileysChannel =>
	new BaileysChannel(deps);
