/**
 * Queries do scheduler de follow-up (Fase 3, FLUP). Módulo de **leitura** (e da
 * reconciliação) que o `src/application/scheduler.ts` consome — um produtor do
 * `outbox`, nunca um sender.
 *
 * ## Por que tudo aqui é `db.execute(sql\`\`)` cru, e não select Drizzle tipado
 *
 * As colunas de tempo que a cadência usa têm **dois tipos diferentes**, e o
 * Drizzle trata cada um de um jeito que NÃO é intercambiável:
 *
 * - `conversations.last_outbound_at` / `last_inbound_at` são `timestamp` **sem
 *   fuso** (wall time de `America/Sao_Paulo`). O `PgTimestamp` do Drizzle
 *   serializa escritas em UTC (`.toISOString()`) e, ao ler, faz
 *   `new Date(valor + "+0000")` — ou seja, reinterpreta o wall time local como
 *   UTC, deslocando 3 h. Por isso o select Drizzle tipado está **errado** para
 *   estas colunas.
 * - `scheduled_tasks.scheduled_for` é `timestamp with time zone` (instante
 *   absoluto), onde o Drizzle está correto.
 *
 * O driver cru (`db.execute`) devolve timestamp ingênua como **string** (o
 * Drizzle sobrescreve o parser de data do pg — ver `outbox.test.ts`). A saída
 * correta e imune ao fuso é, portanto, extrair o **epoch absoluto no SQL**:
 * `extract(epoch from (naive AT TIME ZONE timezone)) * 1000` — o wall time é
 * interpretado no fuso da própria conversa e vira epoch, que o JS converte num
 * `Date` exato sem depender do TZ do processo. Assim `proximaTentativa` recebe
 * um instante verdadeiro e a comparação `alvo <= now` não mente por 3 h.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../client.js";

/** Um candidato "em cadência" — pronto para o tick decidir o próximo toque. */
export interface CandidatoCadencia {
	readonly conversationId: string;
	readonly leadId: string;
	/** `leads.name` (nullable) — alimenta o `[Nome]` da mensagem. */
	readonly nome: string | null;
	/** Cursor de toques já enviados (`conversations.follow_up_index`). */
	readonly followUpIndex: number;
	readonly timezone: string;
	/** Instante absoluto do último outbound (a âncora, D-01). */
	readonly lastOutboundAt: Date;
	/** Instante absoluto do último inbound, ou `null` se nunca houve. */
	readonly lastInboundAt: Date | null;
	/** Task pendente deste `(conversation, index)`, se já existe. */
	readonly taskPendenteId: string | null;
	/** Instante absoluto do `scheduled_for` da task pendente. */
	readonly taskPendenteScheduledFor: Date | null;
	/** Job do `outbox` correspondente (`flup:conv:idx`), se existe. */
	readonly jobId: string | null;
	readonly jobStatus: string | null;
}

export interface CandidatosOpts {
	/** Instante de referência (relógio injetável). */
	readonly now: Date;
	/** Teto de toques (`settings.followup.max_touches`, clampado em 1..4). */
	readonly maxToques: number;
}

/**
 * Conversas "em cadência" com o estado do próximo toque.
 *
 * Os predicados de elegibilidade (D-08/R-001 reforçado): só lead com primeiro
 * contato humano, não opt-out, sem handoff ativo, em `bot_active`, não
 * encerrada/pausada, com `last_outbound_at` preenchido e já vencido, sem
 * resposta pendente (último inbound antes do último outbound) e cursor ainda
 * abaixo do teto.
 */
export const candidatosEmCadencia = async (
	db: Db,
	opts: CandidatosOpts,
): Promise<CandidatoCadencia[]> => {
	const resultado = await db.execute(sql`
		SELECT
			c.id AS conversation_id,
			c.lead_id,
			l.name AS nome,
			c.follow_up_index,
			c.timezone,
			(extract(epoch from (c.last_outbound_at AT TIME ZONE c.timezone)) * 1000)::bigint AS last_outbound_ms,
			(extract(epoch from (c.last_inbound_at AT TIME ZONE c.timezone)) * 1000)::bigint AS last_inbound_ms,
			st.id AS task_id,
			(extract(epoch from st.scheduled_for) * 1000)::bigint AS task_scheduled_ms,
			ob.id AS job_id,
			ob.status AS job_status
		FROM conversations c
		JOIN leads l ON l.id = c.lead_id
		LEFT JOIN scheduled_tasks st
			ON st.conversation_id = c.id
			AND st.follow_up_index = c.follow_up_index
			AND st.status = 'pending'
			AND st.task_type = 'followup'
		LEFT JOIN outbox ob
			ON ob.idempotency_key = 'flup:' || c.id::text || ':' || c.follow_up_index::text
		WHERE l.first_contact_by_human = true
			AND l.opt_out = false
			AND c.handoff_active = false
			AND c.engagement_mode = 'bot_active'
			AND c.state NOT IN ('encerrado', 'pausado', 'awaiting_human', 'human', 'copilot')
			AND c.closed_reason IS NULL
			AND c.last_outbound_at IS NOT NULL
			AND c.last_outbound_at <= ${opts.now}
			AND (c.last_inbound_at IS NULL OR c.last_inbound_at < c.last_outbound_at)
			AND c.follow_up_index < ${opts.maxToques}
	`);
	return (resultado as unknown as { rows: RowCandidato[] }).rows.map(
		paraCandidato,
	);
};

interface RowCandidato {
	conversation_id: string;
	lead_id: string;
	nome: string | null;
	follow_up_index: number | string;
	timezone: string;
	last_outbound_ms: string;
	last_inbound_ms: string | null;
	task_id: string | null;
	task_scheduled_ms: string | null;
	job_id: string | null;
	job_status: string | null;
}

const paraCandidato = (r: RowCandidato): CandidatoCadencia => ({
	conversationId: r.conversation_id,
	leadId: r.lead_id,
	nome: r.nome,
	followUpIndex: Number(r.follow_up_index),
	timezone: r.timezone,
	lastOutboundAt: new Date(Number(r.last_outbound_ms)),
	lastInboundAt:
		r.last_inbound_ms === null ? null : new Date(Number(r.last_inbound_ms)),
	taskPendenteId: r.task_id,
	taskPendenteScheduledFor:
		r.task_scheduled_ms === null ? null : new Date(Number(r.task_scheduled_ms)),
	jobId: r.job_id,
	jobStatus: r.job_status,
});

/** A task pendente de um `(conversation, index)`, com o estado do job. */
export interface ScheduledTaskPendente {
	readonly id: string;
	readonly status: string;
	/** Instante absoluto do `scheduled_for` (timestamptz). */
	readonly scheduledFor: Date;
	readonly jobId: string | null;
	readonly jobStatus: string | null;
}

/**
 * A task pendente de um toque específico. Usada pelo teste para provar que o
 * `scheduled_for` não reancora entre ticks (Pitfall 2) e pelo cancelamento para
 * saber se o job ainda existe.
 */
export const scheduledTaskPendente = async (
	db: Db,
	conversationId: string,
	index: number,
): Promise<ScheduledTaskPendente | null> => {
	const resultado = await db.execute(sql`
		SELECT
			st.id,
			st.status,
			(extract(epoch from st.scheduled_for) * 1000)::bigint AS scheduled_ms,
			ob.id AS job_id,
			ob.status AS job_status
		FROM scheduled_tasks st
		LEFT JOIN outbox ob
			ON ob.idempotency_key = 'flup:' || st.conversation_id::text || ':' || st.follow_up_index::text
		WHERE st.conversation_id = ${conversationId}
			AND st.follow_up_index = ${index}
			AND st.status = 'pending'
			AND st.task_type = 'followup'
		LIMIT 1
	`);
	const row = (
		resultado as unknown as {
			rows: {
				id: string;
				status: string;
				scheduled_ms: string;
				job_id: string | null;
				job_status: string | null;
			}[];
		}
	).rows[0];
	if (!row) return null;
	return {
		id: row.id,
		status: row.status,
		scheduledFor: new Date(Number(row.scheduled_ms)),
		jobId: row.job_id,
		jobStatus: row.job_status,
	};
};

/**
 * Tasks `followup` pendentes cuja conversa **saiiu da cadência** (resposta,
 * opt-out, handoff, pausa, encerramento ou cursor no teto). Devolve as colunas
 * que o cancelamento precisa para escolher o `cancelled_reason` canônico.
 */
export interface PendenteFora {
	readonly taskId: string;
	readonly conversationId: string;
	readonly followUpIndex: number;
	readonly jobId: string | null;
	readonly jobStatus: string | null;
	readonly optOut: boolean;
	readonly firstContactByHuman: boolean;
	readonly handoffActive: boolean;
	readonly engagementMode: string;
	readonly state: string;
	readonly closedReason: string | null;
	readonly lastInboundAt: Date | null;
	readonly lastOutboundAt: Date | null;
}

/**
 * O inverso exato da elegibilidade de `candidatosEmCadencia`: tasks pendentes
 * que ficaram para trás porque a conversa saiu de cadência. É por ser um
 * inverso que o tick cancela **exatamente** o que não está mais elegível — nunca
 * uma conversa que só está momentaneamente fora da janela (a janela é problema
 * do gate, não do agendador).
 */
export const pendentesForaDeCadencia = async (
	db: Db,
	opts: CandidatosOpts,
): Promise<PendenteFora[]> => {
	const resultado = await db.execute(sql`
		SELECT
			st.id AS task_id,
			c.id AS conversation_id,
			st.follow_up_index,
			ob.id AS job_id,
			ob.status AS job_status,
			l.opt_out,
			l.first_contact_by_human,
			c.handoff_active,
			c.engagement_mode,
			c.state,
			c.closed_reason,
			(extract(epoch from (c.last_inbound_at AT TIME ZONE c.timezone)) * 1000)::bigint AS last_inbound_ms,
			(extract(epoch from (c.last_outbound_at AT TIME ZONE c.timezone)) * 1000)::bigint AS last_outbound_ms
		FROM scheduled_tasks st
		JOIN conversations c ON c.id = st.conversation_id
		JOIN leads l ON l.id = c.lead_id
		LEFT JOIN outbox ob
			ON ob.idempotency_key = 'flup:' || st.conversation_id::text || ':' || st.follow_up_index::text
		WHERE st.status = 'pending'
			AND st.task_type = 'followup'
			AND (
				l.first_contact_by_human = false
				OR l.opt_out = true
				OR c.handoff_active = true
				OR c.engagement_mode <> 'bot_active'
				OR c.state IN ('encerrado', 'pausado', 'awaiting_human', 'human', 'copilot')
				OR c.closed_reason IS NOT NULL
				OR c.last_outbound_at IS NULL
				OR c.last_outbound_at > ${opts.now}
				OR (c.last_inbound_at IS NOT NULL AND c.last_inbound_at >= c.last_outbound_at)
				OR c.follow_up_index >= ${opts.maxToques}
			)
	`);
	return (resultado as unknown as { rows: RowFora[] }).rows.map(paraFora);
};

interface RowFora {
	task_id: string;
	conversation_id: string;
	follow_up_index: number | string;
	job_id: string | null;
	job_status: string | null;
	opt_out: boolean;
	first_contact_by_human: boolean;
	handoff_active: boolean;
	engagement_mode: string;
	state: string;
	closed_reason: string | null;
	last_inbound_ms: string | null;
	last_outbound_ms: string | null;
}

const paraFora = (r: RowFora): PendenteFora => ({
	taskId: r.task_id,
	conversationId: r.conversation_id,
	followUpIndex: Number(r.follow_up_index),
	jobId: r.job_id,
	jobStatus: r.job_status,
	optOut: r.opt_out,
	firstContactByHuman: r.first_contact_by_human,
	handoffActive: r.handoff_active,
	engagementMode: r.engagement_mode,
	state: r.state,
	closedReason: r.closed_reason,
	lastInboundAt:
		r.last_inbound_ms === null ? null : new Date(Number(r.last_inbound_ms)),
	lastOutboundAt:
		r.last_outbound_ms === null ? null : new Date(Number(r.last_outbound_ms)),
});

export interface ReconciliarOpts {
	readonly now: Date;
	readonly maxToques: number;
}

export interface ReconciliarResultado {
	/** Tasks pendentes cujo job no `outbox` já era terminal e que foram fechadas. */
	readonly fechadas: number;
	/** Candidatos em cadência ainda SEM task pendente — precisam ser recriados. */
	readonly orfas: number;
}

/**
 * Reconcilia o ledger (`scheduled_tasks`) com o `outbox`.
 *
 * (1) Fecha tasks pendentes cujo job já é **terminal** no `outbox`: `sent` →
 * `done`, `failed`/`abandoned` → `failed`. (2) Para cada job `sent`, avança o
 * cursor `follow_up_index` (D-01: o cursor conta toques **enviados**), com guarda
 * de concorrência (`WHERE follow_up_index = idx`). Isso fecha o buraco de um
 * crash entre o envio (`markSent`) e o fechamento da task — a próxima passada
 * do tick percebe o envio e move o cursor.
 *
 * Depois relê a elegibilidade para contar as **órfãs** (candidatos sem task
 * pendente) — o sinal para o tick re-agendar o que o avanço de cursor liberou.
 *
 * Cada statement roda no `db` recebido, sem transação interna: os guards
 * (`status='pending'`, `WHERE follow_up_index = idx`) tornam a operação
 * idempotente, então um crash no meio se autocura na próxima passada, e o
 * teste pode envolver tudo numa transação revertida.
 */
export const reconciliar = async (
	db: Db,
	opts: ReconciliarOpts,
): Promise<ReconciliarResultado> => {
	const fechadasResultado = await db.execute(sql`
		UPDATE scheduled_tasks st
		SET
			status = CASE WHEN ob.status = 'sent' THEN 'done' ELSE 'failed' END,
			last_error = CASE WHEN ob.status = 'sent' THEN st.last_error ELSE COALESCE(ob.last_error, st.last_error) END
		FROM outbox ob
		WHERE st.status = 'pending'
			AND st.task_type = 'followup'
			AND ob.idempotency_key = 'flup:' || st.conversation_id::text || ':' || st.follow_up_index::text
			AND ob.status IN ('sent', 'failed', 'abandoned')
		RETURNING st.conversation_id, st.follow_up_index, ob.status AS job_status
	`);
	const linhas = (
		fechadasResultado as unknown as {
			rows: {
				conversation_id: string;
				follow_up_index: number | string;
				job_status: string;
			}[];
		}
	).rows;

	for (const linha of linhas) {
		if (linha.job_status !== "sent") continue;
		const idx = Number(linha.follow_up_index);
		await db.execute(sql`
			UPDATE conversations
			SET follow_up_index = ${idx + 1}
			WHERE id = ${linha.conversation_id} AND follow_up_index = ${idx}
		`);
	}

	const candidatos = await candidatosEmCadencia(db, opts);
	const orfas = candidatos.filter((c) => c.taskPendenteId === null).length;
	return { fechadas: linhas.length, orfas };
};

// ---------------------------------------------------------------------------
// Dreno de catch-up (R-007, D-07) e cancelamento por resposta (D-12)
// ---------------------------------------------------------------------------

/** Um job de follow-up/catch-up já vencido, com o fuso da conversa. */
export interface VencidoOutbox {
	readonly outboxId: string;
	readonly conversationId: string;
	readonly timezone: string;
	readonly origin: string;
	/** Instante absoluto (epoch do naive `scheduled_for` interpretado no fuso). */
	readonly scheduledFor: Date;
}

export interface VencidosOpts {
	readonly now: Date;
	/** Teto defensivo da varredura; o dreno nunca precisa de mais que isto. */
	readonly limite?: number;
}

/**
 * Jobs de cadência vencidos, FIFO por `scheduled_for` — a matéria-prima do dreno.
 *
 * O predicado `o.scheduled_for <= now AT TIME ZONE c.timezone` é o mesmo cuidado
 * de fuso do resto do módulo: `scheduled_for` é `timestamp` sem fuso (wall time
 * SP), então o `now()` tem de virar o wall time da conversa ANTES de comparar.
 * Comparar um `now` UTC cru contra um naive adiantaria 3h de manhã.
 */
export const vencidosNoOutbox = async (
	db: Db,
	opts: VencidosOpts,
): Promise<VencidoOutbox[]> => {
	const limite = opts.limite ?? 500;
	const resultado = await db.execute(sql`
		SELECT
			o.id AS outbox_id,
			o.conversation_id,
			c.timezone,
			o.origin,
			(extract(epoch from (o.scheduled_for AT TIME ZONE c.timezone)) * 1000)::bigint AS scheduled_ms
		FROM outbox o
		JOIN conversations c ON c.id = o.conversation_id
		WHERE o.status = 'pending'
			AND o.origin IN ('followup', 'catchup')
			AND o.scheduled_for <= (${opts.now}::timestamptz AT TIME ZONE c.timezone)
		ORDER BY o.scheduled_for, o.id
		LIMIT ${limite}
	`);
	return (
		resultado as unknown as {
			rows: {
				outbox_id: string;
				conversation_id: string;
				timezone: string;
				origin: string;
				scheduled_ms: string;
			}[];
		}
	).rows.map((r) => ({
		outboxId: r.outbox_id,
		conversationId: r.conversation_id,
		timezone: r.timezone,
		origin: r.origin,
		scheduledFor: new Date(Number(r.scheduled_ms)),
	}));
};

/**
 * Conversas que **já receberam** um follow-up hoje (no fuso da conversa).
 *
 * É o teto "1 follow-up por lead por dia": o dreno não manda dois no mesmo dia
 * civil, mesmo que a cadência tenha dois toques vencidos. `messages.created_at`
 * é naive (wall time SP) — por isso o `AT TIME ZONE` no `::date`.
 */
export const jaEnviouFollowUpHoje = async (
	db: Db,
	opts: { readonly now: Date },
): Promise<Set<string>> => {
	const resultado = await db.execute(sql`
		SELECT DISTINCT o.conversation_id AS conversation_id
		FROM outbox o
		JOIN conversations c ON c.id = o.conversation_id
		JOIN messages m ON m.id = o.message_id
		WHERE o.origin IN ('followup', 'catchup')
			AND o.status = 'sent'
			AND (m.created_at AT TIME ZONE c.timezone)::date
				= (${opts.now}::timestamptz AT TIME ZONE c.timezone)::date
	`);
	return new Set(
		(resultado as unknown as { rows: { conversation_id: string }[] }).rows.map(
			(r) => r.conversation_id,
		),
	);
};

/**
 * Marca o job como catch-up **iminente**: muda a origem para `catchup` e o
 * `scheduled_for` para o instante calculado (base + jitter acumulado). O
 * `WHERE status='pending'` impede que um job já reservado seja reaproveitado.
 */
export const marcarCatchupIminente = async (
	db: Db,
	outboxId: string,
	scheduledFor: Date,
): Promise<void> => {
	await db.execute(sql`
		UPDATE outbox
		SET origin = 'catchup', scheduled_for = ${scheduledFor}
		WHERE id = ${outboxId} AND status = 'pending'
	`);
};

/** Uma conversa que esgotou a cadência sem resposta — candidata a encerrar. */
export interface ConversaParaEncerrar {
	readonly conversationId: string;
	readonly state: string;
	readonly followUpIndex: number;
}

/**
 * Conversas no teto de toques **sem resposta**: o cursor alcançou `maxToques` e
 * o último inbound (se houve) é ANTERIOR ao último outbound. Read receipts não
 * contam — só o watermark de inbound (D-12). Exclui estados terminais para que
 * uma conversa já encerrada/pausada/handoff não seja reencerrada.
 */
export const conversasParaEncerrar = async (
	db: Db,
	opts: ReconciliarOpts,
): Promise<ConversaParaEncerrar[]> => {
	const resultado = await db.execute(sql`
		SELECT c.id AS conversation_id, c.state, c.follow_up_index
		FROM conversations c
		WHERE c.follow_up_index >= ${opts.maxToques}
			AND c.state NOT IN ('encerrado', 'pausado', 'awaiting_human', 'human', 'copilot')
			AND c.closed_reason IS NULL
			AND c.last_outbound_at IS NOT NULL
			AND (c.last_inbound_at IS NULL OR c.last_inbound_at < c.last_outbound_at)
	`);
	return (
		resultado as unknown as {
			rows: {
				conversation_id: string;
				state: string;
				follow_up_index: number | string;
			}[];
		}
	).rows.map((r) => ({
		conversationId: r.conversation_id,
		state: r.state,
		followUpIndex: Number(r.follow_up_index),
	}));
};

/**
 * Derruba a cadência pendente de uma conversa que respondeu (D-12). Cancela a
 * `scheduled_tasks` pendente E o job `pending`/`reserved` do `outbox` — com o
 * mesmo motivo auditável (`cancelled_reason` / `last_error`). Nada é apagado
 * (Pattern 3): a task vira `abandoned` com rastro.
 *
 * Chamado dentro da transação do inbound (Pitfall 3): a mensagem do lead e o
 * cancelamento são um só commit.
 */
export const cancelarCadenciaPendente = async (
	db: Db,
	conversationId: string,
	motivo: string,
): Promise<void> => {
	await db.execute(sql`
		UPDATE scheduled_tasks
		SET status = 'abandoned', cancelled_at = now(), cancelled_reason = ${motivo}
		WHERE conversation_id = ${conversationId}
			AND status = 'pending'
			AND task_type = 'followup'
	`);
	await db.execute(sql`
		UPDATE outbox
		SET status = 'abandoned', last_error = ${motivo}
		WHERE conversation_id = ${conversationId}
			AND status IN ('pending', 'reserved')
			AND origin IN ('followup', 'catchup')
	`);
};
