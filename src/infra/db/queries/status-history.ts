/**
 * Histórico de mudança de status do funil (R-022, Task 3 do 02-02).
 *
 * `status_history` responde "por que a conversa está neste estágio e quem a pôs
 * ali" — a pergunta que a trilha de conformidade faz. `changed_by` é texto
 * (`bot`/`admin`/`system`), não FK: o valor precisa dizer QUAL dos dois mesmo
 * antes de `app_users` ter mais de uma linha (R-027), e um FK para um único
 * usuário seria uma mentira sobre quem agiu.
 *
 * ## Append-only por convenção da APLICAÇÃO
 *
 * Diferente de `messages`/`event_log`/`optout_ledger`, `status_history` **não**
 * tem trigger de append-only nem `REVOKE` (verificado em
 * `0003_phase01_02_tabelas.sql` e `0004_guards_and_audit.sql`: a tabela é criada
 * sem guarda, e o comentário de `mode_changes` diz "append-only por convencao da
 * aplicacao"). O invariante vale por este módulo só INSERIR e nunca emitir
 * `UPDATE`/`DELETE` — não há migration neste plano para adicionar o gatilho, e
 * adicionar DDL fora de `files_modified` seria escopo indevido.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../client.js";

/** Quem mudou o estado. Texto, casando o comentário do schema (R-027). */
export type StatusActor = "bot" | "admin" | "system";

export interface StatusChangeInput {
	readonly conversationId: string;
	readonly fromState: string;
	readonly toState: string;
	readonly changedBy: StatusActor;
	readonly reason?: string | null;
	/** Instante do fato; injetável para determinismo em teste. Default `new Date()`. */
	readonly changedAt?: Date;
}

export interface StatusChangeLido {
	readonly id: string;
	readonly conversationId: string;
	readonly fromState: string;
	readonly toState: string;
	readonly changedBy: string;
	readonly reason: string | null;
	readonly changedAt: Date;
}

/** Teto de leitura do histórico; o painel pede dezenas, não a tabela inteira. */
export const STATUS_HISTORY_LIMITE = 50;

/**
 * Grava uma transição de estado. Devolve o `id` para correlacionar o log da
 * aplicação com a linha auditável — sem ele, a transição no código e a linha no
 * banco não se ligam.
 */
export const recordStatusChange = async (
	db: Db,
	input: StatusChangeInput,
): Promise<string> => {
	const resultado = await db.execute(sql`
		insert into status_history (
			conversation_id, from_state, to_state, changed_by, reason, changed_at
		)
		values (
			${input.conversationId},
			${input.fromState},
			${input.toState},
			${input.changedBy},
			${input.reason ?? null},
			${input.changedAt ?? new Date()}
		)
		returning id
	`);
	const primeira = (resultado as unknown as { rows: { id: string }[] }).rows[0];
	if (!primeira) {
		throw new Error(
			"recordStatusChange: o INSERT nao devolveu id — a transicao de estado (R-022) nao foi auditada",
		);
	}
	return primeira.id;
};

/** Lê o histórico de uma conversa, mais recente primeiro. */
export const loadStatusHistory = async (
	db: Db,
	conversationId: string,
	limit: number = STATUS_HISTORY_LIMITE,
): Promise<StatusChangeLido[]> => {
	const teto = Math.min(Math.max(Math.trunc(limit), 1), 200);
	const resultado = await db.execute(sql`
		select id, conversation_id, from_state, to_state, changed_by, reason, changed_at
		from status_history
		where conversation_id = ${conversationId}
		order by changed_at desc, id desc
		limit ${teto}
	`);
	return (resultado as unknown as { rows: Record<string, unknown>[] }).rows.map(
		(row) => ({
			id: row.id as string,
			conversationId: row.conversation_id as string,
			fromState: row.from_state as string,
			toState: row.to_state as string,
			changedBy: row.changed_by as string,
			reason: (row.reason as string | null) ?? null,
			changedAt: row.changed_at as Date,
		}),
	);
};
