/**
 * Relatório diário do piloto (R-061, R-062, T-01-30).
 *
 * A base de cálculo é `status_history` — o HISTÓRICO de transições, não o estado
 * atual: "quantas reuniões agendadas este mês" é uma pergunta sobre eventos
 * registrados, e um painel que conta a partir do estado de agora só responde
 * "como está agora".
 *
 * FÓRMULA, com o denominador escrito explicitamente:
 * - `reunioesAgendadas` = transições em `status_history` para
 *   `to_state IN ('qualificando','aquecido')` no dia, com `changed_by = 'bot'`;
 * - `leadsQualificados` = DISTINCT `conversation_id` que chegaram a
 *   `qualificando`/`aquecido` no dia (qualquer ator — a qualificação é do lead,
 *   não do bot);
 * - `leadsNovos` (DENOMINADOR) = `daily_counters.kind = 'new_contacts'` do mesmo dia;
 * - `taxaQualificacao` = `leadsQualificados / leadsNovos * 100`. Denominador zero
 *   devolve `null`, NUNCA `0`: "0% de qualificação" e "sem dados" são afirmações
 *   diferentes (T-01-30).
 *
 * Metas mensais do piloto: 5 reuniões (R-061) e 30% de taxa (R-062).
 */
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.js";

export type DailyReport = {
	day: string;
	reunioesAgendadas: number;
	reunioes_agendadas?: number;
	leadsQualificados: number;
	leads_qualificados?: number;
	leadsNovos: number;
	leads_novos?: number;
	taxaQualificacao: number | null;
	taxa_qualificacao?: number | null;
	metaReunioesMes?: number;
	metaTaxaQualificacao?: number;
};

const META_REUNIOES_MES = 5;
const META_TAXA_QUALIFICACAO = 30;

/**
 * `db.execute` no node-postgres devolve um QueryResult; o valor vive em `.rows`.
 * A mesma conversão usada em `counters.ts` — a contagem é sempre a coluna `c`.
 */
const contagem = async (db: Db, consulta: SQL): Promise<number> => {
	const resultado = await db.execute(consulta);
	const linhas = (resultado as unknown as { rows: { c: number | string }[] })
		.rows;
	return Number(linhas[0]?.c ?? 0);
};

export async function dailyReport(db: Db, day: string): Promise<DailyReport> {
	const reunioes = await contagem(
		db,
		sql`
			select count(*) as c from status_history
			where date(changed_at at time zone 'America/Sao_Paulo') = ${day}::date
				and to_state in ('qualificando','aquecido')
				and changed_by = 'bot'
		`,
	);

	const qualificados = await contagem(
		db,
		sql`
			select count(distinct conversation_id) as c from status_history
			where date(changed_at at time zone 'America/Sao_Paulo') = ${day}::date
				and to_state in ('qualificando','aquecido')
		`,
	);

	const novos = await contagem(
		db,
		sql`
			select coalesce(sum(count), 0) as c from daily_counters
			where day = ${day}::date and kind = 'new_contacts'
		`,
	);

	// Denominação explícita: sem contador de novos contatos, a taxa é desconhecida
	// (`null`), não 0% (T-01-30).
	const taxa = novos > 0 ? (qualificados / novos) * 100 : null;

	return {
		day,
		reunioesAgendadas: reunioes,
		reunioes_agendadas: reunioes,
		leadsQualificados: qualificados,
		leads_qualificados: qualificados,
		leadsNovos: novos,
		leads_novos: novos,
		taxaQualificacao: taxa,
		taxa_qualificacao: taxa,
		metaReunioesMes: META_REUNIOES_MES,
		metaTaxaQualificacao: META_TAXA_QUALIFICACAO,
	};
}
