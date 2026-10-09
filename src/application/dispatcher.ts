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
 * 5. Se `send` → humanização (ponto do 01-05), depois **na mesma transação**:
 *    `reserveMessageQuota` → `sendText` → grava `messages` → `markSent`. A cota é
 *    reservada **depois** do gate (reservar antes gastaria o dia por uma mensagem
 *    bloqueada) e **na mesma transação** do envio (T-01-18).
 */
import { sql } from "drizzle-orm";
import { nextWindow } from "../domain/business-hours.js";
import type { GateReason } from "../domain/gate/index.js";
import { evaluatePolicy } from "../domain/gate/index.js";
import type { ChannelPort } from "../domain/ports/ChannelPort.js";
import type { Db } from "../infra/db/client.js";
import { recordBlockedAttempt } from "../infra/db/queries/blocked-attempts.js";
import { reserveMessageQuota } from "../infra/db/queries/counters.js";
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
	readonly ctx: {
		readonly tz: string;
		readonly windowStartHour: number;
		readonly windowEndHour: number;
		readonly dailyMessageLimit: number;
		readonly dailyMessageCap: number;
		readonly newContactsToday: number;
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

export const dispatch = async (
	deps: DispatchDeps,
	input: DispatchInput,
): Promise<DispatchResult> => {
	const { db, channel, ctx } = deps;
	const { conversationId, text } = input;
	const agora = input.now;
	const dia = diaLocal(agora, ctx.tz);
	const chave = input.idempotencyKey ?? conversationId;

	// (1) snapshot — o gate lê o estado mais fresco possível.
	const { sent } = await channel.readQuota(agora);
	const snapshot = await loadGateSnapshot(db, conversationId, agora, {
		...ctx,
		sentToday: sent,
	});

	if (!snapshot) {
		const detail = `conversa ${conversationId} nao encontrada ou sem lead vinculado`;
		logger.warn(
			{ event: "gate_erro_nao_mapeado", conversation_id: conversationId },
			detail,
		);
		return { action: "silencio", reason: "erro_nao_mapeado", detail };
	}

	const entrada = {
		...snapshot,
		outbound: { text, parts: [{ kind: "text" as const }] },
	};

	// (2) o gate decide — sempre.
	const decisao = evaluatePolicy(entrada);

	if (decisao.action === "block") {
		const motivo = decisao.reason;

		// (3) deferimento: não é violação, é "espere a próxima janela/folga".
		if (motivo === "ar007_fora_da_janela" || motivo === "ar008_limite_diario") {
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
					reason: motivo,
					conversation_id: conversationId,
				},
				`mensagem adiada para ${scheduledFor.toISOString()}`,
			);
			return { action: "deferred", scheduledFor };
		}

		// (4) negação registrada, sem cota consumida. O `guard` (AR/R) é derivado
		// pelo trigger `fn_preencher_blocked_attempt` a partir do `rule_reference`
		// — uma tradução, um lugar só. `excerpt` guarda um trecho para o relatório.
		await recordBlockedAttempt(db, {
			conversationId,
			leadId: snapshot.lead.id,
			ruleReference: motivo,
			detail: decisao.detail,
			excerpt: text,
			windowAtEvent: agora,
			createdAt: agora,
		});
		logger.info(
			{
				event: "gate_bloqueado",
				reason: motivo,
				conversation_id: conversationId,
			},
			decisao.detail,
		);
		return { action: "blocked", reason: motivo, detail: decisao.detail };
	}

	// (5) humanização (01-05). Ponto NOMEADO entre o gate e a reserva de cota: a
	// cota só é consumida por mensagem que de fato vai sair. O atraso e o "digitando"
	// acontecem ANTES de reservar — um atraso que falha não pode queimar cota.
	const humanizer = deps.humanizer ?? humanizadorPadrao;
	const fila = deps.queue ?? filaPadrao;
	const genero: HumanKind =
		input.origin === "followup" || input.origin === "catchup"
			? "followup"
			: "first";
	await humanizer.delay(genero, text);
	await humanizer.typing(text);

	// Texto longo vira vários pedaços, enviados em ORDEM. Cada pedaço tem sua
	// própria `idempotency_key` (`chave#n`) para que a unicidade de `messages` não
	// colapse os pedaços numa linha só.
	const pedacos = splitLongMessage(text);

	let resultado:
		| { readonly tipo: "sem_cota" }
		| { readonly tipo: "enviado"; readonly messageId: string };
	try {
		resultado = await db.transaction(async (txBruto) => {
			const tx = txBruto as unknown as Db;
			const reserva = await reserveMessageQuota(
				tx,
				dia,
				ctx.dailyMessageLimit,
				ctx.dailyMessageCap,
			);
			if (!reserva.allowed) return { tipo: "sem_cota" as const };

			// Serializa por lead (R-067). Se um pedaço falhar, a exceção sobe, a
			// transação reverte (nenhum `messages` fica gravado) e os pedaços
			// seguintes nunca são enviados.
			const enviarPedacos = async (): Promise<string> => {
				let primeiroId: string | undefined;
				for (const [i, pedaco] of pedacos.entries()) {
					const chavePedaco =
						pedacos.length === 1 ? chave : `${chave}#${i + 1}`;
					await channel.sendText(conversationId, pedaco, chavePedaco);

					// `messages` é append-only (R-043): grava-se com o status FINAL. O
					// envio já aconteceu acima; se este INSERT falhar, a transação
					// reverte e nada é registrado — nunca um UPDATE posterior.
					const inseridos = await tx
						.insert(messages)
						.values({
							conversationId,
							direction: "out",
							origin: ORIGEM_DA_MENSAGEM[input.origin ?? "bot"],
							kind: "text",
							body: pedaco,
							status: "sent",
							idempotencyKey: chavePedaco,
							createdAt: agora,
						})
						.onConflictDoNothing({ target: messages.idempotencyKey })
						.returning({ id: messages.id });

					const id =
						inseridos[0]?.id ?? (await buscarMensagem(tx, chavePedaco));
					primeiroId ??= id;
				}
				if (primeiroId === undefined) {
					throw new Error("dispatch: nenhum pedaco para enviar");
				}
				return primeiroId;
			};

			const messageId = await fila.run(snapshot.lead.id, enviarPedacos);

			if (input.outboxJobId) {
				await markSent(tx, input.outboxJobId, messageId);
			}
			return { tipo: "enviado" as const, messageId };
		});
	} catch (erro) {
		// Meia mensagem não existe: com a transação revertida, marca o job como
		// falho NÃO-retentável (repetir cego é o burst que derruba número) e fica
		// em silêncio. Nunca um fallback de texto.
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
