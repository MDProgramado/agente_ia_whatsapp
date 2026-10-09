/**
 * Handler de mensagem recebida — a porta de entrada do mundo real (Task 2, passo 5).
 *
 * Ordem inegociável, e o porquê de cada passo:
 *
 *  (a) Resolve o E.164 via `jid-resolver`. Não resolveu → log `jid_unresolved` e
 *      PARA. Nunca chutar o número: LID não contém telefone (Armadilha 6), e um
 *      chute manda mensagem para a pessoa errada.
 *  (b) `kind` fora de `text`/`link` é **mídia recebida** (AR-009): grava o negativo
 *      em `blocked_attempts` (`direction='in'`, `guard='ar009_midia_recebida'`,
 *      `rule_reference='AR-009'`), grava o handoff, liga
 *      `conversations.pending_media_block = true` e RETORNA. Mídia não entra em
 *      `messages` — o `CHECK kind IN ('text','link')` é a barreira estrutural, e a
 *      auditoria do bloqueio vive em `blocked_attempts` (append-only).
 *  (c) Texto/link vai para `messages` com `idempotency_key` derivada de
 *      `providerMsgId ?? (chatId + timestamp + body)` (Armadilha 7: reroll de retry
 *      do provider duplicaria a linha e inflaria a contagem).
 *  (d) **Aqui, e só aqui**, o `first_contact_by_human` vira `true` — e só quando
 *      `fromMe === true` E o `chatId` é o número dedicado. É o guard 0 do gate
 *      (R-001): o bot só admite a conversa depois que o humano mandou a primeira.
 *  (e) Upsert de `conversations` e avanço da watermark `last_processed_at`.
 */
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { childLogger } from "../infra/logger.js";
import type { Db } from "../infra/db/client.js";
import { leads } from "../infra/db/schema.js";
import {
	E164_REGEX,
	resolveE164,
} from "../channel/baileys/jid-resolver.js";
import type { EventoInbound } from "./event-bus.js";

const log = childLogger("inbound");

/** Só o que o resolver precisa do socket — sem arrastar o `WASocket` inteiro para cá. */
type SockResolucao = Parameters<typeof resolveE164>[0];

/** `db.execute` no node-postgres devolve `QueryResult`; o valor vive em `.rows`. */
const linhasDe = <T>(resultado: unknown): T[] =>
	(resultado as { rows: T[] }).rows;

interface ConversaLida {
	readonly id: string;
	readonly channel_account_id: string;
}

/**
 * Função pura do gate de `fromMe` (a mesma forma que o property test exercita).
 * Estrito maior: os `id` são estáticos e não vêm de config; só o número do canal
 * entra por parâmetro, e a igualdade é exata.
 */
export const deveMarcarPrimeiroContatoHumano = (opts: {
	readonly fromMe: boolean | null | undefined;
	readonly chatId: string;
	readonly channelPhoneE164: string;
}): boolean => {
	if (opts.fromMe !== true) return false;
	if (!opts.chatId || !opts.channelPhoneE164) return false;
	return opts.chatId === opts.channelPhoneE164;
};

const acharConversa = async (
	db: Db,
	leadId: string,
): Promise<ConversaLida | null> => {
	const resultado = await db.execute(sql`
		select id, channel_account_id
		from conversations
		where lead_id = ${leadId}
		order by created_at
		limit 1
	`);
	return linhasDe<ConversaLida>(resultado)[0] ?? null;
};

/**
 * Upsert de conversa pelo `lead_id` (uma conversa por lead). Sem conversa não há
 * onde pendurar a mensagem, e o `channel_account_id` — NOT NULL — vem da conta do
 * canal já gravada no boot.
 */
const pegarOuCriarConversa = async (
	db: Db,
	leadId: string,
): Promise<ConversaLida> => {
	const existente = await acharConversa(db, leadId);
	if (existente) return existente;

	const conta = await db.execute(sql`
		select id from channel_accounts
		where phone_e164 = ${env.CHANNEL_PHONE_E164}
	`);
	const channelAccountId = linhasDe<{ id: string }>(conta)[0]?.id;
	if (!channelAccountId) {
		throw new Error(
			"inbound-handler: channel_accounts sem a conta do canal — o boot nao rodou ou o numero dedicado mudou",
		);
	}

	const criada = await db.execute(sql`
		insert into conversations (lead_id, channel_account_id)
		values (${leadId}, ${channelAccountId})
		returning id, channel_account_id
	`);
	const nova = linhasDe<ConversaLida>(criada)[0];
	if (!nova) {
		throw new Error("inbound-handler: INSERT de conversations nao devolveu linha");
	}
	return nova;
};

/** Chave de dedup (Armadilha 7). `providerMsgId` quando existe; senão, a tripla estável. */
const chaveIdempotente = (evt: EventoInbound): string =>
	createHash("sha256")
		.update(evt.providerMsgId ?? `${evt.chatId}|${evt.timestamp}|${evt.body}`)
		.digest("hex");

/** (c) `messages` — com `on conflict do nothing` na chave idempotente. */
const gravarMensagem = async (
	db: Db,
	conversaId: string,
	evt: EventoInbound,
): Promise<void> => {
	const deMim = evt.fromMe === true;
	const kind = evt.kind === "link" ? "link" : "text";
	await db.execute(sql`
		insert into messages (
			conversation_id, direction, origin, kind, body,
			status, provider_msg_id, idempotency_key
		)
		values (
			${conversaId},
			${deMim ? "out" : "in"},
			${deMim ? "admin" : "lead"},
			${kind},
			${evt.body},
			'sent',
			${evt.providerMsgId ?? null},
			${chaveIdempotente(evt)}
		)
		on conflict (idempotency_key) do nothing
	`);
};

/** (b) Mídia recebida: negativo + handoff + `pending_media_block`, sem tocar `messages`. */
const registrarMidiaRecebida = async (
	db: Db,
	conversa: ConversaLida,
	leadId: string,
	evt: EventoInbound,
): Promise<void> => {
	const excerpt = evt.mediaType ?? "midia";
	const detalhe =
		"midia recebida: registrada e encaminhada para handoff (AR-009/R-038); " +
		"o conteudo nao e baixado nem interpretado";

	await db.execute(sql`
		insert into blocked_attempts (
			conversation_id, lead_id, direction, guard, reason_code,
			rule_reference, excerpt, detail
		)
		values (
			${conversa.id},
			${leadId},
			'in',
			'ar009_midia_recebida',
			'ar009_midia_recebida',
			'AR-009',
			${excerpt},
			${detalhe}
		)
	`);

	await db.execute(sql`
		insert into handoff_events (
			conversation_id, lead_id, channel_account_id, triggered_by,
			trigger_detail, excerpt, simultaneous_send_blocked, bot_stopped_at
		)
		values (
			${conversa.id},
			${leadId},
			${conversa.channel_account_id},
			'message_type',
			${`midia recebida (${excerpt})`},
			${excerpt},
			true,
			now()
		)
	`);

	await db.execute(sql`
		update conversations
		set pending_media_block = true
		where id = ${conversa.id}
	`);

	log.warn(
		{
			event: "inbound_midia_recebida",
			conversation_id: conversa.id,
			media_type: excerpt,
		},
		"midia recebida — negativo gravado e handoff acionado, sem download",
	);
};

/**
 * Ponto de entrada. `sock` é usado só quando o E.164 não veio pronto no evento
 * (mensagens de LID). Retorna `void`: os efeitos são as linhas no banco.
 */
export const processInboundFromMe = async (
	db: Db,
	sock: SockResolucao,
	evt: EventoInbound,
): Promise<void> => {
	// (a) E.164 — do evento quando já vier, senão resolvido do JID.
	const e164 = await resolveE164(sock, evt.phoneNumber ?? evt.chatId);
	if (!e164 || !E164_REGEX.test(e164)) {
		log.warn(
			{ event: "jid_unresolved", chat_id: evt.chatId },
			"nao deu para resolver E.164 — o fluxo para aqui; nunca chute o numero",
		);
		return;
	}

	const lead = await db.query.leads.findFirst({
		where: eq(leads.phoneNumber, e164),
		columns: { id: true, optOut: true, legalBasis: true, purpose: true },
	});
	if (!lead) {
		log.info(
			{ event: "inbound_sem_lead", chat_id: evt.chatId },
			"evento de numero sem lead cadastrado — nada a persistir",
		);
		return;
	}

	// (b) Mídia recebida: bloqueio auditável + handoff, e para (não vai a `messages`).
	const ehMidia =
		evt.isMedia === true ||
		(evt.kind !== undefined && evt.kind !== "text" && evt.kind !== "link");
	if (ehMidia) {
		const conversa = await pegarOuCriarConversa(db, lead.id);
		await registrarMidiaRecebida(db, conversa, lead.id, evt);
		return;
	}

	// (e, parte 1) conversa antes da mensagem: `messages.conversation_id` é NOT NULL/FK.
	const conversa = await pegarOuCriarConversa(db, lead.id);

	// (c) mensagem text/link com chave de dedup.
	await gravarMensagem(db, conversa.id, evt);

	// (d) O gate de `fromMe`: marcar o primeiro contato humano SÓ no número dedicado.
	if (
		deveMarcarPrimeiroContatoHumano({
			fromMe: evt.fromMe,
			chatId: evt.chatId,
			channelPhoneE164: env.CHANNEL_PHONE_E164,
		})
	) {
		// Só ATIVA (`false`→`true`); o trigger do banco barra qualquer reversão (R-024).
		await db.execute(sql`
			update leads set first_contact_by_human = true
			where phone_number = ${e164} and first_contact_by_human = false
		`);
	}

	// Opt-out vindo da fonte: só ATIVA, nunca desativa (AR-005). Ledger append-only
	// só quando o estado REALMENTE mudou, para não duplicar a prova (R-024).
	if (evt.providerOptOut === true) {
		const mudou = await db.execute(sql`
			update leads set opt_out = true
			where phone_number = ${e164} and opt_out = false
		`);
		const linhasAfetadas =
			(mudou as { rowCount?: number | null }).rowCount ?? 0;
		if (linhasAfetadas === 1) {
			await db.execute(sql`
				insert into optout_ledger (
					lead_id, event_type, source, raw_content,
					legal_basis, purpose, occurred_at
				)
				values (
					${lead.id},
					'opt_out',
					'auto_detected',
					${evt.body},
					${lead.legalBasis},
					${lead.purpose},
					now()
				)
			`);
		}
	}

	// (e) Watermark: o cursor de "até onde já processei" (R-007/T-01-11).
	await db.execute(sql`
		update conversations
		set last_inbound_at = now(), last_processed_at = now()
		where id = ${conversa.id}
	`);
};
