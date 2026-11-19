#!/usr/bin/env node
/**
 * CLI de apuração mensal de KPIs e conformidade do piloto (PILO-02, PILO-03, R-061, R-062).
 *
 * Executa: npm run pilot:report
 */
import { env } from "../config/env.js";
import { closeDb, openDb } from "../infra/db/client.js";
import { calcularMetricasPiloto } from "../ops/pilot-metrics.js";

const main = async () => {
	const conn = await openDb(env.DATABASE_URL);
	try {
		console.log("==================================================");
		console.log("   RELATÓRIO MENSAL DO PILOTO DE PROSPECÇÃO B2B   ");
		console.log("==================================================\n");

		const m = await calcularMetricasPiloto(conn.db, 30);

		console.log(`Período analisado: Últimos ${m.periodoDias} dias\n`);

		console.log("1. FUNIL E CRITÉRIOS DE SUCESSO (R-061)");
		console.log("--------------------------------------------------");
		console.log(`Total de leads importados:       ${m.totalLeads}`);
		console.log(`Leads abordados (1º contato):    ${m.leadsContatados}`);
		console.log(`Leads qualificados:             ${m.leadsQualificados}`);
		console.log(
			`Taxa de qualificação atingida:   ${m.taxaQualificacaoPct}% (Meta: >= 30%)`,
		);
		console.log(
			`Status da meta de qualificação:  ${m.metaQualificacaoAtingida ? "✅ ATINGIDA" : "❌ ABAIXO DA META"}\n`,
		);

		console.log(
			`Reuniões agendadas:             ${m.reunioesAgendadas} (Meta: >= 5)`,
		);
		console.log(
			`Status da meta de reuniões:      ${m.metaReunioesAtingida ? "✅ ATINGIDA" : "❌ ABAIXO DA META"}\n`,
		);

		console.log("2. AUDITORIA DE SEGURANÇA E COMPLIANCE");
		console.log("--------------------------------------------------");
		console.log(`Total de handoffs humanos:       ${m.totalHandoffs}`);
		console.log(`Opt-outs solicitados e gravados: ${m.totalOptOuts}`);
		console.log(
			`Violações barradas pelo gate:    ${m.tentativasBloqueadasPeloGate}`,
		);
		console.log("--------------------------------------------------\n");

		if (m.metaReunioesAtingida && m.metaQualificacaoAtingida) {
			console.log(
				"🎯 RESULTADO: PILOTO APROVADO COM SUCESSO NOS DOIS CRITÉRIOS!",
			);
		} else {
			console.log(
				"ℹ️  RESULTADO: Piloto em andamento ou necessitando calibração de público/cadência.",
			);
		}
		console.log("\n==================================================");
	} finally {
		await closeDb(conn);
	}
};

main().catch((err) => {
	console.error("Erro ao gerar relatório do piloto:", err);
	process.exit(1);
});
