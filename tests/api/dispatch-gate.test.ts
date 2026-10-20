/**
 * `POST /api/dispatch` — o gate é a única porta de saída (NFRQ-05, R-001).
 *
 * Prova que o caminho HTTP NÃO fura o gate: um envio do painel passa pelo
 * `dispatcher` (mesmas travas), devolve o status certo, e — no caso liberado —
 * grava a mensagem com `origin='admin'` (a origem do Admin, não `bot`).
 *
 * Roda em transação revertida (ver `dispatcher-choke-point.test.ts`).
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type PanelCore } from "../../src/api/server.js";
import type { DispatchDeps } from "../../src/application/dispatcher.js";
import { BarramentoEventos } from "../../src/application/event-bus.js";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import {
	criarFakeChannel,
	type EnvioFake,
} from "../../src/infra/fake-channel.js";
import { instanteEmZona, TZ } from "../gate/fixtures.js";

const DENTRO_DA_JANELA = instanteEmZona(TZ, 2026, 9, 29, 13, 0);
const TEXTO_NEUTRO = "Boa tarde! Posso ajudar em alguma coisa?";
const SENTINELA = "rollback-intencional-do-teste";
const HOST_OK = { host: "127.0.0.1" };
const AUTORIZADO = { authorization: `Bearer ${env.PANEL_TOKEN}` };

const rows = <T>(resultado: unknown): T[] => (resultado as { rows: T[] }).rows;
const primeiro = <T>(lista: readonly T[]): T => {
	const [item] = lista;
	if (item === undefined) throw new Error("esperava ao menos uma linha");
	return item;
};

let conn: OpenDb;
let db: Db;

/** Core + canal falso, para o teste inspecionar `enviados`. */
const montar = (
	tx: Db,
): { app: ReturnType<typeof buildServer>; enviados: EnvioFake[] } => {
	const enviados: EnvioFake[] = [];
	const channel = criarFakeChannel(new Map(), enviados);
	const ctx: DispatchDeps["ctx"] = {
		tz: env.TZ,
		windowStartHour: env.WINDOW_START_HOUR,
		windowEndHour: env.WINDOW_END_HOUR,
		dailyMessageLimit: env.DAILY_MESSAGE_LIMIT,
		dailyMessageCap: 30,
	};
	const core: PanelCore = {
		db: tx,
		bus: new BarramentoEventos(tx),
		dispatchDeps: { db: tx, channel, ctx },
		feriados: [],
		agora: () => DENTRO_DA_JANELA,
	};
	return { app: buildServer({ core }), enviados };
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

const inserirConta = async (db: Db): Promise<string> => {
	await db.execute(sql`
		INSERT INTO channel_accounts (phone_e164, display_name)
		VALUES (${env.CHANNEL_PHONE_E164}, 'teste-dispatch-gate')
		ON CONFLICT (phone_e164) DO NOTHING
	`);
	const r = await db.execute(sql`
		SELECT id FROM channel_accounts WHERE phone_e164 = ${env.CHANNEL_PHONE_E164}
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

const inserirLead = async (
	db: Db,
	telefone: string,
	primeiroContatoHumano: boolean,
): Promise<string> => {
	const r = await db.execute(sql`
		INSERT INTO leads (
			phone_number, origin_source, legal_basis, purpose,
			legal_registered_at, first_contact_by_human, wa_validation_state
		)
		VALUES (
			${telefone}, 'teste', 'legitimo_interesse', 'prospeccao',
			'2025-01-01T12:00:00Z', ${primeiroContatoHumano}, 'VALIDO'
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

beforeAll(async () => {
	conn = await openDb(env.DATABASE_URL);
	db = conn.db;
});

afterAll(async () => {
	await closeDb(conn);
});

describe("POST /api/dispatch — gate como única porta (NFRQ-05)", () => {
	it("corpo inválido → 400", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app } = montar(tx);
			const r = await app.inject({
				method: "POST",
				url: "/api/dispatch",
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { conversationId: "", text: "" },
			});
			expect(r.statusCode).toBe(400);
			await app.close();
		});
	});

	it("conversa inexistente → silêncio (200), nunca sendText", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app, enviados } = montar(tx);
			const r = await app.inject({
				method: "POST",
				url: "/api/dispatch",
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { conversationId: randomUUID(), text: TEXTO_NEUTRO },
			});
			expect(r.statusCode).toBe(200);
			expect(r.json()).toMatchObject({ action: "silencio" });
			expect(enviados).toHaveLength(0);
			await app.close();
		});
	});

	it("R-001: primeiro contato não-humano → 409 bloqueado, zero sendText", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(
				tx,
				`+55${Date.now() % 10_000_000_000}`,
				false,
			);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const { app, enviados } = montar(tx);

			const r = await app.inject({
				method: "POST",
				url: "/api/dispatch",
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { conversationId: conversaId, text: TEXTO_NEUTRO },
			});
			expect(r.statusCode).toBe(409);
			expect(r.json()).toMatchObject({
				action: "blocked",
				reason: "r001_primeiro_contato_nao_humano",
			});
			expect(enviados).toHaveLength(0);
			await app.close();
		});
	});

	it("AR violado no texto (preço) → 409 bloqueado, gate decide, zero sendText", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(
				tx,
				`+55${Date.now() % 10_000_000_000}`,
				true,
			);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const { app, enviados } = montar(tx);

			const r = await app.inject({
				method: "POST",
				url: "/api/dispatch",
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: {
					conversationId: conversaId,
					text: "Fica R$ 3.500 o pacote completo.",
				},
			});
			expect(r.statusCode).toBe(409);
			expect(r.json()).toMatchObject({
				action: "blocked",
				reason: "ar001_preco",
			});
			expect(enviados).toHaveLength(0);
			await app.close();
		});
	});

	it("envio liberado → 201 e a mensagem sai com origin='admin'", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(
				tx,
				`+55${Date.now() % 10_000_000_000}`,
				true,
			);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const { app, enviados } = montar(tx);

			const r = await app.inject({
				method: "POST",
				url: "/api/dispatch",
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { conversationId: conversaId, text: TEXTO_NEUTRO },
			});
			expect(r.statusCode).toBe(201);
			expect(r.json()).toMatchObject({ action: "sent" });
			expect(enviados).toHaveLength(1);

			const msg = rows<{ origin: string }>(
				await tx.execute(sql`
					SELECT origin FROM messages
					WHERE conversation_id = ${conversaId} AND direction = 'out'
				`),
			);
			expect(primeiro(msg).origin).toBe("admin");
			await app.close();
		});
	});
});
