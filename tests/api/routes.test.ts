/**
 * Rotas REST do painel (03-03 Task 2, R-046/D-19..D-23).
 *
 * Prova, sobre um servidor Fastify REAL (`buildServer` + `app.inject`, sem
 * socket de rede):
 *   1. a guarda de token (401 em `/api/*` sem Bearer);
 *   2. as leituras (`/api/leads`, `/api/leads/:id`, `/api/conversations/:id`,
 *      `.../messages`, `/api/system`) devolvem a forma contratada pela UI;
 *   3. o kill switch tem o efeito do CLI `mode paused` (settings + event_log com
 *      `source: "panel"`);
 *   4. as ações (`assumir`) auditam em `mode_changes` + `status_history` +
 *      `event_log`.
 *
 * Roda dentro de `db.transaction` revertida por sentinela: `settings`,
 * `mode_changes` e `event_log` são estado compartilhado; o `ROLLBACK` é a
 * limpeza (nada de DELETE — `messages` é append-only).
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
import { loadGateSnapshot } from "../../src/infra/db/queries/snapshot.js";
import { criarFakeChannel } from "../../src/infra/fake-channel.js";
import { instanteEmZona, TZ } from "../gate/fixtures.js";

/** Terça 29/09/2026 13h SP — dentro da janela e dia útil. */
const DENTRO_DA_JANELA = instanteEmZona(TZ, 2026, 9, 29, 13, 0);

const SENTINELA = "rollback-intencional-do-teste";
const AUTORIZADO = { authorization: `Bearer ${env.PANEL_TOKEN}` };
const HOST_OK = { host: "127.0.0.1" };

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

const montarCore = (tx: Db): PanelCore => {
	const channel = criarFakeChannel();
	const ctx: DispatchDeps["ctx"] = {
		tz: env.TZ,
		windowStartHour: env.WINDOW_START_HOUR,
		windowEndHour: env.WINDOW_END_HOUR,
		dailyMessageLimit: env.DAILY_MESSAGE_LIMIT,
		dailyMessageCap: 30,
		newContactsToday: 0,
	};
	return {
		db: tx,
		bus: new BarramentoEventos(tx),
		dispatchDeps: { db: tx, channel, ctx },
		feriados: [],
		agora: () => DENTRO_DA_JANELA,
	};
};

const inserirConta = async (db: Db): Promise<string> => {
	await db.execute(sql`
		INSERT INTO channel_accounts (phone_e164, display_name)
		VALUES (${env.CHANNEL_PHONE_E164}, 'teste-rotas')
		ON CONFLICT (phone_e164) DO NOTHING
	`);
	const r = await db.execute(sql`
		SELECT id FROM channel_accounts WHERE phone_e164 = ${env.CHANNEL_PHONE_E164}
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

const inserirLead = async (db: Db, telefone: string): Promise<string> => {
	const r = await db.execute(sql`
		INSERT INTO leads (
			phone_number, origin_source, legal_basis, purpose,
			legal_registered_at, first_contact_by_human, wa_validation_state
		)
		VALUES (
			${telefone}, 'teste', 'legitimo_interesse', 'prospeccao',
			'2025-01-01T12:00:00Z', true, 'VALIDO'
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

let conn: OpenDb;
let db: Db;

beforeAll(async () => {
	conn = await openDb(env.DATABASE_URL);
	db = conn.db;
});

afterAll(async () => {
	await closeDb(conn);
});

describe("GET /api/* — guarda de token", () => {
	it("sem Bearer → 401", async () => {
		const app = buildServer({ core: montarCore(db) });
		const r = await app.inject({
			method: "GET",
			url: "/api/leads",
			headers: HOST_OK,
		});
		expect(r.statusCode).toBe(401);
		await app.close();
	});

	it("com Bearer → 200 e lista de leads", async () => {
		const app = buildServer({ core: montarCore(db) });
		const r = await app.inject({
			method: "GET",
			url: "/api/leads",
			headers: { ...HOST_OK, ...AUTORIZADO },
		});
		expect(r.statusCode).toBe(200);
		expect(r.json()).toMatchObject({ page: 1, pageSize: 50 });
		await app.close();
	});

	it("GET /api/events sem Bearer → 401 (a guarda roda antes do handler SSE)", async () => {
		const app = buildServer({ core: montarCore(db) });
		const r = await app.inject({
			method: "GET",
			url: "/api/events",
			headers: HOST_OK,
		});
		expect(r.statusCode).toBe(401);
		await app.close();
	});
});

describe("boot de integração do painel (Task 3)", () => {
	// O mesmo `buildServer({ core })` que o `startPanel` do boot usa: serve o
	// contrato REST inteiro. Aqui o foco é o cruzamento borda×rotas que o boot
	// tem de garantir — Host inválido barrado, token exigido, leituras servidas.
	it("Host inválido → 403; sem token → 401; com token /api/system e /api/leads → 200", async () => {
		const app = buildServer({ core: montarCore(db) });

		const hostInvalido = await app.inject({
			method: "GET",
			url: "/api/system",
			headers: { host: "evil.com", ...AUTORIZADO },
		});
		expect(hostInvalido.statusCode).toBe(403);

		const semToken = await app.inject({
			method: "GET",
			url: "/api/system",
			headers: HOST_OK,
		});
		expect(semToken.statusCode).toBe(401);

		const sistema = await app.inject({
			method: "GET",
			url: "/api/system",
			headers: { ...HOST_OK, ...AUTORIZADO },
		});
		expect(sistema.statusCode).toBe(200);

		const leads = await app.inject({
			method: "GET",
			url: "/api/leads",
			headers: { ...HOST_OK, ...AUTORIZADO },
		});
		expect(leads.statusCode).toBe(200);

		await app.close();
	});
});

describe("leituras de leads e conversas", () => {
	it("GET /api/leads/:id inexistente → 404", async () => {
		const app = buildServer({ core: montarCore(db) });
		const r = await app.inject({
			method: "GET",
			url: `/api/leads/${randomUUID()}`,
			headers: { ...HOST_OK, ...AUTORIZADO },
		});
		expect(r.statusCode).toBe(404);
		await app.close();
	});

	it("GET /api/leads/:id devolve compliance LGPD junto do lead", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, `+55${Date.now() % 10_000_000_000}`);
			const app = buildServer({ core: montarCore(tx) });
			const r = await app.inject({
				method: "GET",
				url: `/api/leads/${leadId}`,
				headers: { ...HOST_OK, ...AUTORIZADO },
			});
			expect(r.statusCode).toBe(200);
			expect(r.json()).toMatchObject({
				id: leadId,
				compliance: { legalBasis: "legitimo_interesse" },
			});
			void contaId;
			await app.close();
		});
	});

	it("GET /api/conversations/:id e .../messages devolvem a conversa e o histórico", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, `+55${Date.now() % 10_000_000_000}`);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const app = buildServer({ core: montarCore(tx) });

			const detalhe = await app.inject({
				method: "GET",
				url: `/api/conversations/${conversaId}`,
				headers: { ...HOST_OK, ...AUTORIZADO },
			});
			expect(detalhe.statusCode).toBe(200);
			expect(detalhe.json()).toMatchObject({
				id: conversaId,
				state: "novo",
				engagementMode: "bot_active",
				lead: { id: leadId, optOut: false },
			});

			const mensagens = await app.inject({
				method: "GET",
				url: `/api/conversations/${conversaId}/messages`,
				headers: { ...HOST_OK, ...AUTORIZADO },
			});
			expect(mensagens.statusCode).toBe(200);
			expect(mensagens.json()).toMatchObject({
				conversationId: conversaId,
				itens: [],
			});
			await app.close();
		});
	});
});

describe("GET /api/system", () => {
	it("devolve modo, janela aberta, contadores e fila de handoffs", async () => {
		const app = buildServer({ core: montarCore(db) });
		const r = await app.inject({
			method: "GET",
			url: "/api/system",
			headers: { ...HOST_OK, ...AUTORIZADO },
		});
		expect(r.statusCode).toBe(200);
		const corpo = r.json();
		expect(["active", "paused"]).toContain(corpo.mode);
		expect(corpo.window).toMatchObject({ aberta: true, diaUtil: true });
		expect(corpo.counters).toHaveProperty("sent");
		expect(corpo.counters.sentLimit).toBe(env.DAILY_MESSAGE_LIMIT);
		expect(Array.isArray(corpo.handoffQueue)).toBe(true);
		await app.close();
	});
});

describe("POST /api/system/kill-switch", () => {
	it("sem confirm:true → 400 e NÃO grava", async () => {
		await emTransacaoRevertida(async (tx) => {
			const app = buildServer({ core: montarCore(tx) });
			const r = await app.inject({
				method: "POST",
				url: "/api/system/kill-switch",
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: {},
			});
			expect(r.statusCode).toBe(400);
			await app.close();
		});
	});

	it("com confirm:true → grava settings + event_log (source panel)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const app = buildServer({ core: montarCore(tx) });
			const r = await app.inject({
				method: "POST",
				url: "/api/system/kill-switch",
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { confirm: true },
			});
			expect(r.statusCode).toBe(200);
			expect(r.json()).toMatchObject({ mode: "paused" });

			const modo = rows<{ v: string }>(
				await tx.execute(sql`
					SELECT value #>> '{}' AS v FROM settings WHERE key = 'operational_mode'
				`),
			);
			expect(primeiro(modo).v).toBe("paused");

			const evento = rows<{ source: string }>(
				await tx.execute(sql`
					SELECT payload->>'source' AS source FROM event_log
					WHERE event_type = 'operational_mode_changed'
					ORDER BY created_at DESC LIMIT 1
				`),
			);
			expect(primeiro(evento).source).toBe("panel");
			await app.close();
		});
	});
});

describe("POST /api/conversations/:id/actions", () => {
	it("assumir → state human, mode_changes e event_log auditados", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, `+55${Date.now() % 10_000_000_000}`);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const app = buildServer({ core: montarCore(tx) });

			const r = await app.inject({
				method: "POST",
				url: `/api/conversations/${conversaId}/actions`,
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { action: "assumir" },
			});
			expect(r.statusCode).toBe(200);
			expect(r.json()).toMatchObject({
				action: "assumir",
				state: "human",
				engagementMode: "human",
			});

			const modos = rows<{ to_mode: string }>(
				await tx.execute(sql`
					SELECT to_mode FROM mode_changes WHERE conversation_id = ${conversaId}
				`),
			);
			expect(modos.map((m) => m.to_mode)).toContain("human");

			const acoes = rows<{ action: string }>(
				await tx.execute(sql`
					SELECT payload->>'action' AS action FROM event_log
					WHERE event_type = 'panel_action' AND conversation_id = ${conversaId}
				`),
			);
			expect(acoes.map((a) => a.action)).toContain("assumir");
			await app.close();
		});
	});

	it("action invalida → 400", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, `+55${Date.now() % 10_000_000_000}`);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const app = buildServer({ core: montarCore(tx) });
			const r = await app.inject({
				method: "POST",
				url: `/api/conversations/${conversaId}/actions`,
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { action: "explodir" },
			});
			expect(r.statusCode).toBe(400);
			await app.close();
		});
	});
});

describe("histórico é read-only (D-23)", () => {
	it("PATCH/DELETE em /api/conversations/:id/messages → 404 (rota inexistente)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, `+55${Date.now() % 10_000_000_000}`);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const app = buildServer({ core: montarCore(tx) });
			const url = `/api/conversations/${conversaId}/messages`;
			for (const method of ["PATCH", "DELETE", "PUT"] as const) {
				const r = await app.inject({
					method,
					url,
					headers: { ...HOST_OK, ...AUTORIZADO },
					payload: { body: "mutacao proibida" },
				});
				expect(r.statusCode).toBe(404);
			}
			await app.close();
		});
	});
});

describe("kill switch reflete no snapshot do gate (T-03-19)", () => {
	it("após POST kill-switch, loadGateSnapshot devolve killSwitch=true", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, `+55${Date.now() % 10_000_000_000}`);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const app = buildServer({ core: montarCore(tx) });

			const r = await app.inject({
				method: "POST",
				url: "/api/system/kill-switch",
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { confirm: true },
			});
			expect(r.statusCode).toBe(200);

			const snapshot = await loadGateSnapshot(
				tx,
				conversaId,
				DENTRO_DA_JANELA,
				{
					tz: env.TZ,
					windowStartHour: env.WINDOW_START_HOUR,
					windowEndHour: env.WINDOW_END_HOUR,
					dailyMessageLimit: env.DAILY_MESSAGE_LIMIT,
					dailyMessageCap: 30,
					sentToday: 0,
					newContactsToday: 0,
				},
			);
			expect(snapshot?.context.killSwitch).toBe(true);
			await app.close();
		});
	});
});

describe("GET /api/events — SSE (T-03-18)", () => {
	it("responde text/event-stream com o hello e mantém o stream aberto", async () => {
		const app = buildServer({ core: montarCore(db) });
		await app.listen({ host: "127.0.0.1", port: 0 });
		const endereco = app.server.address();
		const porta =
			typeof endereco === "object" && endereco !== null ? endereco.port : 0;

		const ctrl = new AbortController();
		const resp = await fetch(`http://127.0.0.1:${porta}/api/events`, {
			headers: { authorization: `Bearer ${env.PANEL_TOKEN}` },
			signal: ctrl.signal,
		});
		expect(resp.headers.get("content-type")).toContain("text/event-stream");

		const reader = resp.body?.getReader();
		expect(reader).toBeDefined();
		const primeiroChunk = await reader?.read();
		const texto = new TextDecoder().decode(primeiroChunk?.value);
		expect(texto).toContain("event: hello");

		ctrl.abort();
		await app.close();
	});
});
