/**
 * `llm_runs` — metadados de cada corrida da LLM (R-045, D-05, T-02-05).
 *
 * O que entra aqui e o que NÃO entra é a regra inteira deste módulo: modelo,
 * tokens, latência, custo, versão do prompt e da política, e os dois booleanos
 * de aderência (`zod_parse_ok`, `canary_ok`). **Nunca** o corpo do prompt nem o
 * texto gerado — o corpo da mensagem vive em `messages`, que é a tabela
 * auditável com prazo de retenção (Pitfall 4). Duplicar o transcript aqui
 * colocaria PII fora do registro que a LGPD alcança.
 *
 * A tabela é append-only no banco (`trg_llm_runs_append_only`): um metadado de
 * execução não é corrigido, é re-medido. Por isso não há `update`/`delete` aqui.
 *
 * O par de funções segue `blocked-attempts.ts`: escrita com `RETURNING id`
 * (correlaciona o log da aplicação com a linha de auditoria) e leitura com teto
 * e narrowing explícito (nada de `string` cru vazando para as fases seguintes).
 */
import { sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { llmRuns } from "../schema.js";

/** O que o adaptador sabe ao fim de UMA corrida. Só metadados — nunca o corpo. */
export interface LlmRunInput {
	/**
	 * Rascunho gerado, quando a corrida é a de GERAÇÃO (Camada 3). A extração
	 * (Camada 1) roda antes de existir rascunho, então vem `null`/ausente.
	 */
	readonly messageId?: string | null;
	readonly model: string;
	readonly promptTokens?: number | null;
	readonly completionTokens?: number | null;
	readonly latencyMs?: number | null;
	readonly costUsd?: number | null;
	/** Versão do template de prompt — é o que permite comparar qualidade entre revisões. */
	readonly promptVersion: string;
	/** Versão do mapa de guardas/FSM vigente na corrida. */
	readonly policyVersion: string;
	readonly zodParseOk: boolean;
	readonly canaryOk: boolean;
	readonly createdAt?: Date;
}

/** Uma linha de `llm_runs` como a CLI de shadow (02-03) a consome. */
export interface LlmRunLido {
	readonly id: string;
	readonly messageId: string | null;
	readonly model: string;
	readonly promptTokens: number | null;
	readonly completionTokens: number | null;
	readonly latencyMs: number | null;
	readonly costUsd: string | null;
	readonly promptVersion: string;
	readonly policyVersion: string;
	readonly zodParseOk: boolean;
	readonly canaryOk: boolean;
	readonly createdAt: Date;
}

/** Teto padrão de leitura; o mesmo teto duplo de `blocked-attempts.ts`. */
export const LIMITE_PADRAO = 100;
const TETO_ABSOLUTO = 500;

/**
 * Grava a corrida e devolve o `id` para o log correlacionar.
 *
 * `created_at` é NOT NULL com default `now()`: passar `null` explicitamente
 * anularia o default, então o default é escolhido aqui (mesma nota de
 * `blocked-attempts.ts`).
 */
export const recordLlmRun = async (
	db: Db,
	input: LlmRunInput,
): Promise<string> => {
	const resultado = await db.execute(sql`
		insert into ${llmRuns} (
			message_id,
			model,
			prompt_tokens,
			completion_tokens,
			latency_ms,
			cost_usd,
			prompt_version,
			policy_version,
			zod_parse_ok,
			canary_ok,
			created_at
		)
		values (
			${input.messageId ?? null},
			${input.model},
			${input.promptTokens ?? null},
			${input.completionTokens ?? null},
			${input.latencyMs ?? null},
			${input.costUsd ?? null},
			${input.promptVersion},
			${input.policyVersion},
			${input.zodParseOk},
			${input.canaryOk},
			${input.createdAt ?? new Date()}
		)
		returning id
	`);

	const rows = (resultado as unknown as { rows: { id: string }[] }).rows;
	const primeira = rows[0];
	// `RETURNING id` numa PK uuid com default sempre devolve linha; a ausência
	// significaria que o INSERT não aconteceu — e um id inventado mentiria sobre
	// a auditoria (mesma disciplina de `recordBlockedAttempt`).
	if (!primeira) {
		throw new Error(
			"recordLlmRun: o INSERT nao devolveu id — a auditoria (R-045) nao foi gravada",
		);
	}
	return primeira.id;
};

/** Filtro de leitura. Sem filtro, a CLI recebe o teto padrão dos últimos 100. */
export interface LlmRunFiltro {
	readonly messageId?: string;
	readonly conversationId?: string;
	readonly limit?: number;
}

/**
 * Lê as corridas, mais recentes primeiro.
 *
 * Quando o filtro é por `conversationId`, o JOIN com `messages` é o que liga o
 * metadado à conversa — `llm_runs` não tem `conversation_id` de propósito
 * (o vínculo é a mensagem, quando ela existe).
 */
export const loadLlmRuns = async (
	db: Db,
	filtro: LlmRunFiltro = {},
): Promise<LlmRunLido[]> => {
	const teto = Math.min(
		Math.max(Math.trunc(filtro.limit ?? LIMITE_PADRAO), 1),
		TETO_ABSOLUTO,
	);

	const resultado = await db.execute(sql`
		select
			r.id,
			r.message_id,
			r.model,
			r.prompt_tokens,
			r.completion_tokens,
			r.latency_ms,
			r.cost_usd,
			r.prompt_version,
			r.policy_version,
			r.zod_parse_ok,
			r.canary_ok,
			r.created_at
		from ${llmRuns} r
		left join messages m on m.id = r.message_id
		where
			(${filtro.messageId ?? null}::uuid is null or r.message_id = ${filtro.messageId ?? null}::uuid)
			and (${filtro.conversationId ?? null}::uuid is null or m.conversation_id = ${filtro.conversationId ?? null}::uuid)
		order by r.created_at desc
		limit ${teto}
	`);

	return (resultado as unknown as { rows: Record<string, unknown>[] }).rows.map(
		paraLlmRunLido,
	);
};

/** Narrowing explícito dos tipos que o banco devolve largos (`numeric` → string). */
const paraLlmRunLido = (row: Record<string, unknown>): LlmRunLido => ({
	id: row.id as string,
	messageId: (row.message_id as string | null) ?? null,
	model: row.model as string,
	promptTokens: (row.prompt_tokens as number | null) ?? null,
	completionTokens: (row.completion_tokens as number | null) ?? null,
	latencyMs: (row.latency_ms as number | null) ?? null,
	costUsd: (row.cost_usd as string | null) ?? null,
	promptVersion: row.prompt_version as string,
	policyVersion: row.policy_version as string,
	zodParseOk: row.zod_parse_ok as boolean,
	canaryOk: row.canary_ok as boolean,
	createdAt: row.created_at as Date,
});
