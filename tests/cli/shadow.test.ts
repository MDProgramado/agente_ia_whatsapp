/**
 * CLI de revisão em shadow (02-03 Task 1) — decisões append-only.
 *
 * O que este teste prova, e por que ele existe:
 *
 * 1. `listarRascunhos` devolve os rascunhos (`origin='ai_suggestion'`) com o
 *    estado resolvido e os metadados de `llm_runs`.
 * 2. `approve`/`edit`/`discard` gravam UMA linha em `review_events` cada, com a
 *    `decision` e o `actor='admin'` certos — e NÃO tocam `messages` (Pitfall 1:
 *    a contagem de linhas de `messages` fica estável).
 * 3. `edit` sem `--text` é erro de uso (código 2) e não grava nada.
 * 4. Um id malformado é erro de uso, não uma exceção do banco.
 *
 * Transação revertida (mesmo padrão de `application/shadow.test.ts`): `messages`
 * é append-only e `leads` não pode ser apagado; a limpeza é `ROLLBACK` por
 * sentinela. As CLIs chamam `db.transaction` internamente — que, dentro da tx do
 * teste, vira SAVEPOINT, e o `ROLLBACK` externo desfaz tudo.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listarRascunhos, runShadowCli } from "../../src/cli/shadow.js";
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

interface Fx {
	readonly leadId: string;
	readonly conversationId: string;
	readonly messageId: string;
}

const semearRascunho = async (
	tx: Db,
	corpo: string,
	comLlmRun = true,
): Promise<Fx> => {
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
				values (${lead.id}, ${conta.id}, 'novo', 'shadow')
				returning id
			`),
		),
	);

	const mensagem = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into messages (
					conversation_id, direction, origin, kind, body, status, idempotency_key
				)
				values (
					${conversa.id}, 'out', 'ai_suggestion', 'text', ${corpo},
					'suggested', ${`shadow-test-${randomUUID()}`}
				)
				returning id
			`),
		),
	);

	if (comLlmRun) {
		await tx.execute(sql`
			insert into llm_runs (
				message_id, model, prompt_version, policy_version, zod_parse_ok, canary_ok
			)
			values (${mensagem.id}, 'modelo-teste', 'p1', 'v1', true, true)
		`);
	}

	return {
		leadId: lead.id,
		conversationId: conversa.id,
		messageId: mensagem.id,
	};
};

const contarMessages = async (tx: Db, conversaId: string): Promise<number> => {
	const r = await tx.execute(sql`
		select count(*)::int as n from messages where conversation_id = ${conversaId}
	`);
	return primeiro(rows<{ n: number }>(r)).n;
};

const lerReviewEvents = async (
	tx: Db,
	messageId: string,
): Promise<{ decision: string; actor: string; editedText: string | null }[]> =>
	rows<{ decision: string; actor: string; editedText: string | null }>(
		await tx.execute(sql`
			select decision, actor, edited_text as "editedText"
			from review_events where message_id = ${messageId}
			order by created_at desc
		`),
	);

describe("shadow — listarRascunhos (02-03 Task 1)", () => {
	it("lista o rascunho com texto, estado pendente e metadados de llm_runs", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semearRascunho(tx, "Boa tarde! Podemos conversar?");

			const rascunhos = await listarRascunhos(tx);
			const meu = rascunhos.find((r) => r.id === fx.messageId);
			expect(meu).toBeDefined();
			expect(meu?.decisao).toBeNull();
			expect(meu?.texto).toBe("Boa tarde! Podemos conversar?");
			expect(meu?.modelo).toBe("modelo-teste");
			expect(meu?.promptVersion).toBe("p1");
			expect(meu?.policyVersion).toBe("v1");

			const { escrever, linhas } = capturar();
			const codigo = await runShadowCli(tx, ["list"], escrever);
			expect(codigo).toBe(0);
			expect(linhas.join("\n")).toContain(fx.messageId);
		});
	});
});

describe("shadow — decisões append-only (02-03 Task 1)", () => {
	it("approve grava 1 review_events e NÃO altera messages", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semearRascunho(tx, "texto qualquer");
			const antes = await contarMessages(tx, fx.conversationId);

			const { escrever } = capturar();
			const codigo = await runShadowCli(
				tx,
				["approve", fx.messageId],
				escrever,
			);
			expect(codigo).toBe(0);

			const eventos = await lerReviewEvents(tx, fx.messageId);
			expect(eventos).toHaveLength(1);
			expect(primeiro(eventos).decision).toBe("approved");
			expect(primeiro(eventos).actor).toBe("admin");
			expect(primeiro(eventos).editedText).toBeNull();
			expect(await contarMessages(tx, fx.conversationId)).toBe(antes);
		});
	});

	it("edit grava a decisão 'edited' com o texto revisado", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semearRascunho(tx, "texto original");

			const { escrever } = capturar();
			const codigo = await runShadowCli(
				tx,
				["edit", fx.messageId, "--text", "texto revisado pelo admin"],
				escrever,
			);
			expect(codigo).toBe(0);

			const eventos = await lerReviewEvents(tx, fx.messageId);
			expect(eventos).toHaveLength(1);
			expect(primeiro(eventos).decision).toBe("edited");
			expect(primeiro(eventos).editedText).toBe("texto revisado pelo admin");
		});
	});

	it("discard grava 1 review_events 'discarded'", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semearRascunho(tx, "texto");

			const { escrever } = capturar();
			const codigo = await runShadowCli(
				tx,
				["discard", fx.messageId],
				escrever,
			);
			expect(codigo).toBe(0);

			const eventos = await lerReviewEvents(tx, fx.messageId);
			expect(eventos).toHaveLength(1);
			expect(primeiro(eventos).decision).toBe("discarded");
		});
	});

	it("edit sem --text é erro de uso (2) e não grava review_events", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semearRascunho(tx, "texto");

			const { escrever } = capturar();
			const codigo = await runShadowCli(tx, ["edit", fx.messageId], escrever);
			expect(codigo).toBe(2);
			expect(await lerReviewEvents(tx, fx.messageId)).toHaveLength(0);
		});
	});

	it("id malformado é erro de uso (2), sem tocar o banco", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { escrever } = capturar();
			const codigo = await runShadowCli(
				tx,
				["approve", "nao-e-uuid"],
				escrever,
			);
			expect(codigo).toBe(2);
		});
	});

	it("subcomando desconhecido devolve uso (2)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { escrever, linhas } = capturar();
			const codigo = await runShadowCli(tx, ["foo"], escrever);
			expect(codigo).toBe(2);
			expect(linhas.join("\n")).toContain("uso:");
		});
	});
});
