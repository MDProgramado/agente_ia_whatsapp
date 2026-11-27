import { Cron } from "croner";
import { sql } from "drizzle-orm";
import type { Db } from "../infra/db/client.js";
import { childLogger } from "../infra/logger.js";

const CRON_PADRAO = "37 3 * * *";

export interface RetencaoResultado {
	readonly corte: string;
	readonly mensagens_eliminadas: number;
	readonly eventos_eliminados: number;
	readonly llm_runs_eliminados: number;
	readonly review_events_eliminados: number;
	readonly outbox_eliminado: number;
	readonly blocked_attempts_reduzidos: number;
}

export interface RetencaoDeps {
	readonly db: Db;
	readonly timezone: string;
	readonly agora?: () => Date;
	readonly cronPattern?: string;
}

export interface RetencaoJob {
	executar(): Promise<RetencaoResultado>;
	stop(): void;
}

const log = childLogger("retencao");

export const aplicarRetencao = async (
	db: Db,
	agora: Date,
): Promise<RetencaoResultado> => {
	const resultado = await db.execute(sql`
		select fn_aplicar_retencao(${agora}) as resultado
	`);
	const bruto = resultado.rows[0]?.resultado;
	if (typeof bruto !== "object" || bruto === null) {
		throw new Error("fn_aplicar_retencao nao devolveu resultado");
	}
	const parsed =
		typeof bruto === "string"
			? (JSON.parse(bruto) as RetencaoResultado)
			: bruto;
	return parsed as RetencaoResultado;
};

export const startRetencaoJob = (deps: RetencaoDeps): RetencaoJob => {
	const agora = deps.agora ?? (() => new Date());

	const executar = async (): Promise<RetencaoResultado> => {
		const resultado = await aplicarRetencao(deps.db, agora());
		log.info(
			{
				event: "retencao_aplicada",
				corte: resultado.corte,
				mensagens_eliminadas: resultado.mensagens_eliminadas,
				eventos_eliminados: resultado.eventos_eliminados,
				llm_runs_eliminados: resultado.llm_runs_eliminados,
				review_events_eliminados: resultado.review_events_eliminados,
				outbox_eliminado: resultado.outbox_eliminado,
				blocked_attempts_reduzidos: resultado.blocked_attempts_reduzidos,
			},
			"retencao de 180 dias aplicada",
		);
		return resultado;
	};

	const job = new Cron(
		deps.cronPattern ?? CRON_PADRAO,
		{ timezone: deps.timezone, maxRuns: Infinity },
		() => {
			void executar().catch((erro: unknown) => {
				log.error(
					{ event: "retencao_falhou" },
					`retencao falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
				);
			});
		},
	);

	return { executar, stop: () => job.stop() };
};
