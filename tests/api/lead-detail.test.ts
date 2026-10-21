/**
 * Detalhe do lead no painel — opt-out manual com prova dupla e auditoria
 * read-only (03-06 Task 1, R-024/AR-005, D-23, R-064).
 *
 * Prova, sobre um servidor Fastify REAL (`buildServer` + `app.inject`, sem
 * socket de rede):
 *   1. `POST /api/leads/:id/opt-out` exige o literal `OPTOUT` (400 sem ele),
 *      grava `optout_ledger(source='manual')` + `event_log('optout_manual')`
 *      e é IDEMPOTENTE (a segunda chamada não duplica prova);
 *   2. `GET /api/leads/:id` expõe `optOutAt` (a data "Solicitado em ___");
 *   3. `GET /api/conversations/:id/audit` devolve as 3 fontes de auditoria
 *      (status_history + handoff_events + blocked_attempts) em ordem
 *      cronológica desc, e é a ÚNICA forma de ler histórico (D-23).
 *
 * Roda dentro de `db.transaction` revertida por sentinela — `optout_ledger` e
 * `event_log` são estado compartilhado; o `ROLLBACK` é a limpeza (nada de
 * DELETE — `messages`/`event_log` são append-only).
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
import { criarFakeChannel } from "../../src/infra/fake-channel.js";
import { instanteEmZona, TZ } from "../gate/fixtures.js";

/** Ter��a 29/09/2026 13h SP — dentro da janela e dia útil. */
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

/** Telefone E.164 único por chamada — `leads.phone_number` é UNIQUE. */
let contadorTelefone = 0;
const telefoneUnico = (): string => {
	contadorTelefone += 1;
	return `+5511999${String(contadorTelefone).padStart(6, "0")}`;
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
		VALUES (${env.CHANNEL_PHONE_E164}, 'teste-detalhe')
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

const contarLedger = async (db: Db, leadId: string): Promise<number> => {
	const r = await db.execute(sql`
		SELECT count(*)::int AS n FROM optout_ledger WHERE lead_id = ${leadId}
	`);
	return primeiro(rows<{ n: number }>(r)).n;
};

const contarEventos = async (db: Db, leadId: string): Promise<number> => {
	const r = await db.execute(sql`
		SELECT count(*)::int AS n FROM event_log
		WHERE event_type = 'optout_manual' AND lead_id = ${leadId}
	`);
	return primeiro(rows<{ n: number }>(r)).n;
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

describe("POST /api/leads/:id/opt-out — confirmação obrigatória (T-03-41)", () => {
	it("sem confirm → 400 e NÃO grava prova", async () => {
		await emTransacaoRevertida(async (tx) => {
			const leadId = await inserirLead(tx, telefoneUnico());
			const app = buildServer({ core: montarCore(tx) });

			const r = await app.inject({
				method: "POST",
				url: `/api/leads/${leadId}/opt-out`,
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: {},
			});
			expect(r.statusCode).toBe(400);
			expect(await contarLedger(tx, leadId)).toBe(0);

			const lead = rows<{ opt_out: boolean }>(
				await tx.execute(sql`SELECT opt_out FROM leads WHERE id = ${leadId}`),
			);
			expect(primeiro(lead).opt_out).toBe(false);
			await app.close();
		});
	});

	it("confirm diferente de 'OPTOUT' → 400 e NÃO grava prova", async () => {
		await emTransacaoRevertida(async (tx) => {
			const leadId = await inserirLead(tx, telefoneUnico());
			const app = buildServer({ core: montarCore(tx) });

			const r = await app.inject({
				method: "POST",
				url: `/api/leads/${leadId}/opt-out`,
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { confirm: "optout" },
			});
			expect(r.statusCode).toBe(400);
			expect(await contarLedger(tx, leadId)).toBe(0);
			await app.close();
		});
	});

	it("lead inexistente → 404", async () => {
		await emTransacaoRevertida(async (tx) => {
			const app = buildServer({ core: montarCore(tx) });
			const r = await app.inject({
				method: "POST",
				url: `/api/leads/${randomUUID()}/opt-out`,
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { confirm: "OPTOUT" },
			});
			expect(r.statusCode).toBe(404);
			// O corpo distingue o 404 DA ROTA do 404 de rota inexistente do Fastify.
			expect(r.json()).toMatchObject({ erro: "lead nao encontrado" });
			await app.close();
		});
	});
});

describe("POST /api/leads/:id/opt-out — prova dupla (T-03-42, R-024)", () => {
	it("confirm 'OPTOUT' → 200 + ledger source='manual' + event_log 'optout_manual'", async () => {
		await emTransacaoRevertida(async (tx) => {
			const leadId = await inserirLead(tx, telefoneUnico());
			const app = buildServer({ core: montarCore(tx) });

			const r = await app.inject({
				method: "POST",
				url: `/api/leads/${leadId}/opt-out`,
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { confirm: "OPTOUT" },
			});
			expect(r.statusCode).toBe(200);
			expect(r.json()).toMatchObject({ optOut: true, mudou: true });

			const ledger = rows<{
				source: string;
				detected_by: string | null;
				event_type: string;
			}>(
				await tx.execute(sql`
					SELECT source, detected_by, event_type
					FROM optout_ledger WHERE lead_id = ${leadId}
				`),
			);
			expect(ledger).toHaveLength(1);
			expect(primeiro(ledger).source).toBe("manual");
			expect(primeiro(ledger).detected_by).toBeNull();
			expect(primeiro(ledger).event_type).toBe("opt_out");

			const eventos = rows<{
				event_type: string;
				severity: string;
				source: string;
			}>(
				await tx.execute(sql`
					SELECT event_type, severity, payload->>'source' AS source
					FROM event_log
					WHERE event_type = 'optout_manual' AND lead_id = ${leadId}
				`),
			);
			expect(eventos).toHaveLength(1);
			expect(primeiro(eventos).severity).toBe("warn");
			expect(primeiro(eventos).source).toBe("manual");

			const lead = rows<{ opt_out: boolean }>(
				await tx.execute(sql`SELECT opt_out FROM leads WHERE id = ${leadId}`),
			);
			expect(primeiro(lead).opt_out).toBe(true);
			await app.close();
		});
	});

	it("segunda chamada → idempotente: mudou:false e NENHUMA prova duplicada", async () => {
		await emTransacaoRevertida(async (tx) => {
			const leadId = await inserirLead(tx, telefoneUnico());
			const app = buildServer({ core: montarCore(tx) });

			const primeiro = await app.inject({
				method: "POST",
				url: `/api/leads/${leadId}/opt-out`,
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { confirm: "OPTOUT" },
			});
			expect(primeiro.statusCode).toBe(200);
			expect(primeiro.json()).toMatchObject({ optOut: true, mudou: true });

			const segunda = await app.inject({
				method: "POST",
				url: `/api/leads/${leadId}/opt-out`,
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { confirm: "OPTOUT" },
			});
			expect(segunda.statusCode).toBe(200);
			expect(segunda.json()).toMatchObject({ optOut: true, mudou: false });

			expect(await contarLedger(tx, leadId)).toBe(1);
			expect(await contarEventos(tx, leadId)).toBe(1);
			await app.close();
		});
	});
});

describe("GET /api/leads/:id — optOutAt (R-064)", () => {
	it("devolve optOutAt nulo antes do opt-out e preenchido depois", async () => {
		await emTransacaoRevertida(async (tx) => {
			const leadId = await inserirLead(tx, telefoneUnico());
			const app = buildServer({ core: montarCore(tx) });

			const antes = await app.inject({
				method: "GET",
				url: `/api/leads/${leadId}`,
				headers: { ...HOST_OK, ...AUTORIZADO },
			});
			expect(antes.statusCode).toBe(200);
			expect(antes.json()).toMatchObject({ optOut: false, optOutAt: null });

			await app.inject({
				method: "POST",
				url: `/api/leads/${leadId}/opt-out`,
				headers: { ...HOST_OK, ...AUTORIZADO },
				payload: { confirm: "OPTOUT" },
			});

			const depois = await app.inject({
				method: "GET",
				url: `/api/leads/${leadId}`,
				headers: { ...HOST_OK, ...AUTORIZADO },
			});
			expect(depois.statusCode).toBe(200);
			const corpo = depois.json() as { optOut: boolean; optOutAt: string };
			expect(corpo.optOut).toBe(true);
			expect(typeof corpo.optOutAt).toBe("string");
			expect(Number.isNaN(Date.parse(corpo.optOutAt))).toBe(false);
			await app.close();
		});
	});
});

describe("GET /api/leads/:id — funil e etiquetas (wireframe §4)", () => {
	it("devolve o status do funil da conversa e as etiquetas do lead", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneUnico());
			const conversaId = await inserirConversa(tx, leadId, contaId);

			await tx.execute(sql`
				UPDATE conversations SET pipeline_status = 'qualificado'
				WHERE id = ${conversaId}
			`);

			const nomeTag = `detalhe-${randomUUID().slice(0, 8)}`;
			const tag = primeiro(
				rows<{ id: string }>(
					await tx.execute(sql`
						INSERT INTO tags (name) VALUES (${nomeTag}) RETURNING id
					`),
				),
			);
			await tx.execute(sql`
				INSERT INTO lead_tags (lead_id, tag_id) VALUES (${leadId}, ${tag.id})
			`);

			const app = buildServer({ core: montarCore(tx) });
			const r = await app.inject({
				method: "GET",
				url: `/api/leads/${leadId}`,
				headers: { ...HOST_OK, ...AUTORIZADO },
			});
			expect(r.statusCode).toBe(200);
			const corpo = r.json() as { pipelineStatus: string; tags: string[] };
			expect(corpo.pipelineStatus).toBe("qualificado");
			expect(corpo.tags).toEqual([nomeTag]);
			await app.close();
		});
	});

	it("lead sem conversa e sem etiquetas → funil nulo e lista vazia", async () => {
		await emTransacaoRevertida(async (tx) => {
			const leadId = await inserirLead(tx, telefoneUnico());
			const app = buildServer({ core: montarCore(tx) });

			const r = await app.inject({
				method: "GET",
				url: `/api/leads/${leadId}`,
				headers: { ...HOST_OK, ...AUTORIZADO },
			});
			expect(r.statusCode).toBe(200);
			const corpo = r.json() as { pipelineStatus: string | null; tags: string[] };
			expect(corpo.pipelineStatus).toBeNull();
			expect(corpo.tags).toEqual([]);
			await app.close();
		});
	});
});

describe("GET /api/conversations/:id/audit — auditoria read-only (D-23)", () => {
	it("devolve as 3 fontes de auditoria, ordenadas do mais recente ao mais antigo", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneUnico());
			const conversaId = await inserirConversa(tx, leadId, contaId);

			await tx.execute(sql`
				INSERT INTO status_history (
					conversation_id, from_state, to_state, changed_by, changed_at
				)
				VALUES
					(${conversaId}, 'novo', 'aquecimento', 'bot', '2026-09-01T10:00:00Z'),
					(${conversaId}, 'aquecimento', 'qualificando', 'bot', '2026-09-02T10:00:00Z')
			`);

			await tx.execute(sql`
				INSERT INTO handoff_events (
					conversation_id, lead_id, channel_account_id, triggered_by,
					excerpt, simultaneous_send_blocked, bot_stopped_at, created_at
				)
				VALUES (
					${conversaId}, ${leadId}, ${contaId}, 'intent',
					'pedido de preco', true, '2026-09-03T10:00:00Z', '2026-09-03T10:00:00Z'
				)
			`);

			await tx.execute(sql`
				INSERT INTO blocked_attempts (
					conversation_id, lead_id, direction, guard, reason_code,
					rule_reference, excerpt, blocked_at
				)
				VALUES (
					${conversaId}, ${leadId}, 'out', 'AR-001', 'ar001_preco',
					'ar001_preco', 'Quanto custa?', '2026-09-04T10:00:00Z'
				)
			`);

			const app = buildServer({ core: montarCore(tx) });
			const r = await app.inject({
				method: "GET",
				url: `/api/conversations/${conversaId}/audit`,
				headers: { ...HOST_OK, ...AUTORIZADO },
			});
			expect(r.statusCode).toBe(200);

			const corpo = r.json() as {
				statusHistory: { toState: string; changedAt: string }[];
				handoffEvents: { triggeredBy: string }[];
				blockedAttempts: { guard: string }[];
			};
			expect(Array.isArray(corpo.statusHistory)).toBe(true);
			expect(Array.isArray(corpo.handoffEvents)).toBe(true);
			expect(Array.isArray(corpo.blockedAttempts)).toBe(true);

			expect(corpo.statusHistory).toHaveLength(2);
			expect(corpo.statusHistory[0]?.toState).toBe("qualificando");
			expect(corpo.statusHistory[1]?.toState).toBe("aquecimento");

			expect(corpo.handoffEvents).toHaveLength(1);
			expect(corpo.handoffEvents[0]?.triggeredBy).toBe("intent");

			expect(corpo.blockedAttempts).toHaveLength(1);
			expect(corpo.blockedAttempts[0]?.guard).toBe("AR-001");
			await app.close();
		});
	});

	it("conversa inexistente → 404", async () => {
		await emTransacaoRevertida(async (tx) => {
			const app = buildServer({ core: montarCore(tx) });
			const r = await app.inject({
				method: "GET",
				url: `/api/conversations/${randomUUID()}/audit`,
				headers: { ...HOST_OK, ...AUTORIZADO },
			});
			expect(r.statusCode).toBe(404);
			expect(r.json()).toMatchObject({ erro: "conversa nao encontrada" });
			await app.close();
		});
	});
});
