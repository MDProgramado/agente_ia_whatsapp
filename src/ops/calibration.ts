/**
 * Motor de calibração de cadência de follow-up baseado em dados reais (PILO-03).
 *
 * Analisa as conversas reais do piloto para extrair:
 *   1. Tempo mediano até a primeira resposta inbound do lead (em minutos/horas).
 *   2. Taxa de resposta por toque da cadência (Toque 0: primeiro contato, Toque 1: 1h, Toque 2: 1d, etc).
 */
import { sql } from "drizzle-orm";
import type { Db } from "../infra/db/client.js";

export interface MetricasToque {
	readonly toqueIndex: number;
	readonly totalDisparados: number;
	readonly totalRespostas: number;
	readonly taxaRespostaPct: number;
}

export interface DiagnosticoCadencia {
	readonly totalConversas: number;
	readonly conversasComResposta: number;
	readonly taxaGeralRespostaPct: number;
	readonly tempoMedianoPrimeiraRespostaMin: number | null;
	readonly toques: MetricasToque[];
}

export const calcularDiagnosticoCadencia = async (
	db: Db,
): Promise<DiagnosticoCadencia> => {
	// 1. Total de conversas e total com ao menos uma resposta
	const rTotais = await db.execute(sql`
		SELECT
			count(*)::int as total,
			count(*) filter (where last_inbound_at is not null)::int as com_resposta
		FROM conversations
	`);

	const linhaTotais = (
		rTotais as unknown as {
			rows: Array<{ total: number; com_resposta: number }>;
		}
	).rows[0] ?? {
		total: 0,
		com_resposta: 0,
	};

	const total = linhaTotais.total;
	const comResposta = linhaTotais.com_resposta;
	const taxaGeralRespostaPct =
		total > 0 ? Math.round((comResposta / total) * 1000) / 10 : 0;

	// 2. Cálculo do tempo mediano até a primeira resposta (diferença entre 1º outbound e 1º inbound)
	const rMediana = await db.execute(sql`
		WITH tempos AS (
			SELECT
				extract(epoch from (c.last_inbound_at - c.last_outbound_at)) / 60.0 as delta_min
			FROM conversations c
			WHERE c.last_inbound_at IS NOT NULL
			  AND c.last_outbound_at IS NOT NULL
			  AND c.last_inbound_at >= c.last_outbound_at
		)
		SELECT
			percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_min) as mediana_min
		FROM tempos
	`);

	const linhaMediana = (
		rMediana as unknown as { rows: Array<{ mediana_min: number | null }> }
	).rows[0];
	const tempoMedianoPrimeiraRespostaMin =
		linhaMediana?.mediana_min != null
			? Math.round(Number(linhaMediana.mediana_min) * 10) / 10
			: null;

	// 3. Respostas por toque de follow-up (0 a 4)
	const toques: MetricasToque[] = [];
	for (let i = 0; i <= 4; i++) {
		const rToque = await db.execute(sql`
			SELECT
				count(*)::int as disparados,
				count(*) filter (where last_inbound_at is not null and follow_up_index = ${i})::int as respostas
			FROM conversations
			WHERE follow_up_index >= ${i}
		`);

		const l = (
			rToque as unknown as {
				rows: Array<{ disparados: number; respostas: number }>;
			}
		).rows[0] ?? {
			disparados: 0,
			respostas: 0,
		};

		const disparados = l.disparados;
		const respostas = l.respostas;
		const taxa =
			disparados > 0 ? Math.round((respostas / disparados) * 1000) / 10 : 0;

		toques.push({
			toqueIndex: i,
			totalDisparados: disparados,
			totalRespostas: respostas,
			taxaRespostaPct: taxa,
		});
	}

	return {
		totalConversas: total,
		conversasComResposta: comResposta,
		taxaGeralRespostaPct,
		tempoMedianoPrimeiraRespostaMin,
		toques,
	};
};
