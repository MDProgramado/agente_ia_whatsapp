import { pathToFileURL } from "node:url";
import { apagarTitular } from "../application/erasure.js";
import { env } from "../config/env.js";
import { closeDb, type Db, openDb } from "../infra/db/client.js";

type Escrever = (linha: string) => void;

const paraConsole: Escrever = (linha) => {
	console.log(linha);
};

const USO =
	"uso: lgpd:apagar <lead-id> [descricao do pedido recebido no canal do titular]";

export const runErasureCli = async (
	db: Db,
	argv: readonly string[],
	escrever: Escrever = paraConsole,
): Promise<number> => {
	const leadId = argv[0];
	if (leadId === undefined || leadId.length === 0) {
		escrever(USO);
		return 2;
	}
	const rawContent =
		argv.slice(1).join(" ").trim() ||
		"pedido de eliminação recebido no canal do titular";

	try {
		const resultado = await apagarTitular(db, { leadId, rawContent });
		escrever(
			`titular ${resultado.leadId} eliminado: opt_out=true, ` +
				`${resultado.camposAnonimizados.length} campos anulados, ` +
				`${resultado.conversasEncerradas} conversa(s) encerrada(s), ` +
				"evento erasure_request gravado.",
		);
		return 0;
	} catch (erro: unknown) {
		escrever(
			`falha ao eliminar titular: ${erro instanceof Error ? erro.message : String(erro)}`,
		);
		return 1;
	}
};

const executadoDiretamente = (): boolean => {
	const alvo = process.argv[1];
	return alvo !== undefined && import.meta.url === pathToFileURL(alvo).href;
};

if (executadoDiretamente()) {
	const conexao = await openDb(env.DATABASE_URL);
	try {
		process.exitCode = await runErasureCli(conexao.db, process.argv.slice(2));
	} finally {
		await closeDb(conexao);
	}
}
