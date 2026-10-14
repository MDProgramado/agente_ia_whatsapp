/**
 * Opt-out irreversível, qualificação auditável e `status_history` (02-02 Task 3).
 *
 * Prova, ponta a ponta com o adaptador roteirizado:
 *
 * 1. `verba=2` E `decisao=2` → estado `aquecido` no MESMO turno (R-051); com só
 *    um dos dois, permanece onde estava.
 * 2. Qualificação é ACUMULATIVA: a decisão vista depois não apaga a verba já
 *    persistida (e vice-versa) — `updateQualification` mescla.
 * 3. `objecao_preco` NÃO dispara handoff: gera o contorno (Camada 3) e deixa a
 *    qualificação avançar (R-042).
 * 4. Opt-out FORTE (matcher, autoridade D-14) → `leads.opt_out=true` + 1 linha em
 *    `optout_ledger` + handoff; a LLM nem é chamada; a guarda do banco impede
 *    desfazer o opt_out (R-024/AR-005).
 * 5. Toda transição de estado tem linha em `status_history` com `changed_by` e
 *    `reason` NÃO vazios (R-022/CRM-02) — inclui a primeira mensagem do Admin.
 * 6. CONV-06: o contorno gerado não contém valor, prazo, desconto, proposta nem
 *    agendamento (reforço local do gate).
 *
 * Transação revertida por sentinela, como `shadow.test.ts`: `messages`/`status_history`
 * são append-only e `leads` tem trigger de irreversibilidade — a limpeza é ROLLBACK.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processInboundFromMe } from "../../src/application/inbound-handler.js";
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
import {
	type RoteiroScripted,
	scriptedLlmAdapter,
} from "../../src/infra/llm/scripted-adapter.js";

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
	return `+55117${bloco}${String(seq).padStart(3, "0")}`;
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
		readonly qualification?: { verba: number | null; decisao: number | null };
		readonly firstContactByHuman?: boolean;
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
					'2025-01-01T12:00:00Z', ${opts.firstContactByHuman ?? true}
				)
				returning id
			`),
		),
	);

	const qualificacao = opts.qualification
		? sql`${JSON.stringify(opts.qualification)}::jsonb`
		: sql`'{}'::jsonb`;
	const conversa = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into conversations (lead_id, channel_account_id, state, engagement_mode, qualification)
				values (
					${lead.id}, ${conta.id},
					${opts.state ?? "qualificando"}, ${opts.engagementMode ?? "shadow"},
					${qualificacao}
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

const evento = (
	fixture: Fixture,
	over: Partial<EventoInbound> = {},
): EventoInbound => ({
	chatId: "5511999999999@s.whatsapp.net",
	fromMe: false,
	body: "oi, tudo bem?",
	kind: "text",
	providerMsgId: `pid-${Math.random()}`,
	timestamp: Date.now(),
	phoneNumber: fixture.phone,
	isMedia: false,
	mediaType: null,
	...over,
});

const rodar = async (
	tx: Db,
	fixture: Fixture,
	roteiro: RoteiroScripted,
	eventoOver: Partial<EventoInbound> = {},
): Promise<{ notificacoes: NotifyInput[]; chamadas: readonly string[] }> => {
	const llm = scriptedLlmAdapter(roteiro);
	const { notifier, chamadas: notificacoes } = notifierEspiao();
	await processInboundFromMe(tx, makeSock(), evento(fixture, eventoOver), {
		llm,
		notifier,
		agora: AGORA,
	});
	return { notificacoes, chamadas: llm.chamadas };
};

const lerConversa = async (
	tx: Db,
	id: string,
): Promise<{
	state: string;
	engagement_mode: string;
	qualification: unknown;
}> =>
	primeiro(
		rows<{ state: string; engagement_mode: string; qualification: unknown }>(
			await tx.execute(sql`
				select state, engagement_mode, qualification from conversations where id = ${id}
			`),
		),
	);

const contar = async (
	tx: Db,
	tabela: "handoff_events" | "mode_changes" | "status_history",
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

/** `optout_ledger` é chaveada por `lead_id`, não por conversa (LGPD: prova do titular). */
const contarLedgerPorLead = async (tx: Db, leadId: string): Promise<number> =>
	primeiro(
		rows<{ n: number }>(
			await tx.execute(sql`
				select count(*)::int as n from optout_ledger where lead_id = ${leadId}
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

const lerRascunho = async (tx: Db, id: string): Promise<string> =>
	primeiro(
		rows<{ body: string }>(
			await tx.execute(sql`
				select body from messages
				where conversation_id = ${id} and origin = 'ai_suggestion'
				order by created_at desc limit 1
			`),
		),
	).body;

describe("qualificação auditável (02-02 Task 3)", () => {
	it("verba=2 E decisao=2 → aquecido; e a transição é auditada em status_history (changed_by/reason)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, { state: "qualificando" });
			await rodar(tx, fx, {
				extracao: {
					qualification: { verba: 2, decisao: 2 },
					nextStateHint: "qualificando",
				},
			});

			const conv = await lerConversa(tx, fx.conversationId);
			expect(conv.state).toBe("aquecido");
			const q = conv.qualification as { verba: number; decisao: number };
			expect(q.verba).toBe(2);
			expect(q.decisao).toBe(2);

			const hist = primeiro(
				rows<{ changed_by: string; reason: string | null }>(
					await tx.execute(sql`
						select changed_by, reason from status_history
						where conversation_id = ${fx.conversationId}
							and to_state = 'aquecido'
						order by changed_at desc limit 1
					`),
				),
			);
			expect(hist.changed_by).toBe("bot");
			expect(hist.reason).toBeTruthy();
		});
	});

	it("só um dos dois valores → permanece em qualificando (não vira aquecido)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, { state: "qualificando" });
			await rodar(tx, fx, {
				extracao: {
					qualification: { verba: 2, decisao: null },
					nextStateHint: "qualificando",
				},
			});

			const conv = await lerConversa(tx, fx.conversationId);
			expect(conv.state).toBe("qualificando");
			const q = conv.qualification as { verba: number; decisao: unknown };
			expect(q.verba).toBe(2);
			expect(q.decisao).toBeNull();
		});
	});

	it("qualificação é acumulativa: decisao vista depois preserva a verba já persistida", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, {
				state: "qualificando",
				qualification: { verba: 2, decisao: null },
			});
			await rodar(tx, fx, {
				extracao: {
					qualification: { verba: null, decisao: 2 },
					nextStateHint: "qualificando",
				},
			});

			const conv = await lerConversa(tx, fx.conversationId);
			const q = conv.qualification as { verba: number; decisao: number };
			expect(q.verba).toBe(2);
			expect(q.decisao).toBe(2);
			expect(conv.state).toBe("aquecido");
		});
	});

	it("objecao_preco → gera contorno, NÃO dispara handoff e a qualificação avança", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, { state: "qualificando" });
			const { chamadas } = await rodar(
				tx,
				fx,
				{
					extracao: {
						intent: "objecao_preco",
						qualification: { verba: 1, decisao: null },
						nextStateHint: "qualificando",
					},
				},
				{ body: "achei um pouco caro pro meu orçamento, mas me conta mais" },
			);

			expect(await contar(tx, "handoff_events", fx.conversationId)).toBe(0);
			expect(chamadas).toEqual(["extract", "generate"]);
			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(1);
		});
	});

	it("CONV-06: o contorno gerado não tem valor, prazo, desconto, proposta nem agendamento", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, { state: "qualificando" });
			await rodar(tx, fx, {
				extracao: { intent: "objecao_preco", nextStateHint: "qualificando" },
			});

			const texto = await lerRascunho(tx, fx.conversationId);
			expect(texto).not.toMatch(/R\$\s*\d/);
			expect(texto).not.toMatch(/\d+\s*%/);
			expect(texto).not.toMatch(/desconto/i);
			expect(texto).not.toMatch(/\breuni(ão|ao)\b/i);
			expect(texto).not.toMatch(/\bagend(ar|o|a)\b/i);
		});
	});
});

describe("opt-out irreversível (02-02 Task 3, D-14)", () => {
	it("opt-out FORTE → leads.opt_out=true + 1 ledger + handoff; a LLM não é chamada", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, { state: "qualificando" });
			const { chamadas } = await rodar(
				tx,
				fx,
				{},
				{ body: "por favor, nao me mande mais mensagem" },
			);

			// O matcher decidiu SEM a LLM: nada de tokens gastos num opt-out.
			expect(chamadas).toEqual([]);
			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
			expect(await contarLedgerPorLead(tx, fx.leadId)).toBe(1);
			expect(await contar(tx, "handoff_events", fx.conversationId)).toBe(1);

			const lead = primeiro(
				rows<{ opt_out: boolean }>(
					await tx.execute(
						sql`select opt_out from leads where id = ${fx.leadId}`,
					),
				),
			);
			expect(lead.opt_out).toBe(true);

			const conv = await lerConversa(tx, fx.conversationId);
			expect(conv.engagement_mode).toBe("awaiting_human");
			expect(conv.state).toBe("awaiting_human");
		});
	});

	it("a guarda do banco impede desfazer o opt-out (R-024/AR-005)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, { state: "qualificando" });
			await rodar(tx, fx, {}, { body: "nao quero mais receber mensagem" });

			// O drizzle embrulha o erro do PG: a mensagem do trigger fica em `.cause`.
			let capturado: unknown;
			try {
				await tx.execute(
					sql`update leads set opt_out = false where id = ${fx.leadId}`,
				);
			} catch (erro) {
				capturado = erro;
			}
			const textoErro = [
				capturado instanceof Error ? capturado.message : "",
				capturado instanceof Error && capturado.cause instanceof Error
					? capturado.cause.message
					: "",
			].join("\n");
			expect(capturado).toBeInstanceOf(Error);
			expect(textoErro).toMatch(/opt_out nao pode ser revertido/i);
		});
	});

	it("após opt-out, uma nova mensagem não re-engaja (silêncio) e não chama a LLM", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, { state: "qualificando" });
			await rodar(tx, fx, {}, { body: "pare de me mandar mensagem" });

			const segunda = await rodar(
				tx,
				fx,
				{},
				{ body: "na verdade me conta mais", providerMsgId: "pid-2" },
			);
			expect(segunda.chamadas).toEqual([]);
			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
		});
	});

	it("a conversa não volta a bot_active depois do opt-out (segue awaiting_human)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, { state: "qualificando" });
			await rodar(tx, fx, {}, { body: "nao tenho interesse, obrigado" });
			const conv = await lerConversa(tx, fx.conversationId);
			expect(conv.engagement_mode).not.toBe("bot_active");
			expect(conv.engagement_mode).toBe("awaiting_human");
		});
	});
});

describe("status_history cobre a transição do Admin (CONV-01/R-022)", () => {
	it("novo → aquecimento pela 1ª mensagem manual grava changed_by='admin'", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, {
				state: "novo",
				engagementMode: "bot_active",
				firstContactByHuman: false,
			});
			await processInboundFromMe(tx, makeSock(), {
				chatId: env.CHANNEL_PHONE_E164,
				fromMe: true,
				body: "oi, aqui e o consultor",
				kind: "text",
				providerMsgId: "admin-1",
				timestamp: Date.now(),
				phoneNumber: fx.phone,
				isMedia: false,
				mediaType: null,
			});

			const hist = primeiro(
				rows<{
					from_state: string;
					to_state: string;
					changed_by: string;
					reason: string | null;
				}>(
					await tx.execute(sql`
						select from_state, to_state, changed_by, reason from status_history
						where conversation_id = ${fx.conversationId}
						order by changed_at desc limit 1
					`),
				),
			);
			expect(hist.from_state).toBe("novo");
			expect(hist.to_state).toBe("aquecimento");
			expect(hist.changed_by).toBe("admin");
			expect(hist.reason).toBeTruthy();
		});
	});
});
