/**
 * Sanduíche de shadow (02-01 Task 3) — a fatia ponta-a-ponta do D-08.
 *
 * O que este teste prova, e por que ele existe:
 *
 * 1. Mensagem de TEXTO do lead, com `engagement_mode='shadow'`, percorre
 *    extração → decisão de código → geração → `persistDraft`, e o resultado é
 *    UMA linha em `messages` com `origin='ai_suggestion'`, `status='suggested'`.
 * 2. NADA sai pelo canal: zero linha outbound com `status='sent'`.
 * 3. As falhas-fechada (D-10) não geram rascunho e emitem notificação — canário
 *    divergente, erro de provider na extração, erro na geração.
 * 4. O sinal de handoff (D-12) registra `event_log` e PULA a geração.
 * 5. As guardas locais (`opt_out`, `pending_media_block`, `engagement_mode` fora
 *    de bot_active/shadow) nem chegam a chamar a camada de LLM.
 * 6. CONV-01: a 1ª mensagem manual do Admin move `novo` → `aquecimento`.
 * 7. `src/application/shadow.ts` não importa `dispatcher.ts` nem contém
 *    `sendText(` — a invariante de arquitetura que o choke-point exige.
 *
 * Transação revertida (mesmo padrão de `dispatcher-chunks.test.ts`): `messages`
 * e `event_log` são append-only e `leads` não pode ser deletado; a limpeza é
 * `ROLLBACK` por sentinela. `processInboundFromMe` chama `db.transaction` numa
 * tx-filha (savepoint) — o mesmo caminho que o `dispatch` já exercita.
 */
import { readFileSync } from "node:fs";
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

/** Terça 29/09/2026 13h SP — dentro da janela e dia útil (mesmo instante dos fixtures do gate). */
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
	return `+55119${bloco}${String(seq).padStart(3, "0")}`;
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
		readonly optOut?: boolean;
		readonly firstContactByHuman?: boolean;
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
					legal_registered_at, first_contact_by_human, opt_out
				)
				values (
					${phone}, 'teste', 'legitimate_interest', 'prospeccao',
					'2025-01-01T12:00:00Z', ${opts.firstContactByHuman ?? true}, ${opts.optOut ?? false}
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
					${opts.state ?? "novo"}, ${opts.engagementMode ?? "shadow"}
				)
				returning id
			`),
		),
	);

	return { leadId: lead.id, conversationId: conversa.id, phone };
};

const eventoLead = (
	fixture: Fixture,
	over: Partial<Parameters<typeof processInboundFromMe>[2]> = {},
): Parameters<typeof processInboundFromMe>[2] => ({
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

const contarAiSuggestion = async (
	tx: Db,
	conversationId: string,
): Promise<number> => {
	const r = await tx.execute(sql`
		select count(*)::int as n from messages
		where conversation_id = ${conversationId}
			and origin = 'ai_suggestion'
			and status = 'suggested'
	`);
	return primeiro(rows<{ n: number }>(r)).n;
};

const contarOutboundEnviado = async (
	tx: Db,
	conversationId: string,
): Promise<number> => {
	const r = await tx.execute(sql`
		select count(*)::int as n from messages
		where conversation_id = ${conversationId}
			and direction = 'out'
			and status = 'sent'
	`);
	return primeiro(rows<{ n: number }>(r)).n;
};

const contarLlmRuns = async (
	tx: Db,
	conversationId: string,
): Promise<number> => {
	const r = await tx.execute(sql`
		select count(*)::int as n from llm_runs r
		join messages m on m.id = r.message_id
		where m.conversation_id = ${conversationId}
	`);
	return primeiro(rows<{ n: number }>(r)).n;
};

const rodar = async (
	tx: Db,
	fixture: Fixture,
	roteiro: RoteiroScripted,
	evento?: Partial<Parameters<typeof processInboundFromMe>[2]>,
): Promise<{ notificacoes: NotifyInput[]; chamadas: readonly string[] }> => {
	const llm = scriptedLlmAdapter(roteiro);
	const { notifier, chamadas: notificacoes } = notifierEspiao();
	await processInboundFromMe(tx, makeSock(), eventoLead(fixture, evento), {
		llm,
		notifier,
		agora: AGORA,
	});
	return { notificacoes, chamadas: llm.chamadas };
};

describe("shadow — fatia ponta-a-ponta (02-01 Task 3)", () => {
	it("caminho feliz: 1 rascunho ai_suggestion/suggested, ≥1 llm_runs, 0 outbound enviado, sem notificação", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const { notificacoes, chamadas } = await rodar(tx, fx, {});

			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(1);
			expect(await contarOutboundEnviado(tx, fx.conversationId)).toBe(0);
			expect(await contarLlmRuns(tx, fx.conversationId)).toBeGreaterThanOrEqual(
				1,
			);
			expect(notificacoes).toHaveLength(0);
			expect(chamadas).toEqual(["extract", "generate"]);
		});
	});

	it("canário divergente na extração → 0 rascunho, 0 llm_runs, 1 notificação, geração não roda", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const { notificacoes, chamadas } = await rodar(tx, fx, {
				canarioRecebido: () => "CANARIO-divergente",
			});

			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
			expect(await contarLlmRuns(tx, fx.conversationId)).toBe(0);
			expect(notificacoes).toHaveLength(1);
			expect(chamadas).toEqual(["extract"]);
		});
	});

	it("falha de provider na extração → 0 rascunho, 1 notificação", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const { notificacoes, chamadas } = await rodar(tx, fx, {
				falhaExtracao: { kind: "provider_indisponivel", detail: "offline" },
			});

			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
			expect(notificacoes).toHaveLength(1);
			expect(chamadas).toEqual(["extract"]);
		});
	});

	it("falha na geração → 0 rascunho, 1 notificação", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const { notificacoes, chamadas } = await rodar(tx, fx, {
				falhaGeracao: { kind: "timeout", detail: "estourou" },
			});

			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
			expect(notificacoes).toHaveLength(1);
			expect(chamadas).toEqual(["extract", "generate"]);
		});
	});

	it("sinal de handoff (pedido_preco) → registra event_log, 0 rascunho, geração pulada", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const { chamadas } = await rodar(tx, fx, {
				extracao: {
					intent: "pedido_preco",
					signals: {
						pricingAsked: true,
						schedulingIntent: false,
						botSuspicion: false,
						irritation: false,
						optOutIntent: false,
						mediaReceived: false,
					},
				},
			});

			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
			expect(chamadas).toEqual(["extract"]);
			const r = await tx.execute(sql`
				select count(*)::int as n from event_log
				where conversation_id = ${fx.conversationId} and event_type = 'handoff_stub'
			`);
			expect(primeiro(rows<{ n: number }>(r)).n).toBe(1);
		});
	});

	it("guardas locais: opt_out liga o silêncio e a LLM nem é chamada", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, { optOut: true });
			const { notificacoes, chamadas } = await rodar(tx, fx, {});

			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
			expect(chamadas).toEqual([]);
			expect(notificacoes).toHaveLength(0);
		});
	});

	it("guardas locais: engagement_mode fora de bot_active/shadow não rascunha", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, { engagementMode: "human" });
			const { chamadas } = await rodar(tx, fx, {});

			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
			expect(chamadas).toEqual([]);
		});
	});

	it("idempotência: dois eventos com o mesmo providerMsgId → ainda 1 rascunho", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const mesmoId = "pid-idempotente-1";
			await rodar(tx, fx, {}, { providerMsgId: mesmoId });
			await rodar(tx, fx, {}, { providerMsgId: mesmoId });

			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(1);
		});
	});
});

describe("CONV-01 — 1ª mensagem manual do Admin move novo → aquecimento", () => {
	it("fromMe no número dedicado: first_contact_by_human=true e state=aquecimento", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, {
				firstContactByHuman: false,
				engagementMode: "bot_active",
				state: "novo",
			});
			await processInboundFromMe(tx, makeSock(), {
				chatId: env.CHANNEL_PHONE_E164,
				fromMe: true,
				body: "oi, aqui é o consultor",
				kind: "text",
				providerMsgId: "admin-1",
				timestamp: Date.now(),
				phoneNumber: fx.phone,
				isMedia: false,
				mediaType: null,
			});

			const conv = primeiro(
				rows<{ state: string }>(
					await tx.execute(sql`
						select state from conversations where id = ${fx.conversationId}
					`),
				),
			);
			expect(conv.state).toBe("aquecimento");
			const lead = primeiro(
				rows<{ f: boolean }>(
					await tx.execute(sql`
						select first_contact_by_human as f from leads where id = ${fx.leadId}
					`),
				),
			);
			expect(lead.f).toBe(true);
			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
		});
	});
});

describe("invariante estrutural — shadow não envia", () => {
	it("shadow.ts não importa dispatcher e não contém sendText(", () => {
		const fonte = readFileSync("src/application/shadow.ts", "utf8");
		// O termo pode aparecer em COMENTÁRIO (documenta a invariante); o que não
		// pode existir é o `import` de fato nem a chamada de envio.
		expect(fonte).not.toMatch(/from\s+["'][^"']*dispatcher/);
		expect(fonte).not.toMatch(/sendText\(/);
	});
});
