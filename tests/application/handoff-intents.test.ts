/**
 * CR-02 — `duvida_complexa` como gatilho de handoff (R-065/FLUP-09).
 *
 * Duas provas, ambas no mapeamento por CÓDIGO da Camada 2 (`INTENCOES_HANDOFF`):
 *
 * 1. CONTRATO do conjunto: `INTENCOES_HANDOFF` contém EXATAMENTE os 8 intents
 *    requeridos. Trava a especificação — omitir qualquer um deles passa a falhar.
 * 2. E2E: extração com `intent = 'duvida_complexa'` dispara `dispararHandoff`
 *    atomicamente (handoff_events + mode_changes + engagement_mode/state
 *    `awaiting_human` + `handoff_active` na MESMA transação) e o bot CALA (D-13):
 *    a Camada 3 (`generate`) nunca é chamada e nenhum rascunho `ai_suggestion`
 *    é persistido.
 *
 * Transação revertida por sentinela, como `qualification.test.ts`: `messages`/
 * `handoff_events`/`mode_changes` são append-only — a limpeza é ROLLBACK.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	INTENCOES_HANDOFF,
	processInboundFromMe,
} from "../../src/application/inbound-handler.js";
import { env } from "../../src/config/env.js";
import type {
	NotifyInput,
	NotifyPort,
} from "../../src/domain/ports/NotifyPort.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import { scriptedLlmAdapter } from "../../src/infra/llm/scripted-adapter.js";

const AGORA = new Date("2026-09-29T16:00:00.000Z");
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

let seq = 0;
const telefone = (): string => {
	seq += 1;
	const bloco = String(Date.now() % 100000).padStart(5, "0");
	return `+55118${bloco}${String(seq).padStart(3, "0")}`;
};

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

const makeSock = (): Parameters<typeof processInboundFromMe>[1] =>
	({
		signalRepository: { lidMapping: {} },
	}) as unknown as Parameters<typeof processInboundFromMe>[1];

interface Fixture {
	readonly leadId: string;
	readonly conversationId: string;
	readonly phone: string;
}

const semear = async (
	tx: Db,
	opts: {
		readonly engagementMode?: string;
		readonly state?: string;
	} = {},
): Promise<Fixture> => {
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

	const phone = telefone();
	const lead = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into leads (
					phone_number, origin_source, legal_basis, purpose,
					legal_registered_at, first_contact_by_human
				)
				values (
					${phone}, 'teste', 'legitimate_interest', 'prospeccao',
					'2025-01-01T12:00:00Z', true
				)
				returning id
			`),
		),
	);

	const conversa = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into conversations (lead_id, channel_account_id, state, engagement_mode)
				values (
					${lead.id}, ${conta.id},
					${opts.state ?? "novo"}, ${opts.engagementMode ?? "bot_active"}
				)
				returning id
			`),
		),
	);

	return { leadId: lead.id, conversationId: conversa.id, phone };
};

const notifierEspiao = (): {
	notifier: NotifyPort;
	chamadas: NotifyInput[];
} => {
	const chamadas: NotifyInput[] = [];
	return {
		notifier: {
			notify: (input: NotifyInput): Promise<void> => {
				chamadas.push(input);
				return Promise.resolve();
			},
		},
		chamadas,
	};
};

type EventoInbound = Parameters<typeof processInboundFromMe>[2];

const evento = (fixture: Fixture): EventoInbound => ({
	chatId: "5511999999999@s.whatsapp.net",
	fromMe: false,
	body: "como voces integram com nosso ERP legado sem API?",
	kind: "text",
	providerMsgId: `pid-${Math.random()}`,
	timestamp: Date.now(),
	phoneNumber: fixture.phone,
	isMedia: false,
	mediaType: null,
});

const contar = async (
	tx: Db,
	tabela: "handoff_events" | "mode_changes",
	conversationId: string,
): Promise<number> =>
	primeiro(
		rows<{ n: number }>(
			await tx.execute(sql`
				select count(*)::int as n from ${sql.raw(tabela)}
				where conversation_id = ${conversationId}
			`),
		),
	).n;

const contarAiSuggestion = async (tx: Db, id: string): Promise<number> =>
	primeiro(
		rows<{ n: number }>(
			await tx.execute(sql`
				select count(*)::int as n from messages
				where conversation_id = ${id} and origin = 'ai_suggestion'
			`),
		),
	).n;

describe("contrato do conjunto INTENCOES_HANDOFF (FLUP-09/R-065)", () => {
	it("contém EXATAMENTE os 8 intents de handoff requeridos", () => {
		const esperado = [
			"ameaca",
			"bot_suspicion",
			"duvida_complexa",
			"intencao_agendar",
			"irritacao",
			"midia_recebida",
			"pedido_optout",
			"pedido_preco",
		].sort();
		expect([...INTENCOES_HANDOFF].sort()).toEqual(esperado);
	});
});

describe("handoff determinístico aditivo (R-012/R-025/R-057/R-065)", () => {
	it.each([
		["preço", "quanto custa esse serviço?"],
		["preço sem acento", "qual e o preço desse site?"],
		["preço com é", "é quanto o investimento?"],
		["agendamento", "podemos agendar uma conversa amanhã?"],
		["bot", "você é um bot?"],
		["irritação", "que irritante, isso não resolve nada"],
	])("gatilho %s → handoff sem chamar a LLM", async (_rotulo, body) => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const llm = scriptedLlmAdapter();
			const { notifier, chamadas: notificacoes } = notifierEspiao();
			const evt = evento(fx);

			await processInboundFromMe(
				tx,
				makeSock(),
				{ ...evt, body },
				{ llm, notifier, agora: AGORA },
			);

			expect(await contar(tx, "handoff_events", fx.conversationId)).toBe(1);
			const he = primeiro(
				rows<{ triggered_by: string }>(
					await tx.execute(sql`
							select triggered_by from handoff_events
							where conversation_id = ${fx.conversationId}
						`),
				),
			);
			expect(he.triggered_by).toBe("keyword");
			expect(llm.chamadas).toEqual([]);
			expect(notificacoes.length).toBeGreaterThanOrEqual(1);
		});
	});

	it("gatilho determinístico vence falha da LLM e não chama a LLM", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const llm = scriptedLlmAdapter({
				falhaExtracao: {
					kind: "provider_indisponivel",
					detail: "api fora do ar",
				},
			});
			const { notifier } = notifierEspiao();

			await processInboundFromMe(
				tx,
				makeSock(),
				{ ...evento(fx), body: "e quanto?" },
				{ llm, notifier, agora: AGORA },
			);

			expect(await contar(tx, "handoff_events", fx.conversationId)).toBe(1);
			expect(llm.chamadas).toEqual([]);
		});
	});

	it("opt-out determinístico vence extração neutra e não chama a LLM", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const llm = scriptedLlmAdapter();
			const { notifier } = notifierEspiao();
			const evt = evento(fx);

			await processInboundFromMe(
				tx,
				makeSock(),
				{ ...evt, body: "não me mande mais mensagem" },
				{ llm, notifier, agora: AGORA },
			);

			const optOut = primeiro(
				rows<{ opt_out: boolean }>(
					await tx.execute(sql`
						select opt_out from leads where id = ${fx.leadId}
					`),
				),
			);
			expect(optOut.opt_out).toBe(true);
			expect(await contar(tx, "handoff_events", fx.conversationId)).toBe(1);
			expect(llm.chamadas).toEqual([]);
		});
	});
});

describe("CR-02 — duvida_complexa dispara handoff (R-065/FLUP-09)", () => {
	it("intent duvida_complexa → handoff atômico + silêncio total (generate nunca chamado)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, {
				state: "novo",
				engagementMode: "bot_active",
			});
			const llm = scriptedLlmAdapter({
				extracao: { intent: "duvida_complexa" },
			});
			const { notifier, chamadas: notificacoes } = notifierEspiao();

			await processInboundFromMe(tx, makeSock(), evento(fx), {
				llm,
				notifier,
				agora: AGORA,
			});

			// handoff_events: UMA linha, mapeada como 'intent' com o valor do gatilho.
			expect(await contar(tx, "handoff_events", fx.conversationId)).toBe(1);
			const he = primeiro(
				rows<{ triggered_by: string; trigger_value: string | null }>(
					await tx.execute(sql`
						select triggered_by, trigger_value from handoff_events
						where conversation_id = ${fx.conversationId}
					`),
				),
			);
			expect(he.triggered_by).toBe("intent");
			expect(he.trigger_value).toBe("duvida_complexa");

			// mode_changes: a transição de postura para awaiting_human.
			expect(await contar(tx, "mode_changes", fx.conversationId)).toBe(1);
			const mc = primeiro(
				rows<{ to_mode: string }>(
					await tx.execute(sql`
						select to_mode from mode_changes where conversation_id = ${fx.conversationId}
					`),
				),
			);
			expect(mc.to_mode).toBe("awaiting_human");

			// A conversa congelou: bot cai, handoff ativo, estado awaiting_human.
			const conv = primeiro(
				rows<{
					state: string;
					engagement_mode: string;
					handoff_active: boolean;
				}>(
					await tx.execute(sql`
						select state, engagement_mode, handoff_active
						from conversations where id = ${fx.conversationId}
					`),
				),
			);
			expect(conv.engagement_mode).toBe("awaiting_human");
			expect(conv.handoff_active).toBe(true);
			expect(conv.state).toBe("awaiting_human");

			// Silêncio TOTAL (D-13): só a extração rodou; nada foi gerado nem rascunhado.
			expect(llm.chamadas).toEqual(["extract"]);
			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
			expect(notificacoes.length).toBeGreaterThanOrEqual(1);
		});
	});
});
