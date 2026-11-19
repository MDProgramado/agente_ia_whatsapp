#!/usr/bin/env node
/**
 * CLI de calibração de cadência (PILO-03).
 *
 * Executa: npm run pilot:calibrate
 */
import { env } from "../config/env.js";
import { closeDb, openDb } from "../infra/db/client.js";
import {
	calcularDiagnosticoCadencia,
	type MetricasToque,
} from "../ops/calibration.js";

const formatarMinutos = (min: number | null): string => {
	if (min === null) return "N/D (sem respostas suficientes)";
	if (min < 60) return `${min} minutos`;
	const horas = Math.round((min / 60) * 10) / 10;
	return `${horas} horas (${min} min)`;
};

const main = async () => {
	const conn = await openDb(env.DATABASE_URL);
	try {
		console.log("==================================================");
		console.log("  CALIBRAÇÃO DE CADÊNCIA DO PILOTO (DADOS REAIS)  ");
		console.log("==================================================\n");

		const d = await calcularDiagnosticoCadencia(conn.db);

		console.log(`Total de conversas monitoradas: ${d.totalConversas}`);
		console.log(
			`Conversas que obtiveram resposta: ${d.conversasComResposta} (${d.taxaGeralRespostaPct}%)`,
		);
		console.log(
			`Tempo mediano até a 1ª resposta: ${formatarMinutos(d.tempoMedianoPrimeiraRespostaMin)}\n`,
		);

		console.log("Desempenho por Toque da Cadência:");
		console.log("--------------------------------------------------");
		console.log("Toque | Descrição        | Enviados | Respostas | Taxa");
		console.log("--------------------------------------------------");

		const nomes = [
			"1º Contato (Manual)",
			"Follow-up 1 (+1h)  ",
			"Follow-up 2 (+1d)  ",
			"Follow-up 3 (+3d)  ",
			"Follow-up 4 (+7d)  ",
		];

		d.toques.forEach((t: MetricasToque) => {
			const nome = nomes[t.toqueIndex] ?? `Toque ${t.toqueIndex}          `;
			console.log(
				`  ${t.toqueIndex}   | ${nome} | ${String(t.totalDisparados).padStart(8)} | ${String(t.totalRespostas).padStart(9)} | ${t.taxaRespostaPct}%`,
			);
		});

		console.log("--------------------------------------------------\n");
	} finally {
		await closeDb(conn);
	}
};

main().catch((err) => {
	console.error("Erro ao rodar calibração:", err);
	process.exit(1);
});
