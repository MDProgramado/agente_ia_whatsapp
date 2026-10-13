/**
 * Relat�rio di�rio (R-061, R-062).
 */
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

export async function dailyReport(db: Db, day: string): Promise<DailyReport> {
	const reun = await db.execute<any>("select count(*) as c from status_history where date(changed_at at time zone 'America/Sao_Paulo') = '" + day + "' and to_state in ('qualificando','aquecido') and changed_by='bot'");
	const qual = await db.execute<any>("select count(distinct conversation_id) as c from status_history where date(changed_at at time zone 'America/Sao_Paulo') = '" + day + "' and to_state in ('qualificando','aquecido')");
	const novos = await db.execute<any>("select coalesce(sum(count), 0) as c from daily_counters where day = '" + day + "' and kind='new_contacts'");
	const r = Number(reun.rows?.[0]?.c || 0);
	const q = Number(qual.rows?.[0]?.c || 0);
	const n = Number(novos.rows?.[0]?.c || 0);
	const taxa = n > 0 ? (q / n) * 100 : null;
	return {
		day,
		reunioesAgendadas: r,
		reunioes_agendadas: r,
		leadsQualificados: q,
		leads_qualificados: q,
		leadsNovos: n,
		leads_novos: n,
		taxaQualificacao: taxa,
		taxa_qualificacao: taxa,
		metaReunioesMes: 5,
		metaTaxaQualificacao: 30,
	};
}