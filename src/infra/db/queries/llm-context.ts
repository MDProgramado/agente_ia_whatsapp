/**
 * Montagem do contexto que alimenta a LLM (D-08/D-16) — o payload do sanduíche.
 *
 * Este módulo só LÊ. Ele reúne, numa instrução só, o que a Camada 1 (extração) e
 * a Camada 3 (geração) precisam: dados do lead, a 1ª mensagem do consultor, o
 * histórico recente e a última mensagem do lead. Quem monta o prompt — e mascara
 * a PII — é `src/domain/llm/prompt-builder.ts`; aquele é o choke-point de egresso,
 * e este arquivo entrega o payload ainda **cru** para que o mascaramento aconteça
 * num único lugar (Pitfall 4).
 *
 * ## Por que o histórico filtra `origin`
 *
 * `messages.origin` aceita `lead`, `bot`, `admin`, `ai_suggestion` e `system`.
 * Só os três primeiros são troca REAL com o lead. `ai_suggestion` é rascunho de
 * shadow que **nunca saiu** (D-03/D-04); `system` é registro interno. Incluí-los
 * faria o modelo acreditar que já mandou um texto que o lead nunca viu — e
 * responder como se a conversa tivesse andado. Por isso o `where` fecha em
 * `('lead','admin','bot')`.
 *
 * O mesmo vale para `adminPrimeiraMensagem`: é a mensagem que satisfaz o guard 0
 * (R-001) e ancora a persona. A última mensagem do lead é o que a Camada 1
 * classifica.
 */
import { sql } from "drizzle-orm";
import type { PayloadLlm } from "../../../domain/llm/prompt-builder.js";
import {
	ALLOWED,
	type Estado,
} from "../../../domain/orchestrator/transitions.js";
import type { Db } from "../client.js";
import { conversations, leads, messages } from "../schema.js";

/** Qualificação dinâmica (R-051): verba e decisão, cada uma 0..2 ou desconhecida. */
export interface Qualificacao {
	readonly verba: number | null;
	readonly decisao: number | null;
}

/** O contexto completo de uma conversa: payload mascarável + estado + qualificação. */
export interface LlmContexto {
	readonly leadId: string;
	readonly payload: PayloadLlm;
	readonly state: Estado;
	readonly qualification: Qualificacao;
}

/** Teto de histórico. Conversa de prospecção não tem mil turnos; o teto é só sanidade. */
export const HISTORY_LIMIT_PADRAO = 40;
const HISTORY_LIMIT_MAX = 200;

/** Os `Estado` válidos, derivados da própria FSM — não uma lista paralela. */
const ESTADOS = Object.keys(ALLOWED) as Estado[];

const paraEstado = (bruto: unknown): Estado =>
	ESTADOS.find((e) => e === bruto) ?? "novo";

/** `author` do histórico já reduzido aos três papéis que o prompt entende. */
type Autor = PayloadLlm["historico"][number]["autor"];

const paraAutor = (origin: unknown): Autor =>
	origin === "lead" ? "lead" : origin === "admin" ? "admin" : "bot";

/**
 * Lê o contexto de uma conversa. Devolve `null` quando a conversa não existe —
 * e isso é declarado: quem chama trata como "nada a rascunhar", nunca como um
 * convite a inventar contexto.
 */
export const loadLlmContext = async (
	db: Db,
	conversationId: string,
	opts: { readonly historyLimit?: number } = {},
): Promise<LlmContexto | null> => {
	const limite = Math.min(
		Math.max(Math.trunc(opts.historyLimit ?? HISTORY_LIMIT_PADRAO), 1),
		HISTORY_LIMIT_MAX,
	);

	const resultado = await db.execute(sql`
		select
			c.lead_id,
			c.state,
			c.qualification,
			l.name,
			l.phone_number,
			l.address_line,
			(
				select m.body from ${messages} m
				where m.conversation_id = c.id and m.origin = 'admin'
				order by m.created_at, m.id
				limit 1
			) as admin_primeira,
			(
				select m.body from ${messages} m
				where m.conversation_id = c.id and m.direction = 'in'
				order by m.created_at desc, m.id desc
				limit 1
			) as ultima_inbound,
			coalesce(
				(
					select jsonb_agg(
						jsonb_build_object('origin', t.origin, 'body', t.body)
						order by t.created_at, t.id
					)
					from (
						select m.origin, m.body, m.created_at, m.id
						from ${messages} m
						where m.conversation_id = c.id
							and m.origin in ('lead', 'admin', 'bot')
						order by m.created_at desc, m.id desc
						limit ${limite}
					) t
				),
				'[]'::jsonb
			) as historico
		from ${conversations} c
		join ${leads} l on l.id = c.lead_id
		where c.id = ${conversationId}
	`);

	const row = (resultado as unknown as { rows: Record<string, unknown>[] })
		.rows[0];
	if (!row) return null;

	return {
		leadId: row.lead_id as string,
		payload: {
			lead: {
				name: (row.name as string | null) ?? null,
				phoneNumber: (row.phone_number as string | null) ?? null,
				addressLine: (row.address_line as string | null) ?? null,
			},
			adminPrimeiraMensagem: (row.admin_primeira as string | null) ?? null,
			historico: paraHistorico(row.historico),
			ultimaMensagem: (row.ultima_inbound as string | null) ?? null,
		},
		state: paraEstado(row.state),
		qualification: paraQualificacao(row.qualification),
	};
};

const paraHistorico = (bruto: unknown): PayloadLlm["historico"] => {
	if (!Array.isArray(bruto)) return [];
	return bruto.map((item) => {
		const obj = item as { origin?: unknown; body?: unknown };
		return {
			autor: paraAutor(obj.origin),
			texto: typeof obj.body === "string" ? obj.body : "",
		};
	});
};

/**
 * `qualification` é `jsonb` (default `'{}'`), então a ausência das chaves é o
 * caso comum — não um erro. Os valores são reduzidos a `number | null`; um
 * `string`/booleano corrompido vira `null` (desconhecido), nunca vira número.
 */
const paraQualificacao = (bruto: unknown): Qualificacao => {
	const obj = (bruto ?? {}) as { verba?: unknown; decisao?: unknown };
	return {
		verba: typeof obj.verba === "number" ? obj.verba : null,
		decisao: typeof obj.decisao === "number" ? obj.decisao : null,
	};
};
