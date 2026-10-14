/**
 * Gate de saída de shadow (D-17/D-18, ADR-010) — relatório a partir do BANCO e
 * veredito PASS/FAIL sobre um DB semeado.
 *
 * ## O que este teste prova
 *
 * 1. O relatório lê as métricas de D-17 das tabelas append-only (rascunhos,
 *    revisão, handoff, opt-out, LLM, pós-gate) — não de logs.
 * 2. O veredito é FRONTEIRA-EXATA: com dias = 14, revisados = 100, aprovação =
 *    0.80 (e zero alucinação/revelação), o veredito é PASS. Cair em QUALQUER um
 *    dos cinco rebaixa para FAIL com o motivo em pt-BR.
 * 3. O detector de deriva do pós-gate conta um bloqueio cujo texto, re-escaneado
 *    agora, é liberado.
 *
 * ## Isolamento por JANELA (por que não contar o banco inteiro)
 *
 * O relatório de produção cobre todo o histórico; o teste passa uma `janela` no
 * futuro distante (2027) em torno de um `agora` fixo. Assim o resultado depende
 * SÓ dos dados semeados — nenhuma sobra de outro teste pode mexer na contagem.
 * Todos os testes rodam em transação revertida (o mesmo padrão de
 * `daily-report.test.ts`).
 */
import { randomInt, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type BuildShadowReportOpts,
	buildShadowReport,
} from "../../scripts/shadow-report.js";
import { env } from "../../src/config/env.js";
import { PREFIXO_DETALHE_POS_GATE } from "../../src/domain/llm/post-gate.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";

const DIA_MS = 86_400_000;
/** Instante fixo no futuro distante: nenhum dado real (2026) cai nesta janela. */
const AGORA = new Date("2027-01-15T12:00:00.000Z");
/** Primeiro rascunho: exatamente 14 dias antes → fronteira de `minDaysOfOperation`. */
const INICIO = new Date(AGORA.getTime() - 14 * DIA_MS);
const OPTS: BuildShadowReportOpts = {
	agora: AGORA,
	janela: {
		desde: new Date(AGORA.getTime() - 20 * DIA_MS),
		ate: new Date(AGORA.getTime() + DIA_MS),
	},
};

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

const telefoneAleatorio = (): string =>
	`+55${randomInt(10_000_000_000, 99_999_999_999)}`;

const inserirConta = async (tx: Db): Promise<string> => {
	await tx.execute(sql`
		insert into channel_accounts (phone_e164, display_name)
		values (${env.CHANNEL_PHONE_E164}, 'teste-shadow-report')
		on conflict (phone_e164) do nothing
	`);
	const r = await tx.execute(sql`
		select id from channel_accounts where phone_e164 = ${env.CHANNEL_PHONE_E164}
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

const inserirLead = async (tx: Db, telefone: string): Promise<string> => {
	const r = await tx.execute(sql`
		insert into leads (
			phone_number, origin_source, legal_basis, purpose,
			legal_registered_at, first_contact_by_human, wa_validation_state, opt_out
		)
		values (
			${telefone}, 'teste', 'legitimo_interesse', 'prospeccao',
			'2025-01-01T12:00:00Z', true, 'VALIDO', false
		)
		returning id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

const inserirConversa = async (
	tx: Db,
	leadId: string,
	contaId: string,
): Promise<string> => {
	const r = await tx.execute(sql`
		insert into conversations (lead_id, channel_account_id, state, engagement_mode)
		values (${leadId}, ${contaId}, 'novo', 'shadow')
		returning id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

const semear = async (
	tx: Db,
): Promise<{ conta: string; lead: string; conversa: string }> => {
	const conta = await inserirConta(tx);
	const lead = await inserirLead(tx, telefoneAleatorio());
	const conversa = await inserirConversa(tx, lead, conta);
	return { conta, lead, conversa };
};

/** Semeia `quantidade` rascunhos (`origin='ai_suggestion'`) com o mesmo `quando`. */
const semearRascunhos = async (
	tx: Db,
	conversaId: string,
	quantidade: number,
	quando: Date,
): Promise<void> => {
	const chave = randomUUID();
	await tx.execute(sql`
		insert into messages (conversation_id, direction, origin, kind, body, status, idempotency_key, created_at)
		select
			${conversaId}::uuid, 'out', 'ai_suggestion', 'text',
			'rascunho ' || g::text, 'suggested',
			${chave} || '-' || g::text, ${quando}::timestamptz
		from generate_series(1, ${quantidade}::int) as g
	`);
};

/** Registra a decisão de revisão: os `aprovados` primeiros viram `approved`, o resto `edited`. */
const revisar = async (
	tx: Db,
	conversaId: string,
	aprovados: number,
): Promise<void> => {
	await tx.execute(sql`
		insert into review_events (message_id, decision, actor, edited_text, created_at)
		select
			m.id,
			case when row_number() over (order by m.id) <= ${aprovados}::int then 'approved' else 'edited' end,
			'admin',
			case when row_number() over (order by m.id) <= ${aprovados}::int then null else 'texto editado' end,
			${INICIO}::timestamptz
		from messages m
		where m.conversation_id = ${conversaId}::uuid and m.origin = 'ai_suggestion'
	`);
};

/** Grava um negativo do pós-gate com um `excerpt` arbitrário (bloqueio L4 auditável). */
const bloquear = async (
	tx: Db,
	conversaId: string,
	leadId: string,
	ruleReference: string,
	excerpt: string,
	quando: Date,
): Promise<void> => {
	await tx.execute(sql`
		insert into blocked_attempts (
			conversation_id, lead_id, direction, guard, reason_code,
			rule_reference, excerpt, detail, blocked_at, created_at
		)
		values (
			${conversaId}::uuid, ${leadId}::uuid, 'out', ${ruleReference}, ${ruleReference},
			${ruleReference}, ${excerpt}, ${`${PREFIXO_DETALHE_POS_GATE}: ${ruleReference}`},
			${quando}::timestamptz, ${quando}::timestamptz
		)
	`);
};

describe("shadow-report — gate de saída D-17/D-18", () => {
	it("fronteira: dias=14, revisados=100, aprovação=0.80 → PASS", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { conversa } = await semear(tx);
			await semearRascunhos(tx, conversa, 100, INICIO);
			await revisar(tx, conversa, 80);

			const r = await buildShadowReport(tx, OPTS);

			expect(r.diasOperacao).toBe(14);
			expect(r.rascunhos).toBe(100);
			expect(r.revisados).toBe(100);
			expect(r.aprovados).toBe(80);
			expect(r.editados).toBe(20);
			expect(r.descartados).toBe(0);
			expect(r.naoRevisados).toBe(0);
			expect(r.taxaAprovacao).toBeCloseTo(0.8, 10);
			expect(r.alucinacoesCriticas).toBe(0);
			expect(r.revelacoesAutomacao).toBe(0);
			expect(r.verdict).toBe("PASS");
			expect(r.motivos).toEqual([]);
		});
	});

	it("aprovação abaixo de 0.80 → FAIL com motivo", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { conversa } = await semear(tx);
			await semearRascunhos(tx, conversa, 100, INICIO);
			await revisar(tx, conversa, 79);

			const r = await buildShadowReport(tx, OPTS);

			expect(r.taxaAprovacao).toBeCloseTo(0.79, 10);
			expect(r.verdict).toBe("FAIL");
			expect(r.motivos.join(" | ")).toMatch(/taxa de aprovação/);
		});
	});

	it("menos de 100 rascunhos revisados → FAIL com motivo", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { conversa } = await semear(tx);
			await semearRascunhos(tx, conversa, 99, INICIO);
			await revisar(tx, conversa, 99);

			const r = await buildShadowReport(tx, OPTS);

			expect(r.revisados).toBe(99);
			expect(r.verdict).toBe("FAIL");
			expect(r.motivos.join(" | ")).toMatch(/revisados/);
		});
	});

	it("menos de 14 dias de operação → FAIL com motivo", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { conversa } = await semear(tx);
			const recente = new Date(AGORA.getTime() - 13 * DIA_MS);
			await semearRascunhos(tx, conversa, 100, recente);
			await revisar(tx, conversa, 80);

			const r = await buildShadowReport(tx, OPTS);

			expect(r.diasOperacao).toBe(13);
			expect(r.verdict).toBe("FAIL");
			expect(r.motivos.join(" | ")).toMatch(/dias de operação/);
		});
	});

	it("uma alucinação crítica de conteúdo (AR-001) → FAIL e conta o bloqueio", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { conversa, lead } = await semear(tx);
			await semearRascunhos(tx, conversa, 100, INICIO);
			await revisar(tx, conversa, 80);
			await bloquear(
				tx,
				conversa,
				lead,
				"ar001_preco",
				"Vou te passar o valor: R$ 3.500",
				INICIO,
			);

			const r = await buildShadowReport(tx, OPTS);

			expect(r.alucinacoesCriticas).toBe(1);
			expect(r.bloqueiosPosGate).toBe(1);
			expect(r.falsosPositivosPosGate).toBe(0);
			expect(r.verdict).toBe("FAIL");
			expect(r.motivos.join(" | ")).toMatch(/alucinações críticas/);
		});
	});

	it("uma revelação espontânea de automação (AR-006) → FAIL", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { conversa, lead } = await semear(tx);
			await semearRascunhos(tx, conversa, 100, INICIO);
			await revisar(tx, conversa, 80);
			await bloquear(
				tx,
				conversa,
				lead,
				"ar006_revelacao_automacao",
				"Sou um assistente virtual, nao uma pessoa",
				INICIO,
			);

			const r = await buildShadowReport(tx, OPTS);

			expect(r.revelacoesAutomacao).toBe(1);
			expect(r.alucinacoesCriticas).toBe(0);
			expect(r.verdict).toBe("FAIL");
			expect(r.motivos.join(" | ")).toMatch(/revelações/);
		});
	});

	it("detector de deriva: bloqueio cujo texto o L4 agora libera é falso-positivo", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { conversa, lead } = await semear(tx);
			// rule_reference fora do conjunto comercial (AR-004) e excerpt LEGÍTIMO:
			// re-escaneado agora, o pós-gate libera → conta como falso-positivo.
			await bloquear(
				tx,
				conversa,
				lead,
				"ar004_midia_saida",
				"Ola! Posso ajudar com sua presenca digital?",
				INICIO,
			);

			const r = await buildShadowReport(tx, OPTS);

			expect(r.bloqueiosPosGate).toBe(1);
			expect(r.falsosPositivosPosGate).toBe(1);
		});
	});

	it("DB sem dados na janela → FAIL por insuficiência (dias 0, taxa null)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const r = await buildShadowReport(tx, OPTS);

			expect(r.rascunhos).toBe(0);
			expect(r.revisados).toBe(0);
			expect(r.diasOperacao).toBe(0);
			expect(r.taxaAprovacao).toBeNull();
			expect(r.verdict).toBe("FAIL");
		});
	});

	it("lê handoff, opt-out e métricas de LLM das tabelas certas", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { conta, lead, conversa } = await semear(tx);

			await tx.execute(sql`
				insert into handoff_events (
					conversation_id, lead_id, channel_account_id, triggered_by,
					excerpt, simultaneous_send_blocked, bot_stopped_at,
					human_acknowledged_at, created_at
				)
				values (
					${conversa}::uuid, ${lead}::uuid, ${conta}::uuid, 'keyword',
					'preco', true, ${INICIO}::timestamptz,
					${INICIO}::timestamptz, ${INICIO}::timestamptz
				)
			`);
			await tx.execute(sql`
				insert into optout_ledger (
					lead_id, event_type, source, detected_by, raw_content,
					legal_basis, purpose, occurred_at, recorded_at
				)
				values (
					${lead}::uuid, 'opt_out', 'auto_detected', 'deterministic',
					'nao quero mais receber', 'legitimo_interesse', 'prospeccao',
					${INICIO}::timestamptz, ${INICIO}::timestamptz
				)
			`);
			await tx.execute(sql`
				insert into llm_runs (
					message_id, model, prompt_tokens, completion_tokens, latency_ms,
					cost_usd, prompt_version, policy_version, zod_parse_ok, canary_ok, created_at
				)
				values
					(null, 'scripted', 10, 5, 100, 0.001, 'v1', 'p1', true, true, ${INICIO}::timestamptz),
					(null, 'scripted', 12, 6, 200, 0.001, 'v1', 'p1', false, true, ${INICIO}::timestamptz)
			`);

			const r = await buildShadowReport(tx, OPTS);

			expect(r.handoffs).toBe(1);
			expect(r.handoffsReconhecidos).toBe(1);
			expect(r.optOuts).toBe(1);
			expect(r.corridasLlm).toBe(2);
			expect(r.falhasLlm).toBe(1);
			expect(r.taxaFalhaLlm).toBeCloseTo(0.5, 10);
			expect(r.tokensEntrada).toBe(22);
			expect(r.tokensSaida).toBe(11);
			expect(r.custoTotalUsd).toBeCloseTo(0.002, 6);
			expect(r.latenciaMediaMs).toBe(150);
		});
	});
});
