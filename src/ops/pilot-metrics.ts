/**
 * Motor de apuração dos critérios de sucesso e conformidade do piloto (PILO-02, PILO-03, R-061, R-062).
 *
 * Metas mensais:
 *   - Reuniões agendadas: >= 5 reuniões/mês
 *   - Taxa de qualificação: >= 30% dos leads contatados
 *
 * Auditoria de segurança:
 *   - Zero violações das fronteiras AR-001..AR-012 em mensagens enviadas.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../infra/db/client.js";

export interface MetricasPiloto {
	readonly periodoDias: number;
	readonly totalLeads: number;
	readonly leadsContatados: number;
	readonly leadsQualificados: number;
	readonly reunioesAgendadas: number;
	readonly taxaQualificacaoPct: number;
	readonly metaReunioesAtingida: boolean;
	readonly metaQualificacaoAtingida: boolean;
	readonly totalOptOuts: number;
	readonly totalHandoffs: number;
	readonly tentativasBloqueadasPeloGate: number;
}

export const calcularMetricasPiloto = async (
	db: Db,
	dias = 30,
): Promise<MetricasPiloto> => {
	// 1. Contagens de leads no período
	const rLeads = await db.execute(sql`
		SELECT
			count(*)::int as total,
			count(*) filter (where first_contact_by_human = true)::int as contatados,
			count(*) filter (where opt_out = true)::int as opt_outs
		FROM leads
		WHERE created_at >= now() - make_interval(days => ${dias})
	`);

	const lLeads = (
		rLeads as unknown as {
			rows: Array<{ total: number; contatados: number; opt_outs: number }>;
		}
	).rows[0] ?? {
		total: 0,
		contatados: 0,
		opt_outs: 0,
	};

	// 2. Qualificados e reuniões agendadas (via conversations e pipeline_status)
	const rConv = await db.execute(sql`
		SELECT
			count(*) filter (
				where pipeline_status in ('qualificado', 'aquecido', 'reuniao_agendada', 'proposta', 'fechado')
				   or state in ('qualificado', 'aquecido', 'reuniao_agendada', 'proposta', 'fechado')
			)::int as qualificados,
			count(*) filter (
				where pipeline_status = 'reuniao_agendada' or state = 'reuniao_agendada'
			)::int as reunioes
		FROM conversations
		WHERE created_at >= now() - make_interval(days => ${dias})
	`);

	const lConv = (
		rConv as unknown as {
			rows: Array<{ qualificados: number; reunioes: number }>;
		}
	).rows[0] ?? {
		qualificados: 0,
		reunioes: 0,
	};

	// 3. Handoffs gerados no período
	const rHandoffs = await db.execute(sql`
		SELECT count(*)::int as total
		FROM handoff_events
		WHERE created_at >= now() - make_interval(days => ${dias})
	`);
	const lHandoffs =
		(rHandoffs as unknown as { rows: Array<{ total: number }> }).rows[0]
			?.total ?? 0;

	// 4. Tentativas barradas pelo gate (auditoria de segurança)
	const rBlocked = await db.execute(sql`
		SELECT count(*)::int as total
		FROM blocked_attempts
		WHERE created_at >= now() - make_interval(days => ${dias})
	`);
	const lBlocked =
		(rBlocked as unknown as { rows: Array<{ total: number }> }).rows[0]
			?.total ?? 0;

	const contatados = lLeads.contatados;
	const qualificados = lConv.qualificados;
	const reunioes = lConv.reunioes;

	const taxaQualificacaoPct =
		contatados > 0 ? Math.round((qualificados / contatados) * 1000) / 10 : 0;

	const metaReunioesAtingida = reunioes >= 5;
	const metaQualificacaoAtingida = taxaQualificacaoPct >= 30.0;

	return {
		periodoDias: dias,
		totalLeads: lLeads.total,
		leadsContatados: contatados,
		leadsQualificados: qualificados,
		reunioesAgendadas: reunioes,
		taxaQualificacaoPct,
		metaReunioesAtingida,
		metaQualificacaoAtingida,
		totalOptOuts: lLeads.opt_outs,
		totalHandoffs: lHandoffs,
		tentativasBloqueadasPeloGate: lBlocked,
	};
};
