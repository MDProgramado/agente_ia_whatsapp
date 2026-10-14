/**
 * Kill switch global (02-03 Task 1, D-02) — 1 comando, reversível, auditado.
 *
 * O que este teste prova, e por que ele existe:
 *
 * 1. `mode pause` grava `settings.operational_mode='paused'`.
 * 2. Cada mudança deixa UM evento append-only em `event_log`
 *    (`event_type='operational_mode_changed'`) com `actor='admin'`, `from`, `to`.
 * 3. O efeito é REAL ponta-a-ponta: com o snapshot computando `killSwitch`, o
 *    gate passa de `send` para `block` com `reason='kill_switch_ativo'`.
 * 4. `mode resume` reverte para `active` e o gate volta a liberar.
 *
 * Sobre a tabela de auditoria: o plano do 02-03 dizia `mode_changes`, mas essa
 * tabela tem `conversation_id NOT NULL` (FK para `conversations`) e não comporta
 * um interruptor GLOBAL. A decisão registrada (ver `02-03-SUMMARY.md`) foi
 * auditar o modo global em `event_log` — a trilha append-only de fatos do
 * sistema. `mode_changes` segue sendo o log POR CONVERSA (do handoff).
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	CHAVE_MODO_OPERACIONAL,
	lerModoOperacional,
	runModeCli,
} from "../../src/cli/mode.js";
import { env } from "../../src/config/env.js";
import { evaluatePolicy } from "../../src/domain/gate/index.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import { loadGateSnapshot } from "../../src/infra/db/queries/snapshot.js";
import { DIA_UTIL_DENTRO_DA_JANELA, TZ } from "../gate/fixtures.js";

const AGORA = new Date(DIA_UTIL_DENTRO_DA_JANELA);

const CTX = {
	tz: TZ,
	windowStartHour: 7,
	windowEndHour: 17,
	dailyMessageLimit: 25,
	dailyMessageCap: 30,
	sentToday: 0,
	newContactsToday: 0,
} as const;

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

const semearConversa = async (tx: Db): Promise<string> => {
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
				values (${lead.id}, ${conta.id}, 'novo', 'bot_active')
				returning id
			`),
		),
	);
	return conversa.id;
};

const valorModo = async (tx: Db): Promise<string | null> => {
	const r = await tx.execute(sql`
		select value #>> '{}' as v from settings where key = ${CHAVE_MODO_OPERACIONAL}
	`);
	return rows<{ v: string | null }>(r)[0]?.v ?? null;
};

/**
 * Lê o evento de modo cujo `to` é o pedido. Filtrar por `to` (e não pegar o
 * "último") porque `now()` é constante DENTRO da transação do teste: dois
 * eventos gravados na mesma tx compartilham `created_at`, e ordenar por `id`
 * (uuid aleatório) seria arbitrário.
 */
const eventoModo = async (
	tx: Db,
	to: string,
): Promise<{ event_type: string; payload: Record<string, unknown> } | null> => {
	const r = await tx.execute(sql`
		select event_type, payload from event_log
		where event_type = 'operational_mode_changed' and payload->>'to' = ${to}
		order by created_at desc, id desc
		limit 1
	`);
	return (
		rows<{ event_type: string; payload: Record<string, unknown> }>(r)[0] ?? null
	);
};

describe("mode — kill switch global (02-03 Task 1, D-02)", () => {
	it("pause grava 'paused', audita em event_log com actor=admin", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { escrever } = capturar();
			const codigo = await runModeCli(
				tx,
				["pause", "--reason", "teste automatizado"],
				escrever,
			);
			expect(codigo).toBe(0);
			expect(await valorModo(tx)).toBe("paused");
			expect(await lerModoOperacional(tx)).toBe("paused");

			const evento = await eventoModo(tx, "paused");
			expect(evento).not.toBeNull();
			expect(evento?.payload.actor).toBe("admin");
			expect(evento?.payload.from).toBe("active");
			expect(evento?.payload.to).toBe("paused");
			expect(evento?.payload.reason).toBe("teste automatizado");
		});
	});

	it("ponta-a-ponta: pausado → o gate devolve kill_switch_ativo", async () => {
		await emTransacaoRevertida(async (tx) => {
			const conversaId = await semearConversa(tx);

			// Antes: modo default (sem linha) → kill switch desligado → gate libera.
			const antes = await loadGateSnapshot(tx, conversaId, AGORA, CTX);
			if (antes === null) throw new Error("snapshot nulo antes do pause");
			expect(evaluatePolicy(antes).action).toBe("send");

			const { escrever } = capturar();
			await runModeCli(tx, ["pause"], escrever);

			// Depois: o snapshot computa killSwitch=true → gate bloqueia.
			const depois = await loadGateSnapshot(tx, conversaId, AGORA, CTX);
			if (depois === null) throw new Error("snapshot nulo depois do pause");
			expect(depois.context.killSwitch).toBe(true);
			const decisao = evaluatePolicy(depois);
			expect(decisao.action).toBe("block");
			if (decisao.action !== "block") throw new Error("esperava block");
			expect(decisao.reason).toBe("kill_switch_ativo");
		});
	});

	it("resume reverte para 'active' e o gate volta a liberar", async () => {
		await emTransacaoRevertida(async (tx) => {
			const conversaId = await semearConversa(tx);
			const { escrever } = capturar();

			await runModeCli(tx, ["pause", "--reason", "pausa"], escrever);
			expect(await valorModo(tx)).toBe("paused");

			const codigo = await runModeCli(
				tx,
				["resume", "--reason", "retomada"],
				escrever,
			);
			expect(codigo).toBe(0);
			expect(await valorModo(tx)).toBe("active");

			const evento = await eventoModo(tx, "active");
			expect(evento?.payload.from).toBe("paused");
			expect(evento?.payload.to).toBe("active");

			const snap = await loadGateSnapshot(tx, conversaId, AGORA, CTX);
			if (snap === null) throw new Error("snapshot nulo");
			expect(snap.context.killSwitch).toBe(false);
			expect(evaluatePolicy(snap).action).toBe("send");
		});
	});

	it("consulta sem argumento não muda o modo", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { escrever, linhas } = capturar();
			const codigo = await runModeCli(tx, [], escrever);
			expect(codigo).toBe(0);
			expect(linhas.join("\n")).toContain("active");
			expect(await valorModo(tx)).toBeNull();
		});
	});
});
