/**
 * Relatório diário (R-061, R-062, T-01-30) — FÓRMULA sobre `status_history`.
 *
 * A base de cálculo é o HISTÓRICO, não o estado atual: "quantas reuniões
 * agendadas este mês" é uma pergunta sobre transições registradas, não sobre o
 * pipeline de agora. A fórmula, escrita no nome de cada campo:
 *
 * - `reunioes_agendadas` = transições em `status_history` para
 *   `to_state IN ('qualificando','aquecido')` no dia, com `changed_by = 'bot'`;
 * - `leads_qualificados` = **distinct** `conversation_id` que chegaram a
 *   `qualificando` ou `aquecido` no dia (qualquer ator — a qualificação é do
 *   lead, não do bot);
 * - `leads_novos` = `daily_counters.kind = 'new_contacts'` do mesmo dia;
 * - `taxa_qualificacao` = `leads_qualificados / leads_novos * 100`, e o
 *   DENOMINADOR é explícito: sem `leads_novos` a taxa é `null`, nunca `0` —
 *   "0% de qualificação" e "sem dados" são afirmações diferentes (T-01-30).
 */
import { randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import { dailyReport } from "../../src/infra/db/queries/daily-report.js";
import { instanteEmZona, TZ } from "../gate/fixtures.js";

/** Terça, 29/09/2026 — dia fixo e passado, sem contadores reais no dev. */
const DIA = "2026-09-29";
const NO_DIA = (hora: number, minuto = 0): Date =>
	instanteEmZona(TZ, 2026, 9, 29, hora, minuto);
const OUTRO_DIA = "2026-09-28";

const SENTINELA = "rollback-intencional-do-teste";

const rows = <T>(resultado: unknown): T[] => (resultado as { rows: T[] }).rows;

const primeiro = <T>(lista: readonly T[]): T => {
	const [item] = lista;
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

const telefoneAleatorio = (): string =>
	`+55${randomInt(10_000_000_000, 99_999_999_999)}`;

const inserirConta = async (db: Db): Promise<string> => {
	await db.execute(sql`
		INSERT INTO channel_accounts (phone_e164, display_name)
		VALUES (${env.CHANNEL_PHONE_E164}, 'teste-daily-report')
		ON CONFLICT (phone_e164) DO NOTHING
	`);
	const r = await db.execute(sql`
		SELECT id FROM channel_accounts WHERE phone_e164 = ${env.CHANNEL_PHONE_E164}
	`);
	const id = rows<{ id: string }>(r)[0]?.id;
	if (!id) throw new Error("conta de teste nao encontrada");
	return id;
};

const inserirLead = async (db: Db, telefone: string): Promise<string> => {
	const r = await db.execute(sql`
		INSERT INTO leads (
			phone_number, origin_source, legal_basis, purpose,
			legal_registered_at, first_contact_by_human, wa_validation_state, opt_out
		)
		VALUES (
			${telefone}, 'teste', 'legitimo_interesse', 'prospeccao',
			'2025-01-01T12:00:00Z', true, 'VALIDO', false
		)
		RETURNING id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

const inserirConversa = async (
	db: Db,
	leadId: string,
	contaId: string,
): Promise<string> => {
	const r = await db.execute(sql`
		INSERT INTO conversations (lead_id, channel_account_id, state, engagement_mode)
		VALUES (${leadId}, ${contaId}, 'novo', 'bot_active')
		RETURNING id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

const registrarTransicao = async (
	db: Db,
	conversaId: string,
	from: string,
	to: string,
	changedBy: string,
	quando: Date,
): Promise<void> => {
	await db.execute(sql`
		INSERT INTO status_history (conversation_id, from_state, to_state, changed_by, changed_at)
		VALUES (${conversaId}, ${from}, ${to}, ${changedBy}, ${quando})
	`);
};

const registrarNovos = async (db: Db, dia: string, nov: number): Promise<void> => {
	await db.execute(sql`
		INSERT INTO daily_counters (day, kind, count) VALUES (${dia}::date, 'new_contacts', ${nov})
	`);
};

let conn: OpenDb;
let db: Db;

beforeAll(async () => {
	conn = await openDb(env.DATABASE_URL);
	db = conn.db;
});

afterAll(async () => {
	await closeDb(conn);
});

describe("dailyReport — fórmula sobre status_history (R-061/R-062)", () => {
	it("apura reuniões do bot, qualificados distintos e a taxa com denominador", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadA = await inserirLead(tx, telefoneAleatorio());
			const conversaA = await inserirConversa(tx, leadA, contaId);
			const leadB = await inserirLead(tx, telefoneAleatorio());
			const conversaB = await inserirConversa(tx, leadB, contaId);

			// A: duas transições BOT no dia → 2 reuniões; distinct conta 1.
			await registrarTransicao(tx, conversaA, "novo", "qualificando", "bot", NO_DIA(9, 0));
			await registrarTransicao(tx, conversaA, "qualificando", "aquecido", "bot", NO_DIA(10, 0));
			// B: qualificou por ADMIN → conta em qualificados, NÃO em reuniões do bot.
			await registrarTransicao(tx, conversaB, "novo", "qualificando", "admin", NO_DIA(11, 0));
			// B de novo por bot, mas para fora dos estados-alvo → não conta.
			await registrarTransicao(tx, conversaB, "qualificando", "novo", "bot", NO_DIA(11, 30));
			// A em OUTRO dia → fora da apuração.
			await registrarTransicao(tx, conversaA, "novo", "qualificando", "bot", instanteEmZona(TZ, 2026, 9, 28, 15, 0));

			await registrarNovos(tx, DIA, 10);

			const relatorio = await dailyReport(tx as unknown as Db, DIA);
			expect(relatorio.reunioesAgendadas).toBe(2);
			expect(relatorio.leadsQualificados).toBe(2); // A e B, A contado uma vez
			expect(relatorio.leadsNovos).toBe(10);
			expect(relatorio.taxaQualificacao).toBe(20); // 2/10*100
			expect(relatorio.metaReunioesMes).toBe(5);
			expect(relatorio.metaTaxaQualificacao).toBe(30);
		});
	});

	it("nada no dia devolve zeros e taxa null (sem dados ≠ 0%)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const relatorio = await dailyReport(tx as unknown as Db, "2030-01-02");
			expect(relatorio.reunioesAgendadas).toBe(0);
			expect(relatorio.leadsQualificados).toBe(0);
			expect(relatorio.leadsNovos).toBe(0);
			expect(relatorio.taxaQualificacao).toBeNull();
		});
	});

	it("denominador zero devolve null, nunca 0 (T-01-30)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const lead = await inserirLead(tx, telefoneAleatorio());
			const conversa = await inserirConversa(tx, lead, contaId);
			await registrarTransicao(tx, conversa, "novo", "qualificando", "bot", NO_DIA(9, 0));
			// Sem linha em daily_counters para o dia → leads_novos = 0.

			const relatorio = await dailyReport(tx as unknown as Db, DIA);
			expect(relatorio.reunioesAgendadas).toBe(1);
			expect(relatorio.leadsQualificados).toBe(1);
			expect(relatorio.leadsNovos).toBe(0);
			expect(relatorio.taxaQualificacao).toBeNull();
		});
	});

	it("ignora contadores de outros dias e de outros kinds", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const lead = await inserirLead(tx, telefoneAleatorio());
			const conversa = await inserirConversa(tx, lead, contaId);
			// 'sent' do mesmo dia NÃO é denominador de qualificação.
			await tx.execute(sql`
				INSERT INTO daily_counters (day, kind, count) VALUES (${DIA}::date, 'sent', 12)
			`);
			// 'new_contacts' de OUTRO dia também não.
			await registrarNovos(tx, OUTRO_DIA, 7);
			await registrarTransicao(tx, conversa, "novo", "qualificando", "bot", NO_DIA(9, 0));

			const relatorio = await dailyReport(tx as unknown as Db, DIA);
			expect(relatorio.leadsNovos).toBe(0);
			expect(relatorio.taxaQualificacao).toBeNull();
			expect(relatorio.reunioesAgendadas).toBe(1);
		});
	});
});