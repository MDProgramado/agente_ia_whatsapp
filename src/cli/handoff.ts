/**
 * Confirmação humana de handoff (02-03 Task 1, D-15).
 *
 * `handoff:ack <handoffId>` é a **ação explícita do Admin** que a D-15 exige: o
 * bot só volta a falar por ação explícita, NUNCA por timeout. O ack grava
 * `handoff_events.human_acknowledged_at = now()` — o que faz a linha sair do
 * índice parcial `handoff_events_open_idx` ("pendentes que o Admin ainda não
 * viu") — e, na MESMA transação, um evento append-only em `event_log`.
 *
 * ## Idempotência
 *
 * A linha é lida `FOR UPDATE`; se `human_acknowledged_at` já está preenchido,
 * NADA é gravado de novo: um segundo `handoff:ack` não reescreve o instante nem
 * duplica o par de auditoria. Repetir o comando é inofensivo.
 *
 * ## O ack NÃO reativa o bot
 *
 * Confirmar o handoff não devolve a conversa para `bot_active`: a retomada da
 * automação é um comando explícito à parte. Aqui só se registra "o humano viu o
 * handoff". `handoff_events` não é append-only (não tem trigger); o `UPDATE` em
 * `human_acknowledged_at` é a operação desenhada, e a trilha append-only fica em
 * `event_log`.
 */
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { closeDb, type Db, openDb } from "../infra/db/client.js";

/** Destino de uma linha de saída. Injetável para o teste capturar o que a CLI mostra. */
export type Escrever = (linha: string) => void;

const paraConsole: Escrever = (linha) => {
	console.log(linha);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USO = "uso: handoff:ack <handoff-id>";

/**
 * Resultado discriminado do ack — o comando mapeia cada caso para uma mensagem.
 *
 * `quando` é a representação TEXTUAL do `timestamptz` como o PostgreSQL a
 * devolve. O driver do Drizzle (node-postgres) instala um `getTypeParser` que
 * devolve TIMESTAMPTZ como string crua (`(val) => val`), não como `Date` — por
 * isso o tipo é `string` e o valor vai fiel ao banco para o payload e para a
 * mensagem, sem uma conversão de fuso que possa deslocá-lo.
 */
export type AckResultado =
	| { readonly estado: "nao_encontrado" }
	| { readonly estado: "ja_confirmado"; readonly quando: string }
	| { readonly estado: "confirmado"; readonly quando: string };

interface LinhaHandoff {
	readonly id: string;
	readonly conversation_id: string;
	readonly lead_id: string;
	readonly human_acknowledged_at: string | null;
}

/**
 * Confirma o handoff. Transação única: o `UPDATE` e o evento de auditoria sobem
 * juntos ou não sobem — um ack sem trilha é exatamente o "quem assumiu e quando"
 * que a auditoria precisa conseguir responder.
 */
export const ackHandoff = async (
	db: Db,
	handoffId: string,
): Promise<AckResultado> =>
	db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;

		const lido = await tx.execute(sql`
			select id, conversation_id, lead_id, human_acknowledged_at
			from handoff_events
			where id = ${handoffId}
			for update
		`);
		const linha = (lido as unknown as { rows: LinhaHandoff[] }).rows[0];
		if (!linha) return { estado: "nao_encontrado" as const };

		if (linha.human_acknowledged_at !== null) {
			return {
				estado: "ja_confirmado" as const,
				quando: linha.human_acknowledged_at,
			};
		}

		// `and human_acknowledged_at is null` de novo: se outra transação confirmou
		// entre o SELECT e o UPDATE, o `FOR UPDATE` já serializou — esta condição é
		// a segunda rede, e o `returning` vazio dela seria erro de programa.
		const atualizado = await tx.execute(sql`
			update handoff_events
			set human_acknowledged_at = now()
			where id = ${handoffId} and human_acknowledged_at is null
			returning human_acknowledged_at
		`);
		const quando = (
			atualizado as unknown as { rows: { human_acknowledged_at: string }[] }
		).rows[0]?.human_acknowledged_at;
		if (!quando) {
			throw new Error(
				"ackHandoff: o UPDATE nao devolveu human_acknowledged_at",
			);
		}

		await tx.execute(sql`
			insert into event_log (
				event_type, entity_type, entity_id, conversation_id, lead_id,
				payload, severity
			)
			values (
				'handoff_acknowledged',
				'handoff_event',
				${handoffId},
				${linha.conversation_id},
				${linha.lead_id},
				${JSON.stringify({ handoffId, acknowledgedAt: quando })}::jsonb,
				'info'
			)
		`);

		return { estado: "confirmado" as const, quando };
	});

/**
 * Executa `handoff:ack`. Devolve o código de saída (0 ok/idempotente, 1 não
 * encontrado, 2 erro de uso).
 */
export const runHandoffCli = async (
	db: Db,
	argv: readonly string[],
	escrever: Escrever = paraConsole,
): Promise<number> => {
	const handoffId = argv[1];
	if (argv[0] !== "ack" || handoffId === undefined || !UUID.test(handoffId)) {
		escrever(USO);
		return 2;
	}

	const resultado = await ackHandoff(db, handoffId);
	if (resultado.estado === "nao_encontrado") {
		escrever(`handoff ${handoffId} nao encontrado.`);
		return 1;
	}
	if (resultado.estado === "ja_confirmado") {
		escrever(
			`handoff ${handoffId} ja confirmado em ${resultado.quando} (idempotente — nada reescrito).`,
		);
		return 0;
	}
	escrever(
		`handoff ${handoffId} confirmado (human_acknowledged_at=${resultado.quando}). ` +
			"A retomada do bot exige acao explicita separada (D-15).",
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
		process.exitCode = await runHandoffCli(conexao.db, process.argv.slice(2));
	} finally {
		await closeDb(conexao);
	}
}
