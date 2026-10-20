/**
 * CLI de revisão em shadow (02-03 Task 1, D-01/D-03/D-06).
 *
 * A superfície de admin da Fase 2 é CLI-first (D-01): sem rota HTTP, sem painel
 * React. O Admin lista os rascunhos que a IA escreveu (`origin='ai_suggestion'`,
 * `status='suggested'`) e decide **aprovar / editar / descartar** cada um.
 *
 * ## A decisão é um EVENTO, nunca um `UPDATE`
 *
 * `messages` é imutável (R-043). Promover um rascunho NÃO é
 * `UPDATE messages SET status='sent'` (Pitfall 1): cada decisão é uma linha nova
 * em `review_events` (append-only), gravada por `recordReviewEvent` (D-03/D-06).
 * Aprovar NÃO envia nada — o canal real só recebe após a promoção explícita do
 * Admin (D-18); aqui a aprovação é só o fato auditável "o Admin aprovou este
 * texto".
 *
 * ## `runShadowCli` é a função sob teste
 *
 * Toda a lógica vive em `runShadowCli(db, argv, escrever)`, uma função pura que
 * recebe o `Db`, o `argv` e um destino de saída injetável. O bloco de entrypoint
 * no fim só abre o banco e delega — assim o teste exercita o MESMO caminho que o
 * `npm run shadow:*` roda, sem subprocesso.
 */
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { closeDb, type Db, openDb } from "../infra/db/client.js";
import {
	type ReviewDecision,
	recordReviewEvent,
} from "../infra/db/queries/review-events.js";

/** Destino de uma linha de saída. Injetável para o teste capturar o que a CLI mostra. */
export type Escrever = (linha: string) => void;

const paraConsole: Escrever = (linha) => {
	console.log(linha);
};

/** Teto de listagem: o Admin revisa dezenas, não a tabela inteira. */
export const LIMITE_LISTAGEM = 50;

/** UUID canônico — barra um id malformado antes de ele chegar ao banco (erro de uso, não de DB). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USO = [
	"uso: shadow:list",
	"     shadow:approve <id>",
	"     shadow:edit <id> --text <texto>",
	"     shadow:discard <id>",
].join("\n");

/** Um rascunho com o estado resolvido e o metadado da corrida que o gerou. */
export interface RascunhoLido {
	readonly id: string;
	readonly conversationId: string;
	readonly texto: string;
	readonly criadoEm: Date;
	/** `null` = pendente de revisão; senão a última decisão registrada. */
	readonly decisao: ReviewDecision | null;
	readonly ator: string | null;
	readonly decididoEm: Date | null;
	readonly modelo: string | null;
	readonly promptVersion: string | null;
	readonly policyVersion: string | null;
}

/**
 * Lista os rascunhos em shadow, mais recentes primeiro, com o estado resolvido
 * (a última linha de `review_events` daquela mensagem, se houver) e os metadados
 * de `llm_runs` (modelo e versões do prompt/política).
 */
export const listarRascunhos = async (
	db: Db,
	teto: number = LIMITE_LISTAGEM,
): Promise<RascunhoLido[]> => {
	const limite = Math.min(Math.max(Math.trunc(teto), 1), 500);
	const resultado = await db.execute(sql`
		select
			m.id::text              as id,
			m.conversation_id::text as conversation_id,
			m.body,
			m.created_at,
			ult.decision            as decisao,
			ult.actor               as ator,
			ult.created_at          as decidido_em,
			lr.model                as modelo,
			lr.prompt_version       as prompt_version,
			lr.policy_version       as policy_version
		from messages m
		left join lateral (
			select r.decision, r.actor, r.created_at
			from review_events r
			where r.message_id = m.id
			order by r.created_at desc, r.id desc
			limit 1
		) ult on true
		left join lateral (
			select l.model, l.prompt_version, l.policy_version
			from llm_runs l
			where l.message_id = m.id
			order by l.created_at desc, l.id desc
			limit 1
		) lr on true
		where m.origin = 'ai_suggestion'
		order by m.created_at desc
		limit ${limite}
	`);
	return (resultado as unknown as { rows: Record<string, unknown>[] }).rows.map(
		paraRascunhoLido,
	);
};

const paraRascunhoLido = (row: Record<string, unknown>): RascunhoLido => ({
	id: row.id as string,
	conversationId: row.conversation_id as string,
	texto: row.body as string,
	criadoEm: paraData(row.created_at),
	decisao: paraDecisao(row.decisao),
	ator: (row.ator as string | null) ?? null,
	decididoEm:
		row.decidido_em === null || row.decidido_em === undefined
			? null
			: paraData(row.decidido_em),
	modelo: (row.modelo as string | null) ?? null,
	promptVersion: (row.prompt_version as string | null) ?? null,
	policyVersion: (row.policy_version as string | null) ?? null,
});

/**
 * Normaliza o timestamp devolvido pelo driver (IN-01): conforme o type parser
 * ativo o pg devolve `Date` ou `string` — afirmar `as Date` seria mentira de
 * tipo no segundo caso. `new Date(...)` aceita ambos.
 */
const paraData = (bruto: unknown): Date =>
	bruto instanceof Date ? bruto : new Date(String(bruto));

/** `decision` é união fechada; `null` (sem decisão) é o estado pendente. */
const paraDecisao = (bruto: unknown): ReviewDecision | null => {
	if (bruto === null || bruto === undefined) return null;
	if (bruto === "approved" || bruto === "edited" || bruto === "discarded") {
		return bruto;
	}
	throw new Error(`review_events.decision invalido: ${String(bruto)}`);
};

const rotuloDecisao = (decisao: ReviewDecision | null): string => {
	if (decisao === "approved") return "aprovado";
	if (decisao === "edited") return "editado";
	if (decisao === "discarded") return "descartado";
	return "pendente";
};

const resumo = (r: RascunhoLido): string => {
	const corte = r.texto.length > 120 ? `${r.texto.slice(0, 120)}...` : r.texto;
	const meta =
		r.modelo === null
			? "(sem llm_runs)"
			: `${r.modelo} prompt=${r.promptVersion} policy=${r.policyVersion}`;
	return [
		`- ${r.id} [${rotuloDecisao(r.decisao)}] conv=${r.conversationId}`,
		`  llm: ${meta}`,
		`  texto: ${corte}`,
	].join("\n");
};

/** Lê o valor de uma flag (`--text`, `--reason`) de um par `flag valor`. */
const lerFlag = (argv: readonly string[], flag: string): string | null => {
	const i = argv.indexOf(flag);
	return i >= 0 ? (argv[i + 1] ?? null) : null;
};

const decidir = async (
	db: Db,
	id: string | undefined,
	decisao: ReviewDecision,
	textoEditado: string | null,
	escrever: Escrever,
): Promise<number> => {
	if (id === undefined || !UUID.test(id)) {
		escrever(`id invalido: ${id ?? "(ausente)"}\n${USO}`);
		return 2;
	}
	if (decisao === "edited" && (textoEditado === null || textoEditado === "")) {
		escrever(`shadow:edit exige --text <texto>\n${USO}`);
		return 2;
	}

	try {
		const alvo = await db.execute(sql`
			select id from messages
			where id = ${id}
				and origin = 'ai_suggestion'
				and status = 'suggested'
		`);
		const existe = (alvo as unknown as { rows: Array<{ id: string }> }).rows[0];
		if (!existe) {
			escrever(`rascunho inexistente ou nao revisavel: ${id}`);
			return 1;
		}
	} catch (err) {
		escrever(`erro ao validar rascunho: ${String(err)}`);
		return 1;
	}

	try {
		const eventoId = await recordReviewEvent(db, {
			messageId: id,
			decision: decisao,
			actor: "admin",
			editedText: textoEditado,
		});
		escrever(
			`Rascunho ${id} ${rotuloDecisao(decisao)} (review_events ${eventoId}). ` +
				"Nenhum envio nesta fase (D-18).",
		);
		return 0;
	} catch (err) {
		escrever(`erro ao registrar evento de revisão: ${String(err)}`);
		return 1;
	}
};

/**
 * Executa um subcomando de revisão. Devolve o código de saída (0 ok, 1 erro de
 * domínio, 2 erro de uso) — o teste assevera sobre ele em vez de um `process.exit`.
 */
export const runShadowCli = async (
	db: Db,
	argv: readonly string[],
	escrever: Escrever = paraConsole,
): Promise<number> => {
	const [subcomando, ...resto] = argv;
	switch (subcomando) {
		case "list": {
			const rascunhos = await listarRascunhos(db);
			if (rascunhos.length === 0) {
				escrever("Nenhum rascunho em shadow.");
				return 0;
			}
			escrever(`Rascunhos em shadow: ${rascunhos.length}`);
			for (const r of rascunhos) escrever(resumo(r));
			return 0;
		}
		case "approve":
			return decidir(db, resto[0], "approved", null, escrever);
		case "discard":
			return decidir(db, resto[0], "discarded", null, escrever);
		case "edit":
			return decidir(
				db,
				resto[0],
				"edited",
				lerFlag(resto, "--text"),
				escrever,
			);
		default:
			escrever(USO);
			return 2;
	}
};

const executadoDiretamente = (): boolean => {
	const alvo = process.argv[1];
	return alvo !== undefined && import.meta.url === pathToFileURL(alvo).href;
};

if (executadoDiretamente()) {
	const conexao = await openDb(env.DATABASE_URL);
	try {
		process.exitCode = await runShadowCli(conexao.db, process.argv.slice(2));
	} finally {
		await closeDb(conexao);
	}
}
