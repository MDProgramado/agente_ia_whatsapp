/**
 * O choke-point: o **único** arquivo de produção que chama `sendText`.
 *
 * "Enviar sem gate" (`envio_sem_gate`) não é um décimo terceiro AR nem um módulo
 * em `guards/`: é a **ausência** de um segundo caminho de `sendText`. Por isso a
 * invariante é provada mecanicamente, por `grep` (`tests/lint/choke-point.grep.test.ts`)
 * — o conjunto de arquivos de produção que contêm `sendText(` tem de ser
 * exatamente este — e pela barreira de pacotes do `biome.json`, e não por um
 * guard que só existiria para dizer que não há desvio.
 *
 * Ordem das operações, e por quê nesta ordem:
 *
 * 1. `loadGateSnapshot` — `null` é `erro_nao_mapeado` + **silêncio**. Nunca um
 *    envio com texto de fallback: um fallback seria mensagem não auditada.
 * 2. `evaluatePolicy` — o gate **sempre** roda, em toda chamada. O worker de
 *    outbox passa por aqui a cada job, e é por isso que não existe caminho de
 *    envio sem gate (T-01-21).
 * 3. Se `block` com `ar007_fora_da_janela` ou `ar008_limite_diario` (os dois
 *    "deferir" da tabela canônica) → **difere**, sem gravar violação.
 * 4. Se `block` com qualquer outro motivo → `recordBlockedAttempt` e retorna sem
 *    enviar. A negação **não** consome cota (T-01-17).
 * 5. Se `send` → humanização (ponto do 01-05), depois `reserveMessageQuota` com
 *    `pedacos.length` → `sendText` → grava `messages` → `markSent`. Cada pedaço
 *    é uma mensagem no WhatsApp, então cada pedaço consome uma vaga da cota. A
 *    reserva acontece **depois** do gate (reservar antes gastaria o dia por uma
 *    mensagem bloqueada) e falha fechada se não houver folga para todos os
 *    pedaços.
 */
import { sql } from "drizzle-orm";
import { nextWindow } from "../domain/business-hours.js";
import type { GateReason } from "../domain/gate/index.js";
import { evaluatePolicy } from "../domain/gate/index.js";
import type { ChannelPort } from "../domain/ports/ChannelPort.js";
import type { Db } from "../infra/db/client.js";
import { recordBlockedAttempt } from "../infra/db/queries/blocked-attempts.js";
import {
	readDailyCounter,
	reserveMessageQuota,
} from "../infra/db/queries/counters.js";
import { loadGateSnapshot } from "../infra/db/queries/snapshot.js";
import { messages } from "../infra/db/schema.js";
import { logger } from "../infra/logger.js";
import {
	type Humanizer,
	type HumanKind,
	humanizadorPadrao,
	splitLongMessage,
} from "./humanize.js";
import {
	enqueue,
	markDeferred,
	markFailed,
	markSending,
	markSent,
	type OutboxOrigin,
} from "./outbox.js";
import { createPerLeadQueue, type PerLeadQueue } from "./queue-per-lead.js";

/**
 * O resultado do dispatch, discriminado. `action` (e não `status`) porque
 * `status` colidiria com o vocabulário de `messages`/`outbox`; os nomes em
 * inglês espelham o teste do plano (`drainOnce` devolve `{ blocked, deferred }`).
 */
export type DispatchResult =
	| { readonly action: "sent"; readonly messageId: string }
	| {
			readonly action: "blocked";
			readonly reason: GateReason;
			readonly detail: string;
	  }
	| { readonly action: "deferred"; readonly scheduledFor: Date }
	| {
			readonly action: "silencio";
			readonly reason: GateReason;
			readonly detail: string;
	  };

export interface DispatchDeps {
	readonly db: Db;
	readonly channel: ChannelPort;
	/**
	 * Config de janela/cota (D-05). Os contadores do dia NÃO moram aqui:
	 * `sentToday` vem de `channel.readQuota` e `newContactsToday` do banco,
	 * ambos lidos A CADA `dispatch` — um valor congelado no boot faria o gate
	 * ver o dia inteiro com o contador do instante de subida do processo.
	 */
	readonly ctx: {
		readonly tz: string;
		readonly windowStartHour: number;
		readonly windowEndHour: number;
		readonly dailyMessageLimit: number;
		readonly dailyMessageCap: number;
	};
	/**
	 * Fila por lead (R-067). O default é um singleton de módulo para que a
	 * serialização por lead valha mesmo sem injeção — criar uma fila nova a cada
	 * `dispatch` não serializaria nada.
	 */
	readonly queue?: PerLeadQueue;
	/** Humanização injetável (o default espera de verdade). */
	readonly humanizer?: Humanizer;
}

/** Singleton de módulo: uma fila por lead, compartilhada por todas as chamadas. */
const filaPadrao = createPerLeadQueue();

export interface DispatchInput {
	readonly conversationId: string;
	readonly text: string;
	/** Obrigatório: o dispatcher **nunca** chama `Date.now()`. */
	readonly now: Date;
	/** Origem do job; `bot` quando chamado direto (não vem da fila). */
	readonly origin?: OutboxOrigin;
	readonly scheduledFor?: Date;
	readonly idempotencyKey?: string;
	/** Quando o job vem do outbox, o dispatcher fecha o job (`sent`/`deferred`). */
	readonly outboxJobId?: string;
	/**
	 * Recusado. Existe só para tornar a tentativa visível em tempo de compilação:
	 * a interface não tem chave `bypassGate`, passar algo assim é erro de tipo.
	 */
	readonly bypassGate?: never;
}

/** `YYYY-MM-DD` no fuso do negócio — a chave de `daily_counters`. */
const diaLocal = (agora: Date, tz: string): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(agora);

/**
 * A origem do job de fila não é a origem da mensagem. `messages.origin` só aceita
 * `('lead','bot','admin','ai_suggestion','system')`, então `followup` e `catchup`
 * viram `bot` — os dois são a automação falando, não o Admin.
 */
const ORIGEM_DA_MENSAGEM: Record<OutboxOrigin, "bot" | "admin"> = {
	bot: "bot",
	admin: "admin",
	followup: "bot",
	catchup: "bot",
};

const buscarMensagem = async (db: Db, chave: string): Promise<string> => {
	const resultado = await db.execute(
		sql`SELECT id FROM messages WHERE idempotency_key = ${chave}`,
	);
	const id = (resultado as unknown as { rows: { id: string }[] }).rows[0]?.id;
	if (!id) {
		throw new Error(`dispatch: mensagem ${chave} nao encontrada apos o INSERT`);
	}
	return id;
};

type Snapshot = NonNullable<Awaited<ReturnType<typeof loadGateSnapshot>>>;
type Decisao = ReturnType<typeof evaluatePolicy>;

const carregarGate = async (
	deps: DispatchDeps,
	conversationId: string,
	text: string,
	instante: Date,
): Promise<{ snapshot: Snapshot | null; decisao: Decisao | null }> => {
	const { db, channel, ctx } = deps;
	const dia = diaLocal(instante, ctx.tz);
	const { sent } = await channel.readQuota(instante);
	const novosContatos = await readDailyCounter(db, dia, "new_contacts");
	const snapshot = await loadGateSnapshot(db, conversationId, instante, {
		...ctx,
		sentToday: sent,
		newContactsToday: novosContatos,
	});
	if (!snapshot) return { snapshot: null, decisao: null };
	return {
		snapshot,
		decisao: evaluatePolicy({
			...snapshot,
			outbound: { text, parts: [{ kind: "text" as const }] },
		}),
	};
};

const tratarBloqueio = async (
	deps: DispatchDeps,
	input: DispatchInput,
	snapshot: Snapshot,
	decisao: Decisao,
	instante: Date,
): Promise<DispatchResult | null> => {
	if (decisao.action !== "block") return null;
	const { db, ctx } = deps;
	const motivo = decisao.reason;

	if (motivo === "ar007_fora_da_janela" || motivo === "ar008_limite_diario") {
		const scheduledFor = nextWindow(
			instante,
			ctx.tz,
			ctx.windowStartHour,
			ctx.windowEndHour,
		);
		if (input.outboxJobId) {
			await markDeferred(db, input.outboxJobId, scheduledFor);
		} else {
			await enqueue(db, {
				conversationId: input.conversationId,
				origin: input.origin ?? "bot",
				body: input.text,
				idempotencyKey: input.idempotencyKey ?? input.conversationId,
				scheduledFor,
			});
		}
		logger.info(
			{
				event: "gate_deferido",
				reason: motivo,
				conversation_id: input.conversationId,
			},
			`mensagem adiada para ${scheduledFor.toISOString()}`,
		);
		return { action: "deferred", scheduledFor };
	}

	await recordBlockedAttempt(db, {
		conversationId: input.conversationId,
		leadId: snapshot.lead.id,
		ruleReference: motivo,
		detail: decisao.detail,
		excerpt: input.text,
		windowAtEvent: instante,
		createdAt: instante,
	});
	logger.info(
		{
			event: "gate_bloqueado",
			reason: motivo,
			conversation_id: input.conversationId,
		},
		decisao.detail,
	);
	return { action: "blocked", reason: motivo, detail: decisao.detail };
};

export const dispatch = async (
	deps: DispatchDeps,
	input: DispatchInput,
): Promise<DispatchResult> => {
	const { db, channel, ctx } = deps;
	const { conversationId, text } = input;
	const agora = input.now;
	const dia = diaLocal(agora, ctx.tz);
	const chave = input.idempotencyKey ?? conversationId;

	// (1) snapshot — o gate lê o estado mais fresco possível. Os DOIS contadores
	// do dia são lidos AGORA: `sentToday` pelo canal e `newContactsToday` do
	// banco (`daily_counters`), nunca do boot — leads novos entram o dia todo.
	const inicial = await carregarGate(deps, conversationId, text, agora);
	if (!inicial.snapshot || !inicial.decisao) {
		const detail = `conversa ${conversationId} nao encontrada ou sem lead vinculado`;
		logger.warn(
			{ event: "gate_erro_nao_mapeado", conversation_id: conversationId },
			detail,
		);
		return { action: "silencio", reason: "erro_nao_mapeado", detail };
	}

	const bloqueioInicial = await tratarBloqueio(
		deps,
		input,
		inicial.snapshot,
		inicial.decisao,
		agora,
	);
	if (bloqueioInicial) return bloqueioInicial;

	// (5) humanização (01-05, achado 12). Ponto NOMEADO entre o gate e a reserva
	// de cota: a cota só é consumida por mensagem que de fato vai sair. O atraso
	// usa a CHAVE DO ENVIO como semente (jitter por envio, não só por texto) e a
	// presença real é sinalizada pelo ChannelPort; falha de presença nunca bloqueia.
	const humanizer = deps.humanizer ?? humanizadorPadrao;
	const fila = deps.queue ?? filaPadrao;
	const genero: HumanKind =
		input.origin === "followup" || input.origin === "catchup"
			? "followup"
			: "first";
	await humanizer.delay(genero, chave);
	await channel
		.sendPresenceUpdate(conversationId, "composing")
		.catch((erro: unknown) => {
			logger.warn(
				{
					event: "presence_composing_falhou",
					conversation_id: conversationId,
				},
				`nao sinalizei digitando: ${erro instanceof Error ? erro.message : String(erro)}`,
			);
		});
	try {
		await humanizer.typing(text);
	} finally {
		await channel
			.sendPresenceUpdate(conversationId, "paused")
			.catch((erro: unknown) => {
				logger.warn(
					{
						event: "presence_paused_falhou",
						conversation_id: conversationId,
					},
					`nao sinalizei parar de digitar: ${erro instanceof Error ? erro.message : String(erro)}`,
				);
			});
	}

	// (5) re-gate imediatamente antes de reservar/enviar. O delay pode durar
	// segundos e o opt-out/handoff pode chegar nesse intervalo — o gate de abertura
	// não autoriza o envio posterior.
	const final = await carregarGate(deps, conversationId, text, agora);
	if (!final.snapshot || !final.decisao) {
		const detail = `conversa ${conversationId} nao encontrada ou sem lead vinculado`;
		logger.warn(
			{ event: "gate_erro_nao_mapeado", conversation_id: conversationId },
			detail,
		);
		return { action: "silencio", reason: "erro_nao_mapeado", detail };
	}
	const bloqueioFinal = await tratarBloqueio(
		deps,
		input,
		final.snapshot,
		final.decisao,
		agora,
	);
	if (bloqueioFinal) return bloqueioFinal;

	// Texto longo vira vários pedaços, enviados em ORDEM. Cada pedaço tem sua
	// própria `idempotency_key` (`chave#n`) para que a unicidade de `messages` não
	// colapse os pedaços numa linha só.
	const pedacos = splitLongMessage(text);

	const reserva = await db.transaction(async (txBruto) =>
		reserveMessageQuota(
			txBruto as unknown as Db,
			dia,
			ctx.dailyMessageLimit,
			ctx.dailyMessageCap,
			pedacos.length,
		),
	);

	let resultado:
		| { readonly tipo: "sem_cota" }
		| { readonly tipo: "enviado"; readonly messageId: string };
	try {
		if (!reserva.allowed) {
			resultado = { tipo: "sem_cota" };
		} else {
			if (input.outboxJobId) {
				await markSending(db, input.outboxJobId);
			}

			const messageId = await fila.run(final.snapshot.lead.id, async () => {
				let primeiroId: string | undefined;
				for (const [i, pedaco] of pedacos.entries()) {
					const chavePedaco =
						pedacos.length === 1 ? chave : `${chave}#${i + 1}`;
					const envio = await channel.sendText(
						conversationId,
						pedaco,
						chavePedaco,
					);

					const id = await db.transaction(async (txBruto) => {
						const tx = txBruto as unknown as Db;
						const inseridos = await tx
							.insert(messages)
							.values({
								conversationId,
								direction: "out",
								origin: ORIGEM_DA_MENSAGEM[input.origin ?? "bot"],
								kind: "text",
								body: pedaco,
								status: "sent",
								providerMsgId: envio.providerMsgId,
								latencyMs: envio.latencyMs,
								idempotencyKey: chavePedaco,
								createdAt: agora,
							})
							.onConflictDoNothing({ target: messages.idempotencyKey })
							.returning({ id: messages.id });
						return inseridos[0]?.id ?? buscarMensagem(tx, chavePedaco);
					});
					primeiroId ??= id;
				}
				if (primeiroId === undefined) {
					throw new Error("dispatch: nenhum pedaco para enviar");
				}
				return primeiroId;
			});

			if (input.outboxJobId) {
				await markSent(db, input.outboxJobId, messageId);
			}
			resultado = { tipo: "enviado", messageId };
		}
	} catch (erro) {
		// Meia mensagem não existe: o envio e o INSERT agora são transações
		// separadas; se qualquer pedaço falhar, marca o job como falho NÃO-retentável
		// (repetir cego é o burst que derruba número) e fica em silêncio. Nunca um
		// fallback de texto.
		const motivo = erro instanceof Error ? erro.message : String(erro);
		logger.error(
			{ event: "dispatch_envio_falhou", conversation_id: conversationId },
			`falha no envio: ${motivo}`,
		);
		if (input.outboxJobId) {
			await markFailed(db, input.outboxJobId, motivo, { retryable: false });
		}
		return {
			action: "silencio",
			reason: "erro_nao_mapeado",
			detail: `falha no envio do pedaco: ${motivo}`,
		};
	}

	// Corrida rara: o gate viu folga, mas outra transação consumiu a última vaga
	// de cota entre o snapshot e a reserva. Trata como deferimento, não bloqueio.
	if (resultado.tipo === "sem_cota") {
		const scheduledFor = nextWindow(
			agora,
			ctx.tz,
			ctx.windowStartHour,
			ctx.windowEndHour,
		);
		if (input.outboxJobId) {
			await markDeferred(db, input.outboxJobId, scheduledFor);
		} else {
			await enqueue(db, {
				conversationId,
				origin: input.origin ?? "bot",
				body: text,
				idempotencyKey: chave,
				scheduledFor,
			});
		}
		logger.info(
			{
				event: "gate_deferido",
				reason: "ar008_limite_diario",
				conversation_id: conversationId,
			},
			`cota esgotada na reserva; adiado para ${scheduledFor.toISOString()}`,
		);
		return { action: "deferred", scheduledFor };
	}

	return { action: "sent", messageId: resultado.messageId };
};
