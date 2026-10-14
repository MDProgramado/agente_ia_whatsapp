/**
 * Escritas de `leads` com invariantes de compliance (Task 2/3 do 02-02).
 *
 * Duas operações, e as duas existem porque a regra não pode morar só no `CHECK`:
 *
 *  - `applyOptOut` — o opt-out é IRREVERSÍVEL (R-024/AR-005). Ele só ATIVA
 *    (`false → true`) e, exatamente quando ativa, grava a prova em
 *    `optout_ledger` (append-only). Um segundo pedido do mesmo lead não duplica
 *    a prova (`opt_out` já é `true` → 0 linhas afetadas → sem INSERT). Ambas as
 *    escritas vão numa transação: senão um `opt_out=true` sem linha no ledger
 *    seria um opt-out sem prova — irreversível e não auditável ao mesmo tempo.
 *
 *  - `updateQualification` — a qualificação (R-051) é ACUMULATIVA: um valor
 *    conhecido nunca é rebaixado para "desconhecido" por uma extração seguinte
 *    que não o viu. `verba`/`decisao` são `jsonb` em `conversations.qualification`
 *    (nunca texto), e a decisão de estado continua em `resolveNextState`, não aqui.
 *
 * O `UPDATE` reverso (`leads.opt_out = false`) não é proibido aqui: ele é barrado
 * no BANCO pela função `fn_opt_out_irreversible` (migration
 * `0004_guards_and_audit.sql`, trigger `trg_leads_opt_out_irreversivel`). Nenhum
 * caminho de TypeScript contorna isso — é o ponto de mover a invariante para o DDL.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../client.js";

/** `verba`/`decisao` em 0..2 ou desconhecido. Mesma forma que `llm-context.ts`. */
export interface Qualificacao {
	readonly verba: number | null;
	readonly decisao: number | null;
}

export interface OptOutInput {
	readonly leadId: string;
	/** O texto do pedido — a prova de que ele aconteceu (R-024). */
	readonly rawContent: string;
	readonly legalBasis: string;
	readonly purpose: string;
	/**
	 * Quem detectou. `deterministic` é o matcher (autoridade); `llm_signal` fica
	 * disponível para registrar um reforço, jamais para decidir (D-14).
	 */
	readonly detectedBy?: "deterministic" | "llm_signal";
	readonly occurredAt?: Date;
}

/**
 * Ativa o opt-out e registra a prova, atomicamente. Devolve `true` só quando o
 * estado MUDOU (`false → true`) e o ledger foi gravado; `false` quando o lead já
 * estava em opt-out (idempotente — não duplica a prova).
 */
export const applyOptOut = async (
	db: Db,
	input: OptOutInput,
): Promise<boolean> =>
	db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;
		const atualizado = await tx.execute(sql`
			update leads set opt_out = true
			where id = ${input.leadId} and opt_out = false
		`);
		const linhasAfetadas =
			(atualizado as { rowCount?: number | null }).rowCount ?? 0;
		if (linhasAfetadas !== 1) return false;

		await tx.execute(sql`
			insert into optout_ledger (
				lead_id, event_type, source, detected_by, raw_content,
				legal_basis, purpose, occurred_at
			)
			values (
				${input.leadId},
				'opt_out',
				'auto_detected',
				${input.detectedBy ?? "deterministic"},
				${input.rawContent},
				${input.legalBasis},
				${input.purpose},
				${input.occurredAt ?? new Date()}
			)
		`);
		return true;
	});

/**
 * Reduz o `jsonb` cru a `number | null`. Um valor corrompido (string, booleano)
 * vira `null` (desconhecido), nunca vira número — desconhecido é recuperável,
 * número errado não é.
 */
const paraQualificacao = (bruto: unknown): Qualificacao => {
	const obj = (bruto ?? {}) as { verba?: unknown; decisao?: unknown };
	return {
		verba: typeof obj.verba === "number" ? obj.verba : null,
		decisao: typeof obj.decisao === "number" ? obj.decisao : null,
	};
};

export interface QualificationInput {
	readonly conversationId: string;
	readonly verba: number | null;
	readonly decisao: number | null;
}

/**
 * Mescla a qualificação extraída com a já persistida (acumulativa: o novo valor
 * só vence quando é conhecido) e devolve o resultado. `FOR UPDATE` serializa
 * duas extrações concorrentes sobre a mesma conversa — sem ele, a última escrita
 * venceria e um dos valores seria perdido.
 *
 * A "evidência" é a corrida de Camada 1 registrada em `llm_runs` (`model`,
 * `zod_parse_ok`), NÃO o corpo da mensagem: duplicar o texto do lead aqui
 * colocaria PII fora de `messages`, que é a tabela com prazo de retenção
 * (Pitfall 4). Por isso o jsonb guarda `verba`/`decisao` e a procedência, não o
 * trecho cru.
 */
export const updateQualification = async (
	db: Db,
	input: QualificationInput,
): Promise<Qualificacao> =>
	db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;
		const lido = await tx.execute(sql`
			select qualification from conversations
			where id = ${input.conversationId}
			for update
		`);
		const row = (lido as unknown as { rows: { qualification: unknown }[] })
			.rows[0];
		if (!row) {
			throw new Error(
				`updateQualification: conversa ${input.conversationId} nao encontrada`,
			);
		}

		const anterior = paraQualificacao(row.qualification);
		const verba = input.verba ?? anterior.verba;
		const decisao = input.decisao ?? anterior.decisao;

		await tx.execute(sql`
			update conversations
			set qualification = ${JSON.stringify({ verba, decisao, fonte: "llm_extracao" })}::jsonb
			where id = ${input.conversationId}
		`);

		return { verba, decisao };
	});
