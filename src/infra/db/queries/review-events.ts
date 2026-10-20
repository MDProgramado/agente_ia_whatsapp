/**
 * `review_events` — a decisão de revisão de um rascunho em shadow (D-03/D-06).
 *
 * É um EVENTO, não um estado. `messages` é imutável (R-043), então promover um
 * rascunho não pode ser `UPDATE messages SET status='sent'` (Pitfall 1): a
 * promoção é uma LINHA nova que responde "quem aprovou o quê, quando". A tabela
 * é append-only no banco (`trg_review_events_append_only`).
 *
 * As três decisões do CHECK são `approved`, `edited`, `discarded`; `edited_text`
 * só carrega conteúdo quando a decisão é `edited` (aprovar/descartar não têm
 * texto). O módulo segue `blocked-attempts.ts`: escrita com `RETURNING id`,
 * leitura com teto e narrowing de união fechada.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { reviewEvents } from "../schema.js";

/** As três decisões aceitas pelo `review_events_decision_check`. */
export type ReviewDecision = "approved" | "edited" | "discarded";

/** O que o revisor (a CLI de shadow, 02-03) sabe ao registrar a decisão. */
export interface ReviewEventInput {
	readonly messageId: string;
	readonly decision: ReviewDecision;
	/** Quem decidiu. Sob R-027 é o Admin; o campo existe para a trilha não mentir. */
	readonly actor: string;
	/** Texto revisado — só faz sentido em `edited`; `null` nos demais. */
	readonly editedText?: string | null;
	readonly createdAt?: Date;
}

/** Uma linha de `review_events` como a CLI/relatório a consomem. */
export interface ReviewEventLido {
	readonly id: string;
	readonly messageId: string;
	readonly decision: ReviewDecision;
	readonly actor: string;
	readonly editedText: string | null;
	readonly createdAt: Date;
}

/** Teto padrão de leitura, espelhando `blocked-attempts.ts`. */
export const LIMITE_PADRAO = 100;
const TETO_ABSOLUTO = 500;

/** Grava a decisão e devolve o `id` gravado (correlaciona log ↔ auditoria). */
export const recordReviewEvent = async (
	db: Db,
	input: ReviewEventInput,
): Promise<string> => {
	const textoEditado =
		input.decision === "edited" ? (input.editedText ?? null) : null;

	const resultado = await db.execute(sql`
		insert into ${reviewEvents} (
			message_id,
			decision,
			actor,
			edited_text,
			created_at
		)
		values (
			${input.messageId},
			${input.decision},
			${input.actor},
			${textoEditado},
			${input.createdAt ?? new Date()}
		)
		returning id
	`);

	const rows = (resultado as unknown as { rows: { id: string }[] }).rows;
	const primeira = rows[0];
	if (!primeira) {
		throw new Error(
			"recordReviewEvent: o INSERT nao devolveu id — a decisao (D-06) nao foi gravada",
		);
	}
	return primeira.id;
};

export interface ReviewEventFiltro {
	readonly messageId?: string;
	readonly limit?: number;
}

/** Lê as decisões, mais recentes primeiro, com teto duplo. */
export const loadReviewEvents = async (
	db: Db,
	filtro: ReviewEventFiltro = {},
): Promise<ReviewEventLido[]> => {
	const teto = Math.min(
		Math.max(Math.trunc(filtro.limit ?? LIMITE_PADRAO), 1),
		TETO_ABSOLUTO,
	);

	const resultado = await db.execute(sql`
		select id, message_id, decision, actor, edited_text, created_at
		from ${reviewEvents}
		where ${filtro.messageId ?? null}::uuid is null
			or message_id = ${filtro.messageId ?? null}::uuid
		order by created_at desc
		limit ${teto}
	`);

	return (resultado as unknown as { rows: Record<string, unknown>[] }).rows.map(
		paraReviewEventLido,
	);
};

/** `decision` é união fechada: narrowing explícito, nunca `string` vazando. */
const paraReviewEventLido = (
	row: Record<string, unknown>,
): ReviewEventLido => ({
	id: row.id as string,
	messageId: row.message_id as string,
	decision: paraDecisao(row.decision),
	actor: row.actor as string,
	editedText: (row.edited_text as string | null) ?? null,
	createdAt: paraData(row.created_at),
});

/**
 * Normaliza o timestamp devolvido pelo driver. Dependendo do type parser ativo,
 * o pg devolve `Date` (default de TIMESTAMPTZ) ou `string` — afirmar `as Date`
 * seria mentira de tipo no segundo caso (IN-01). `new Date(...)` aceita ambos.
 */
const paraData = (bruto: unknown): Date =>
	bruto instanceof Date ? bruto : new Date(String(bruto));

const paraDecisao = (bruto: unknown): ReviewDecision => {
	if (bruto === "approved" || bruto === "edited" || bruto === "discarded") {
		return bruto;
	}
	// O CHECK do banco impede outro valor; um valor estranho só pode vir de uma
	// leitura corrompida — falhar alto é melhor que devolver um `string` frouxo.
	throw new Error(
		`review_events.decision invalido: ${String(bruto)} (CHECK should prevent this)`,
	);
};
