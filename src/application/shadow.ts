/**
 * Rascunho em shadow — persistir uma sugestão de IA SEM tocar o número (D-03/D-04).
 *
 * Shadow é a fase de treino do piloto: a automação conduz a conversa até o fim,
 * mas o texto que ela escreveria é gravado como **sugestão** para revisão humana,
 * não enviado. A conversa fica `engagement_mode = 'shadow'` (D-18) e nada sai pelo
 * canal.
 *
 * ## O gate roda IGUAL em shadow (a parte que não dá para simplificar)
 *
 * Seria tentador pular o gate em shadow — "não vai enviar, então não precisa de
 * guarda". É exatamente o erro que este módulo existe para proibir. O gate é
 * reavaliado sobre o TEXTO GERADO, e um rascunho que violaria um anti-requisito
 * (preço no corpo, mídia, revelação de automação, fora da janela, cota) é uma
 * violação que TERIA acontecido. Em shadow, ele vira uma linha em
 * `blocked_attempts` — a mesma trilha auditável (R-022) que o envio real deixaria.
 * Assim o relatório de shadow (02-03) mede o comportamento REAL da IA, não um
 * caminho idealizado sem guardas.
 *
 * ## Por que `messages`, e por que `status='suggested'`
 *
 * O rascunho é o dado auditável (R-043): `origin='ai_suggestion'`,
 * `status='suggested'`. `messages` é append-only — a promoção a "enviado" (D-15)
 * nunca é um `UPDATE`; é um evento em `review_events`. Por isso este módulo só
 * INSERE.
 *
 * ## Sem `dispatcher` (invariante de arquitetura)
 *
 * O `dispatcher` é o único módulo que chama `sendText`. Shadow NÃO envia; se
 * importasse o dispatcher, abriria o segundo caminho de envio que
 * `tests/lint/choke-point.grep.test.ts` prova que não existe. A ausência desse
 * `import` é a invariante, não um comentário.
 */
import { sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { evaluatePolicy } from "../domain/gate/index.js";
import type { GateReason } from "../domain/gate/types.js";
import { scanPostGate } from "../domain/llm/post-gate.js";
import type { Db } from "../infra/db/client.js";
import { recordBlockedAttempt } from "../infra/db/queries/blocked-attempts.js";
import {
	type LlmRunInput,
	recordLlmRun,
} from "../infra/db/queries/llm-runs.js";
import { loadGateSnapshot } from "../infra/db/queries/snapshot.js";
import { messages } from "../infra/db/schema.js";

/** Metadado da corrida de geração que gerou o rascunho — vai para `llm_runs`. */
export type LlmRunMeta = Omit<LlmRunInput, "messageId" | "createdAt">;

export interface DraftInput {
	readonly conversationId: string;
	/** O texto que a IA escreveu e que, em produção, sairia pelo canal. */
	readonly generatedText: string;
	/** Dedup do rascunho; reusar a chave não duplica a linha em `messages`. */
	readonly idempotencyKey: string;
	readonly llmRun: LlmRunMeta;
	/** Instante do fato. Injetado — este módulo não chama `Date.now()`. */
	readonly agora: Date;
	/** Lead da conversa, quando conhecido; o snapshot já o traz, isto é só um atalho. */
	readonly leadId?: string;
}

/** Resultado discriminado: persistido, ou bloqueado (com o motivo do gate). */
export type DraftResult =
	| { readonly persisted: true; readonly messageId: string }
	| {
			readonly persisted: false;
			readonly blockedReason: GateReason;
			readonly detail: string;
	  };

/** Teto FÍSICO de R-023 — não é configurável e não muda (ver `daily_counters_max`). */
export const CAP_MENSAGENS = 30;

const diaLocal = (agora: Date, tz: string): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(agora);

/** Lê os contadores do dia para o gate; ausência é 0, nunca erro. */
const lerContadores = async (
	db: Db,
	dia: string,
): Promise<{ sentToday: number; newContactsToday: number }> => {
	const resultado = await db.execute(sql`
		select kind, count from daily_counters where day = ${dia}
	`);
	const rows = (
		resultado as unknown as { rows: { kind: string; count: number }[] }
	).rows;
	return {
		sentToday: rows.find((r) => r.kind === "sent")?.count ?? 0,
		newContactsToday: rows.find((r) => r.kind === "new_contacts")?.count ?? 0,
	};
};

const buscarMensagemPorChave = async (
	db: Db,
	chave: string,
): Promise<string> => {
	const resultado = await db.execute(
		sql`select id from messages where idempotency_key = ${chave}`,
	);
	const id = (resultado as unknown as { rows: { id: string }[] }).rows[0]?.id;
	if (!id) {
		throw new Error(
			`persistDraft: mensagem ${chave} nao encontrada apos o INSERT`,
		);
	}
	return id;
};

/**
 * Avalia o gate sobre o texto gerado e, se aprovado, grava o rascunho.
 *
 * Se o gate bloqueia, grava a violação em `blocked_attempts` e devolve o motivo —
 * NUNCA devolve um rascunho que violou a política. Se o snapshot não existe, a
 * conversa não existe: devolve `erro_nao_mapeado` sem gravar (não há a que
 * prender o negativo, e um INSERT com FK inexistente estouraria).
 */
export const persistDraft = async (
	db: Db,
	input: DraftInput,
): Promise<DraftResult> => {
	const agora = input.agora;
	const dia = diaLocal(agora, env.TZ);
	const { sentToday, newContactsToday } = await lerContadores(db, dia);

	const snapshot = await loadGateSnapshot(db, input.conversationId, agora, {
		tz: env.TZ,
		windowStartHour: env.WINDOW_START_HOUR,
		windowEndHour: env.WINDOW_END_HOUR,
		dailyMessageLimit: env.DAILY_MESSAGE_LIMIT,
		dailyMessageCap: CAP_MENSAGENS,
		sentToday,
		newContactsToday,
	});

	if (!snapshot) {
		return {
			persisted: false,
			blockedReason: "erro_nao_mapeado",
			detail: `conversa ${input.conversationId} nao encontrada para rascunho em shadow`,
		};
	}

	// L4 (CONV-07): barreira determinística de TEXTO antes do gate canônico.
	// Conteúdo proibido no rascunho (preço, proposta, agenda, mídia) é bloqueado
	// primeiro e registrado em `blocked_attempts` — o mesmo negativo auditável
	// que um envio real deixaria (R-022).
	const veredito = scanPostGate(input.generatedText);
	if (!veredito.allowed) {
		await recordBlockedAttempt(db, {
			conversationId: input.conversationId,
			leadId: input.leadId ?? snapshot.lead.id,
			ruleReference: veredito.reason,
			detail: veredito.detail,
			excerpt: input.generatedText,
			windowAtEvent: agora,
			createdAt: agora,
		});
		return {
			persisted: false,
			blockedReason: veredito.reason,
			detail: veredito.detail,
		};
	}

	const decisao = evaluatePolicy({
		...snapshot,
		outbound: { text: input.generatedText, parts: [{ kind: "text" }] },
	});

	if (decisao.action !== "send") {
		await recordBlockedAttempt(db, {
			conversationId: input.conversationId,
			leadId: input.leadId ?? snapshot.lead.id,
			ruleReference: decisao.reason,
			detail: decisao.detail,
			excerpt: input.generatedText,
			windowAtEvent: agora,
			createdAt: agora,
		});
		return {
			persisted: false,
			blockedReason: decisao.reason,
			detail: decisao.detail,
		};
	}

	const messageId = await db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;
		const inseridos = await tx
			.insert(messages)
			.values({
				conversationId: input.conversationId,
				direction: "out",
				origin: "ai_suggestion",
				kind: "text",
				body: input.generatedText,
				status: "suggested",
				idempotencyKey: input.idempotencyKey,
				createdAt: agora,
			})
			.onConflictDoNothing({ target: messages.idempotencyKey })
			.returning({ id: messages.id });

		const id =
			inseridos[0]?.id ??
			(await buscarMensagemPorChave(tx, input.idempotencyKey));

		await recordLlmRun(tx, {
			...input.llmRun,
			messageId: id,
			createdAt: agora,
		});

		return id;
	});

	return { persisted: true, messageId };
};
