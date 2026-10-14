/**
 * Correção de status pelo Admin (02-03 Task 1, CRM-02).
 *
 * O que este teste prova, e por que ele existe:
 *
 * 1. Uma transição válida grava `status_history` com `changed_by='admin'` e
 *    atualiza `conversations.state`.
 * 2. Uma transição fora de `ALLOWED` é RECUSADA (código 1) e não muda nada — o
 *    comando não inventa caminhos que a FSM não reconhece.
 * 3. Um estado inexistente é erro de domínio (1); um uuid malformado é erro de
 *    uso (2).
 * 4. Repetir o estado atual é no-op auditable-free (código 0, sem linha nova).
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runStatusCli } from "../../src/cli/status.js";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";

const SENTINELA = "rollback-intencional-do-teste";

let conn: OpenDb;
let db: Db;

beforeAll(async () => {
	conn = await openDb(env.DATABASE_URL);
	db = conn.db;
});

afterAll(async () => {
	await closeDb(conn);
});

const rows = <T>(resultado: unknown): T[] => (resultado as { rows: T[] }).rows;

const primeiro = <T>(lista: readonly T[]): T => {
	const item = lista[0];
	if (item === undefined) throw new Error("esperava ao menos uma linha");
	return item;
};

const emTransacaoRevertida = async (
	fn: (tx: Db) => Promise<void>,
): Promise<void> => {
	try {
		await db.transaction(async (tx) => {
			await fn(tx as unknown as Db);
			throw new Error(SENTINELA);
		});
	} catch (erro) {
		if (!(erro instanceof Error) || erro.message !== SENTINELA) throw erro;
	}
};

const capturar = (): {
	escrever: (linha: string) => void;
	linhas: string[];
} => {
	const linhas: string[] = [];
	return { escrever: (linha: string) => linhas.push(linha), linhas };
};

let seq = 0;
const telefone = (): string => {
	seq += 1;
	return `+55119${String(Date.now() % 100000).padStart(5, "0")}${String(seq).padStart(3, "0")}`;
};

const semearConversa = async (tx: Db, estado: string): Promise<string> => {
	await tx.execute(sql`
		insert into channel_accounts (phone_e164)
		values (${env.CHANNEL_PHONE_E164})
		on conflict (phone_e164) do nothing
	`);
	const conta = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				select id from channel_accounts where phone_e164 = ${env.CHANNEL_PHONE_E164}
			`),
		),
	);
	const lead = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into leads (
					phone_number, origin_source, legal_basis, purpose,
					legal_registered_at, first_contact_by_human, opt_out
				)
				values (
					${telefone()}, 'teste', 'legitimate_interest', 'prospeccao',
					'2025-01-01T12:00:00Z', true, false
				)
				returning id
			`),
		),
	);
	const conversa = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into conversations (lead_id, channel_account_id, state, engagement_mode)
				values (${lead.id}, ${conta.id}, ${estado}, 'bot_active')
				returning id
			`),
		),
	);
	return conversa.id;
};

const estadoDe = async (tx: Db, conversaId: string): Promise<string> => {
	const r = await tx.execute(sql`
		select state from conversations where id = ${conversaId}
	`);
	return primeiro(rows<{ state: string }>(r)).state;
};

const lerStatusHistory = async (
	tx: Db,
	conversaId: string,
): Promise<
	{
		from_state: string;
		to_state: string;
		changed_by: string;
		reason: string | null;
	}[]
> =>
	rows<{
		from_state: string;
		to_state: string;
		changed_by: string;
		reason: string | null;
	}>(
		await tx.execute(sql`
			select from_state, to_state, changed_by, reason
			from status_history where conversation_id = ${conversaId}
			order by changed_at desc
		`),
	);

describe("status:corrigir — correção do Admin (02-03 Task 1, CRM-02)", () => {
	it("transição válida grava status_history com changed_by=admin e move o estado", async () => {
		await emTransacaoRevertida(async (tx) => {
			const conversaId = await semearConversa(tx, "novo");

			const { escrever } = capturar();
			const codigo = await runStatusCli(
				tx,
				[
					"corrigir",
					conversaId,
					"--to",
					"qualificando",
					"--reason",
					"ajuste manual",
				],
				escrever,
			);
			expect(codigo).toBe(0);
			expect(await estadoDe(tx, conversaId)).toBe("qualificando");

			const historico = await lerStatusHistory(tx, conversaId);
			expect(historico).toHaveLength(1);
			expect(primeiro(historico).from_state).toBe("novo");
			expect(primeiro(historico).to_state).toBe("qualificando");
			expect(primeiro(historico).changed_by).toBe("admin");
			expect(primeiro(historico).reason).toBe("ajuste manual");
		});
	});

	it("transição proibida pelo FSM é recusada (1) e não muda nada", async () => {
		await emTransacaoRevertida(async (tx) => {
			const conversaId = await semearConversa(tx, "encerrado");

			const { escrever, linhas } = capturar();
			const codigo = await runStatusCli(
				tx,
				["corrigir", conversaId, "--to", "qualificando"],
				escrever,
			);
			expect(codigo).toBe(1);
			expect(linhas.join("\n")).toContain("nao permitida");
			expect(await estadoDe(tx, conversaId)).toBe("encerrado");
			expect(await lerStatusHistory(tx, conversaId)).toHaveLength(0);
		});
	});

	it("estado inexistente é erro de domínio (1)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const conversaId = await semearConversa(tx, "novo");

			const { escrever } = capturar();
			const codigo = await runStatusCli(
				tx,
				["corrigir", conversaId, "--to", "inexistente"],
				escrever,
			);
			expect(codigo).toBe(1);
			expect(await estadoDe(tx, conversaId)).toBe("novo");
		});
	});

	it("uuid malformado é erro de uso (2)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { escrever } = capturar();
			const codigo = await runStatusCli(
				tx,
				["corrigir", "nao-e-uuid", "--to", "novo"],
				escrever,
			);
			expect(codigo).toBe(2);
		});
	});

	it("repetir o estado atual é no-op sem linha nova (0)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const conversaId = await semearConversa(tx, "novo");

			const { escrever } = capturar();
			const codigo = await runStatusCli(
				tx,
				["corrigir", conversaId, "--to", "novo"],
				escrever,
			);
			expect(codigo).toBe(0);
			expect(await lerStatusHistory(tx, conversaId)).toHaveLength(0);
		});
	});
});
