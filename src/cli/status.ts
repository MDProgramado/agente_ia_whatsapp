/**
 * Correção de status pelo Admin (02-03 Task 1, CRM-02).
 *
 * `status:corrigir <conv> --to <state> --reason <texto>` é o comando pelo qual o
 * Admin conserta o estágio do funil à mão — a exceção legítima ao "o modelo
 * sugere, a FSM decide" (D-07). A correção é auditada com `changed_by='admin'` em
 * `status_history` (R-022): "por que a conversa está neste estágio e quem a pôs
 * ali" continua tendo resposta mesmo quando a resposta é "o humano corrigiu".
 *
 * ## A transição é validada pelo CONTRATO da FSM
 *
 * `ALLOWED` (transitions.ts) é a tabela de transições permitidas. O comando NÃO
 * inventa um caminho: se `to` não consta em `ALLOWED[from]`, ele recusa e mostra
 * as transições válidas. Isso mantém uma única fonte de verdade sobre o que é um
 * estado alcançável, em vez de um segundo `UPDATE ... SET state = ?` solto.
 */
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { ALLOWED, type Estado } from "../domain/orchestrator/transitions.js";
import { closeDb, type Db, openDb } from "../infra/db/client.js";
import { recordStatusChange } from "../infra/db/queries/status-history.js";

/** Destino de uma linha de saída. Injetável para o teste capturar o que a CLI mostra. */
export type Escrever = (linha: string) => void;

const paraConsole: Escrever = (linha) => {
	console.log(linha);
};

/** Os 9 estados de `conversations_state_check`, derivados da FSM — não redigitados. */
export const ESTADOS = Object.keys(ALLOWED) as readonly Estado[];

const ehEstado = (valor: string): valor is Estado =>
	(ESTADOS as readonly string[]).includes(valor);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USO =
	"uso: status:corrigir <conversa-uuid> --to <estado> [--reason <texto>]";

const lerFlag = (argv: readonly string[], flag: string): string | null => {
	const i = argv.indexOf(flag);
	return i >= 0 ? (argv[i + 1] ?? null) : null;
};

/** Lê o estado atual da conversa; `null` quando não existe. */
const lerEstado = async (
	db: Db,
	conversaId: string,
): Promise<Estado | null> => {
	const resultado = await db.execute(sql`
		select state from conversations where id = ${conversaId}
	`);
	const s = (resultado as unknown as { rows: { state: string }[] }).rows[0]
		?.state;
	// O CHECK do banco garante que `s` é um dos 9; o cast é seguro e o teste
	// `ehEstado` no chamador não é necessário.
	return s === undefined ? null : (s as Estado);
};

/**
 * Executa `status:corrigir`. Devolve o código de saída (0 ok, 1 erro de domínio,
 * 2 erro de uso).
 */
export const runStatusCli = async (
	db: Db,
	argv: readonly string[],
	escrever: Escrever = paraConsole,
): Promise<number> => {
	const [, conversaId, ...flags] = argv;
	if (
		argv[0] !== "corrigir" ||
		conversaId === undefined ||
		!UUID.test(conversaId)
	) {
		escrever(USO);
		return 2;
	}

	const para = lerFlag(flags, "--to");
	const motivo = lerFlag(flags, "--reason");
	if (para === null) {
		escrever(`faltou --to <estado>\n${USO}`);
		return 2;
	}
	if (!ehEstado(para)) {
		escrever(`estado invalido: ${para}. Validos: ${ESTADOS.join(", ")}.`);
		return 1;
	}

	const atual = await lerEstado(db, conversaId);
	if (atual === null) {
		escrever(`conversa ${conversaId} nao encontrada.`);
		return 1;
	}
	if (atual === para) {
		escrever(`conversa ${conversaId} ja esta em ${para}. Nada a corrigir.`);
		return 0;
	}

	// `ALLOWED[atual]` é uma união de tuplas (inclusive `readonly []` para
	// `encerrado`), o que colapsa `includes` para `never`. Alargar para
	// `readonly Estado[]` é o tipo correto: a lista de transições válidas.
	const permitidas: readonly Estado[] = ALLOWED[atual];
	if (!permitidas.includes(para)) {
		const lista =
			permitidas.length > 0
				? permitidas.join(", ")
				: "(nenhuma — estado terminal)";
		escrever(
			`transicao ${atual} -> ${para} nao permitida pelo FSM. Permitidas: ${lista}.`,
		);
		return 1;
	}

	await db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;
		await recordStatusChange(tx, {
			conversationId: conversaId,
			fromState: atual,
			toState: para,
			changedBy: "admin",
			reason: motivo,
		});
		await tx.execute(sql`
			update conversations set state = ${para} where id = ${conversaId}
		`);
	});

	escrever(
		`Status da conversa ${conversaId}: ${atual} -> ${para} (changed_by=admin, auditado em status_history).`,
	);
	return 0;
};

const executadoDiretamente = (): boolean => {
	const alvo = process.argv[1];
	return alvo !== undefined && import.meta.url === pathToFileURL(alvo).href;
};

if (executadoDiretamente()) {
	const conexao = await openDb(env.DATABASE_URL);
	try {
		process.exitCode = await runStatusCli(conexao.db, process.argv.slice(2));
	} finally {
		await closeDb(conexao);
	}
}
