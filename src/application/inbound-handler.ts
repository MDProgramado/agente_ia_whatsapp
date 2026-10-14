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
import { E164_REGEX, resolveE164 } from "../channel/baileys/jid-resolver.js";
import { env } from "../config/env.js";
import {
	canarioEsperado,
	type ExtractionEnvelope,
	type GenerationEnvelope,
	validaEcoCanario,
} from "../domain/llm/envelope.js";
import {
	buildExtractPrompt,
	buildGeneratePrompt,
} from "../domain/llm/prompt-builder.js";
import {
	classifyOptout,
	OptoutClass,
} from "../domain/optout/optout-matcher.js";
import {
	type Estado,
	resolveNextState,
} from "../domain/orchestrator/transitions.js";
import type { LlmPort } from "../domain/ports/LlmPort.js";
import type { NotifyPort } from "../domain/ports/NotifyPort.js";
import type { Db } from "../infra/db/client.js";
import { applyOptOut, updateQualification } from "../infra/db/queries/leads.js";
import { loadLlmContext } from "../infra/db/queries/llm-context.js";
import { recordLlmRun } from "../infra/db/queries/llm-runs.js";
import { recordStatusChange } from "../infra/db/queries/status-history.js";
import { leads } from "../infra/db/schema.js";
import { childLogger } from "../infra/logger.js";
import type { EventoInbound } from "./event-bus.js";
import { dispararHandoff, type HandoffTriggeredBy } from "./handoff-service.js";
import { type LlmRunMeta, persistDraft } from "./shadow.js";

const log = childLogger("inbound");

/**
 * Dependências opcionais do sanduíche de IA (D-08). A ausência de `llm` é o que
 * preserva o comportamento da Fase 1: sem adaptador injetado, o handler só
 * persiste a mensagem e NÃO rascunha. Testes da Fase 1 chamam com 3 argumentos e
 * continuam válidos; o boot real injeta o adaptador de produção.
 */
export interface InboundDeps {
	readonly llm?: LlmPort<ExtractionEnvelope, GenerationEnvelope>;
	readonly notifier?: NotifyPort;
	/** Instante injetado para determinismo; default `new Date()`. */
	readonly agora?: Date;
}

/** Intenções que disparam handoff (D-12) — o stub do 02-01 registra e cala. */
const INTENCOES_HANDOFF: ReadonlySet<string> = new Set([
	"pedido_preco",
	"intencao_agendar",
	"bot_suspicion",
	"irritacao",
	"ameaca",
	"pedido_optout",
	"midia_recebida",
]);

/** Só o que o resolver precisa do socket — sem arrastar o `WASocket` inteiro para cá. */
type SockResolucao = Parameters<typeof resolveE164>[0];

/** `db.execute` no node-postgres devolve `QueryResult`; o valor vive em `.rows`. */
const linhasDe = <T>(resultado: unknown): T[] =>
	(resultado as { rows: T[] }).rows;

interface ConversaLida {
	readonly id: string;
	readonly channel_account_id: string;
	/** Necessário para a Camada 2 (`resolveNextState`) e para as guardas locais. */
	readonly state: string;
	readonly engagement_mode: string;
	readonly pending_media_block: boolean;
	readonly handoff_active: boolean;
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
		select id, channel_account_id, state, engagement_mode,
			pending_media_block, handoff_active
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
		returning id, channel_account_id, state, engagement_mode,
			pending_media_block, handoff_active
	`);
	const nova = linhasDe<ConversaLida>(criada)[0];
	if (!nova) {
		throw new Error(
			"inbound-handler: INSERT de conversations nao devolveu linha",
		);
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
	deps: InboundDeps,
	agora: Date,
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

	// O handoff é UMA coisa só, e é o mesmo `dispararHandoff` do caminho de texto:
	// mídia não tem um "handoff paralelo" com metade das escritas.
	await dispararHandoff(
		db,
		{
			conversationId: conversa.id,
			reason: `midia recebida (${excerpt})`,
			triggeredBy: "message_type",
			triggerDetail: `midia recebida (${excerpt})`,
			excerpt,
			actor: "bot",
			agora,
		},
		{ notifier: deps.notifier },
	);

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
 * Versões gravadas em `llm_runs`. Comparar qualidade entre revisões exige saber
 * sob qual template e qual política a corrida aconteceu (R-045/D-05).
 */
export const PROMPT_VERSION = "02-01";
export const POLICY_VERSION = "02-01";

/** Metadado da corrida a partir do resultado do adaptador — nunca o corpo do prompt. */
const corridaDe = (
	resultado: {
		readonly ok: boolean;
		readonly usage: {
			readonly model: string;
			readonly promptTokens: number | null;
			readonly completionTokens: number | null;
			readonly latencyMs: number;
		} | null;
		readonly costUsd?: number | null;
	},
	zodParseOk: boolean,
	canaryOk: boolean,
): LlmRunMeta => ({
	model: resultado.usage?.model ?? "desconhecido",
	promptTokens: resultado.usage?.promptTokens ?? null,
	completionTokens: resultado.usage?.completionTokens ?? null,
	latencyMs: resultado.usage?.latencyMs ?? null,
	costUsd: resultado.ok ? (resultado.costUsd ?? null) : null,
	promptVersion: PROMPT_VERSION,
	policyVersion: POLICY_VERSION,
	zodParseOk,
	canaryOk,
});

/**
 * Caminho de falha-fechada (D-10): silêncio + notificação. Nunca um texto livre.
 * A notificação é best-effort (a porta não lança) — se não houver notificador
 * injetado, ainda assim o evento fica no log local.
 */
const falhaFechada = async (
	deps: InboundDeps,
	evt: EventoInbound,
	kind: string,
	detail: string,
): Promise<void> => {
	log.warn(
		{ event: "llm_falha_fechada", chat_id: evt.chatId, kind },
		`falha-fechada na IA: ${detail}`,
	);
	await deps.notifier?.notify({
		title: "IA indisponível (shadow)",
		message: `A resposta automática foi suspensa (${kind}). Nenhum texto foi enviado ao lead.`,
		urgent: false,
	});
};

/**
 * Mapeia o gatilho detectado para o `triggered_by` do schema. `pedido_optout`
 * vira `opt_out` (o CHECK tem o valor próprio), mídia vira `message_type`, e os
 * sinais de palavra-chave (preço/irritação/opt-out implícito) viram `keyword`;
 * o resto é `intent`. É a tradução do vocabulário da LLM para o vocabulário da
 * auditoria — um lugar só.
 */
const triggeredByDoGatilho = (
	intent: string,
	signals: {
		readonly pricingAsked: boolean;
		readonly irritation: boolean;
		readonly optOutIntent: boolean;
	},
): HandoffTriggeredBy => {
	if (intent === "pedido_optout") return "opt_out";
	if (intent === "midia_recebida") return "message_type";
	if (signals.pricingAsked || signals.irritation || signals.optOutIntent) {
		return "keyword";
	}
	return "intent";
};

/**
 * O sanduíche de camadas para uma mensagem de TEXTO do lead (D-08).
 *
 * Só roda quando um adaptador foi injetado (`deps.llm`) — sem ele, o
 * comportamento é o da Fase 1 (persistir e calar). A ordem é: guardas locais
 * (silêncio barato) → Camada 1 (extração) → Camada 2 (decisão em código) →
 * Camada 3 (geração) → `persistDraft`. Qualquer falha em 1/3 é falha-fechada.
 */
const rascunharShadow = async (
	db: Db,
	deps: InboundDeps & { llm: LlmPort<ExtractionEnvelope, GenerationEnvelope> },
	evt: EventoInbound,
	lead: {
		readonly id: string;
		readonly optOut: boolean;
		readonly legalBasis: string;
		readonly purpose: string;
	},
	conversa: ConversaLida,
	agora: Date,
): Promise<void> => {
	// Guardas locais em CÓDIGO, antes de gastar token (D-07). O gate reavalia
	// depois, mas estas evitam chamar a LLM para nada.
	if (lead.optOut) return;
	if (conversa.pending_media_block) return;
	if (
		conversa.engagement_mode !== "bot_active" &&
		conversa.engagement_mode !== "shadow"
	) {
		return;
	}

	// Matcher de opt-out ANTES da LLM (D-14/R-024). A autoridade é o código, e
	// rodar aqui — e não depois da extração — é o que honra o pedido mesmo com a
	// IA fora do ar: um opt-out NÃO pode depender de a LLM responder. FORTE trava
	// (opt_out + ledger + silêncio); AMBIGUO só para e chama o humano; NAO segue.
	const classeOptout = classifyOptout(evt.body);
	if (classeOptout === OptoutClass.FORTE) {
		await applyOptOut(db, {
			leadId: lead.id,
			rawContent: evt.body,
			legalBasis: lead.legalBasis,
			purpose: lead.purpose,
			detectedBy: "deterministic",
			occurredAt: agora,
		});
		await dispararHandoff(
			db,
			{
				conversationId: conversa.id,
				reason: "opt-out explicito (matcher deterministico)",
				triggeredBy: "opt_out",
				triggerDetail: "optout_forte",
				excerpt: evt.body,
				actor: "bot",
				agora,
			},
			{ notifier: deps.notifier },
		);
		log.warn(
			{ event: "optout_forte", conversation_id: conversa.id },
			"opt-out FORTE — leads.opt_out=true + ledger, silencio total",
		);
		return;
	}
	if (classeOptout === OptoutClass.AMBIGUO) {
		await dispararHandoff(
			db,
			{
				conversationId: conversa.id,
				reason: "opt-out ambiguo (matcher deterministico)",
				triggeredBy: "opt_out",
				triggerDetail: "optout_ambiguo",
				excerpt: evt.body,
				actor: "bot",
				agora,
			},
			{ notifier: deps.notifier },
		);
		log.info(
			{ event: "optout_ambiguo", conversation_id: conversa.id },
			"opt-out AMBIGUO — handoff (nunca vira opt-out sem confirmacao)",
		);
		return;
	}

	const semente = evt.providerMsgId ?? `${evt.chatId}|${evt.timestamp}`;
	const canario = canarioEsperado(semente);

	const ctx = await loadLlmContext(db, conversa.id);
	if (!ctx) return;

	// Camada 1 — extração (prompt MASCARADO pelo choke-point).
	const extracao = await deps.llm.extract({
		prompt: buildExtractPrompt(ctx.payload, canario),
		canary: canario,
	});
	if (!extracao.ok) {
		return falhaFechada(deps, evt, extracao.error.kind, extracao.error.detail);
	}
	const ecoExtracao = validaEcoCanario(canario, extracao.output.canary);
	if (!ecoExtracao.ok) {
		return falhaFechada(
			deps,
			evt,
			"canario_divergente",
			"extração não ecoou o canário",
		);
	}
	await recordLlmRun(db, {
		...corridaDe(extracao, true, true),
		messageId: null,
		createdAt: agora,
	});

	const { signals, intent, nextStateHint, qualification } = extracao.output;

	// Qualificação ACUMULATIVA (R-051): mescla o que a extração viu com o já
	// persistido — um valor conhecido nunca é rebaixado por uma extração que não
	// o viu. A evidência é a corrida da Camada 1 em `llm_runs` (`model`,
	// `zod_parse_ok`), nunca o corpo do lead (PII fica só em `messages`).
	const qualificacaoMesclada = await updateQualification(db, {
		conversationId: conversa.id,
		verba: qualification.verba,
		decisao: qualification.decisao,
	});

	// Camada 2 — decisão em código puro. A hint da LLM só é aceita se válida.
	// A qualificação MESCLADA é a que decide: `verba && decisao` → `aquecido`
	// (R-051) no MESMO turno em que ambas foram vistas.
	const estadoResolvido = resolveNextState(
		conversa.state as Estado,
		nextStateHint,
		{
			engagementMode: conversa.engagement_mode,
			handoffDisparado: conversa.handoff_active,
			optOutAtivo: lead.optOut,
			qualification: qualificacaoMesclada,
		},
	);

	const precisaHandoff =
		INTENCOES_HANDOFF.has(intent) ||
		signals.pricingAsked ||
		signals.schedulingIntent ||
		signals.botSuspicion ||
		signals.irritation ||
		signals.optOutIntent ||
		signals.mediaReceived;

	if (precisaHandoff) {
		await dispararHandoff(
			db,
			{
				conversationId: conversa.id,
				reason: `gatilho de handoff: ${intent}`,
				triggeredBy: triggeredByDoGatilho(intent, signals),
				triggerDetail: intent,
				triggerValue: intent,
				excerpt: evt.body,
				actor: "bot",
				agora,
			},
			{ notifier: deps.notifier },
		);
		return;
	}

	// Persiste o estado resolvido (a LLM não decide; ela só sugere a hint) e
	// AUDITA a transição (R-022/CRM-02): sem `status_history`, um estado não tem
	// por quê nem por quem. Só grava quando o estado REALMENTE mudou.
	if (estadoResolvido !== conversa.state) {
		await db.execute(sql`
			update conversations set state = ${estadoResolvido}
			where id = ${conversa.id}
		`);
		await recordStatusChange(db, {
			conversationId: conversa.id,
			fromState: conversa.state,
			toState: estadoResolvido,
			changedBy: "bot",
			reason: `extracao Camada 1 (intent=${intent})`,
			changedAt: agora,
		});
	}

	// Camada 3 — geração sob o estado resolvido.
	const geracao = await deps.llm.generate({
		prompt: buildGeneratePrompt(ctx.payload, estadoResolvido, canario),
		canary: canario,
		resolvedState: estadoResolvido,
	});
	if (!geracao.ok) {
		return falhaFechada(deps, evt, geracao.error.kind, geracao.error.detail);
	}
	const ecoGeracao = validaEcoCanario(canario, geracao.output.canary);
	if (!ecoGeracao.ok) {
		return falhaFechada(
			deps,
			evt,
			"canario_divergente",
			"geração não ecoou o canário",
		);
	}

	await persistDraft(db, {
		conversationId: conversa.id,
		generatedText: geracao.output.replyText,
		idempotencyKey: `shadow:${chaveIdempotente(evt)}`,
		llmRun: corridaDe(geracao, true, true),
		agora,
		leadId: lead.id,
	});
};

/**
 * Ponto de entrada. `sock` é usado só quando o E.164 não veio pronto no evento
 * (mensagens de LID). Retorna `void`: os efeitos são as linhas no banco.
 */
export const processInboundFromMe = async (
	db: Db,
	sock: SockResolucao,
	evt: EventoInbound,
	deps: InboundDeps = {},
): Promise<void> => {
	const agora = deps.agora ?? new Date();
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
		await registrarMidiaRecebida(db, conversa, lead.id, evt, deps, agora);
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
		// CONV-01: a primeira mensagem manual do Admin move `novo` → `aquecimento`.
		// `resolveNextState` é a autoridade (D-07) — não um `set` cru no SQL.
		const estadoAdmin = resolveNextState(conversa.state as Estado, undefined, {
			adminPrimeiraMensagem: true,
		});
		if (estadoAdmin !== conversa.state) {
			await db.execute(sql`
				update conversations set state = ${estadoAdmin}
				where id = ${conversa.id}
			`);
			// CONV-01 auditável: a transição tem autor (`admin`) e motivo (R-022).
			await recordStatusChange(db, {
				conversationId: conversa.id,
				fromState: conversa.state,
				toState: estadoAdmin,
				changedBy: "admin",
				reason: "primeira mensagem manual do Admin (CONV-01)",
				changedAt: agora,
			});
		}
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

	// Sanduíche de IA (D-08) — só para mensagem do LEAD e com adaptador injetado.
	// `fromMe` é o eco do próprio número: não há rascunho a gerar para si mesmo.
	if (deps.llm && evt.fromMe !== true) {
		await rascunharShadow(
			db,
			{ ...deps, llm: deps.llm },
			evt,
			{
				id: lead.id,
				optOut: lead.optOut === true || evt.providerOptOut === true,
				legalBasis: lead.legalBasis,
				purpose: lead.purpose,
			},
			conversa,
			agora,
		);
	}

	// (e) Watermark: o cursor de "até onde já processei" (R-007/T-01-11).
	await db.execute(sql`
		update conversations
		set last_inbound_at = now(), last_processed_at = now()
		where id = ${conversa.id}
	`);
};
