/**
 * Handoff atômico + silêncio + notificação (02-02 Task 2, D-11/D-12/D-13).
 *
 * O que este teste prova, e por que cada item é uma invariante e não um detalhe:
 *
 * 1. As quatro escritas (handoff_events, mode_changes, engagement_mode/state,
 *    status_history) acontecem juntas. Uma falha no MEIO reverte o todo: nunca
 *    um `handoff_events` sem a parada correspondente (T-02-09).
 * 2. As 5 colunas NOT NULL de `handoff_events` são preenchidas — nenhum INSERT
 *    viola o schema.
 * 3. FLUP-05/SC4: a notificação carrega LEAD (título), MOTIVO + AÇÃO
 *    (`handoff:ack <id>`) e `urgent=true`.
 * 4. Idempotência: repetir o gatilho não duplica evento nem notificação.
 * 5. Silêncio total: nenhuma linha `messages` de saída no caminho de handoff.
 * 6. `notify` que lança NÃO desfaz o handoff já commitado (T-02-10).
 *
 * `shadow` → `awaiting_human` é testado de propósito: o CHECK de `mode_changes`
 * só passou a aceitar `shadow` na migration `0006`; um `from_mode` inválido
 * derrubaria a transação inteira.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	dispararHandoff,
	type HandoffActor,
} from "../../src/application/handoff-service.js";
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

interface Fixture {
	readonly leadId: string;
	readonly conversationId: string;
	readonly channelAccountId: string;
}

const semear = async (
	tx: Db,
	opts: {
		readonly name?: string;
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

	const lead = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into leads (
					phone_number, name, origin_source, legal_basis, purpose,
					legal_registered_at, first_contact_by_human
				)
				values (
					${telefone()}, ${opts.name ?? null}, 'teste', 'legitimate_interest',
					'prospeccao', '2025-01-01T12:00:00Z', true
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
					${opts.state ?? "qualificando"}, ${opts.engagementMode ?? "bot_active"}
				)
				returning id
			`),
		),
	);

	return {
		leadId: lead.id,
		conversationId: conversa.id,
		channelAccountId: conta.id,
	};
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

const contarHandoffEvents = async (tx: Db, id: string): Promise<number> =>
	primeiro(
		rows<{ n: number }>(
			await tx.execute(sql`
				select count(*)::int as n from handoff_events where conversation_id = ${id}
			`),
		),
	).n;

const contarModeChanges = async (tx: Db, id: string): Promise<number> =>
	primeiro(
		rows<{ n: number }>(
			await tx.execute(sql`
				select count(*)::int as n from mode_changes where conversation_id = ${id}
			`),
		),
	).n;

const lerConversa = async (
	tx: Db,
	id: string,
): Promise<{
	engagement_mode: string;
	state: string;
	handoff_active: boolean;
}> =>
	primeiro(
		rows<{
			engagement_mode: string;
			state: string;
			handoff_active: boolean;
		}>(
			await tx.execute(sql`
				select engagement_mode, state, handoff_active from conversations where id = ${id}
			`),
		),
	);

interface HandoffLido {
	readonly lead_id: string;
	readonly channel_account_id: string;
	readonly triggered_by: string;
	readonly excerpt: string;
	readonly simultaneous_send_blocked: boolean;
	readonly bot_stopped_at: Date | null;
}

const lerHandoff = async (tx: Db, id: string): Promise<HandoffLido> =>
	primeiro(
		rows<HandoffLido>(
			await tx.execute(sql`
				select lead_id, channel_account_id, triggered_by, excerpt,
					simultaneous_send_blocked, bot_stopped_at
				from handoff_events where conversation_id = ${id}
				order by created_at desc limit 1
			`),
		),
	);

const contarOutboundSent = async (tx: Db, id: string): Promise<number> =>
	primeiro(
		rows<{ n: number }>(
			await tx.execute(sql`
				select count(*)::int as n from messages
				where conversation_id = ${id} and direction = 'out' and status = 'sent'
			`),
		),
	).n;

const AGORA = new Date("2026-09-29T16:00:00.000Z");

describe("dispararHandoff — atômico, idempotente e silencioso (02-02 Task 2)", () => {
	it("grava as 4 escritas juntas e notifica (FLUP-05: lead + motivo + ação + urgent)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, { name: "Padaria Aurora" });
			const { notifier, chamadas } = notifierEspiao();

			const res = await dispararHandoff(
				tx,
				{
					conversationId: fx.conversationId,
					reason: "pedido de preço (pedido_preco)",
					triggeredBy: "intent",
					triggerDetail: "pedido_preco",
					excerpt: "quanto custa?",
					actor: "bot",
					agora: AGORA,
				},
				{ notifier },
			);

			expect(res.disparado).toBe(true);
			expect(res.handoffId).toEqual(expect.any(String));

			expect(await contarHandoffEvents(tx, fx.conversationId)).toBe(1);
			expect(await contarModeChanges(tx, fx.conversationId)).toBe(1);

			const conv = await lerConversa(tx, fx.conversationId);
			expect(conv.engagement_mode).toBe("awaiting_human");
			expect(conv.state).toBe("awaiting_human");
			expect(conv.handoff_active).toBe(true);

			const h = await lerHandoff(tx, fx.conversationId);
			expect(h.lead_id).toBe(fx.leadId);
			expect(h.channel_account_id).toBe(fx.channelAccountId);
			expect(h.triggered_by).toBe("intent");
			expect(h.excerpt).toBe("quanto custa?");
			expect(h.simultaneous_send_blocked).toBe(true);
			expect(h.bot_stopped_at).not.toBeNull();

			expect(chamadas).toHaveLength(1);
			const n = primeiro(chamadas);
			expect(n.title).toContain("Padaria Aurora");
			expect(n.message).toContain("pedido de preço");
			expect(n.message).toContain("handoff:ack");
			expect(n.message).toContain(res.handoffId ?? "");
			expect(n.urgent).toBe(true);
		});
	});

	it("silêncio total: nenhuma mensagem de saída no caminho de handoff", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			await dispararHandoff(tx, {
				conversationId: fx.conversationId,
				reason: "irritacao",
				triggeredBy: "intent",
				agora: AGORA,
			});
			expect(await contarOutboundSent(tx, fx.conversationId)).toBe(0);
		});
	});

	it("idempotência: 2 chamadas → 1 evento, 1 mode_change, 1 notificação", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const { notifier, chamadas } = notifierEspiao();
			const entrada = {
				conversationId: fx.conversationId,
				reason: "bot_suspicion",
				triggeredBy: "intent" as const,
				agora: AGORA,
			};

			const a = await dispararHandoff(tx, entrada, { notifier });
			const b = await dispararHandoff(tx, entrada, { notifier });

			expect(a.disparado).toBe(true);
			expect(b.disparado).toBe(false);
			expect(b.handoffId).toBeNull();
			expect(await contarHandoffEvents(tx, fx.conversationId)).toBe(1);
			expect(await contarModeChanges(tx, fx.conversationId)).toBe(1);
			expect(chamadas).toHaveLength(1);
		});
	});

	it("rollback: falha no MEIO (mode_changes) não deixa handoff_events parcial", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);

			// `actor` inválido só estoura no SEGUNDO INSERT (mode_changes), depois
			// de `handoff_events` já ter sido inserido — exatamente o estado parcial
			// que a transação única tem de impedir.
			await expect(
				dispararHandoff(tx, {
					conversationId: fx.conversationId,
					reason: "teste de rollback",
					triggeredBy: "intent",
					actor: "robot" as unknown as HandoffActor,
					agora: AGORA,
				}),
			).rejects.toThrow();

			expect(await contarHandoffEvents(tx, fx.conversationId)).toBe(0);
			const conv = await lerConversa(tx, fx.conversationId);
			expect(conv.handoff_active).toBe(false);
			expect(conv.engagement_mode).toBe("bot_active");
		});
	});

	it("conversa em `shadow` → from_mode aceito pelo CHECK da 0006", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx, { engagementMode: "shadow" });
			await dispararHandoff(tx, {
				conversationId: fx.conversationId,
				reason: "opt_out ambiguo",
				triggeredBy: "intent",
				agora: AGORA,
			});
			const modo = primeiro(
				rows<{ from_mode: string; to_mode: string }>(
					await tx.execute(sql`
						select from_mode, to_mode from mode_changes where conversation_id = ${fx.conversationId}
					`),
				),
			);
			expect(modo.from_mode).toBe("shadow");
			expect(modo.to_mode).toBe("awaiting_human");
		});
	});

	it("notify que lança NÃO propaga — o handoff já commitado permanece", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const notifierQueLanca: NotifyPort = {
				notify: (): Promise<void> => {
					throw new Error("boom na notificacao");
				},
			};

			await expect(
				dispararHandoff(
					tx,
					{
						conversationId: fx.conversationId,
						reason: "falha de provider",
						triggeredBy: "validation_error",
						agora: AGORA,
					},
					{ notifier: notifierQueLanca },
				),
			).resolves.toEqual({ disparado: true, handoffId: expect.any(String) });

			expect(await contarHandoffEvents(tx, fx.conversationId)).toBe(1);
		});
	});

	it("invariante estrutural: handoff-service.ts chama notify(", () => {
		const fonte = readFileSync("src/application/handoff-service.ts", "utf8");
		expect(fonte).toMatch(/notify\(/);
	});
});
