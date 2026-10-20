/**
 * Rotas do CRM (03-05 Task 2, CRM-01/CRM-03/FLUP-06, D-14/D-15/D-22/D-25).
 *
 * Prova sobre Fastify REAL (`buildServer` + `inject`, sem socket):
 *   1. busca server-side (`/api/crm/conversations`) filtra por pipeline/tag e
 *      pagina; status fora de D-14 → 400 na borda;
 *   2. correção manual de status grava `pipeline_status` + `status_history` +
 *      `event_log`; status crítico sem motivo → 400 (Zod); opt-out → 409;
 *   3. tags (CRUD + vínculo com lead), notas (authorType admin), tarefas e
 *      responsável — todos os caminhos de escrita de D-22;
 *   4. copiloto: sem porta de LLM → 503; com LLM roteirizada → 200, rascunho
 *      `ai_suggestion` + nota `author_type='ia'` no banco; conversa inexistente
 *      → 404.
 *
 * Mesma transação revertida por sentinela de `routes.test.ts`.
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
import {
	type RoteiroScripted,
	scriptedLlmAdapter,
} from "../../src/infra/llm/scripted-adapter.js";
import { instanteEmZona, TZ } from "../gate/fixtures.js";

/** Terça 29/09/2026 13h SP → dentro da janela. */
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

const montarCore = (tx: Db, llm?: RoteiroScripted): PanelCore => {
	const channel = criarFakeChannel();
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
	return llm === undefined ? core : { ...core, llm: scriptedLlmAdapter(llm) };
};

const HDR = { ...HOST_OK, ...AUTORIZADO };

const inserirConta = async (db: Db): Promise<string> => {
	await db.execute(sql`
		INSERT INTO channel_accounts (phone_e164, display_name)
		VALUES (${env.CHANNEL_PHONE_E164}, 'teste-crm')
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
	optOut = false,
): Promise<string> => {
	const r = await db.execute(sql`
		INSERT INTO leads (
			phone_number, origin_source, legal_basis, purpose,
			legal_registered_at, first_contact_by_human, wa_validation_state, opt_out
		)
		VALUES (
			${telefone}, 'teste', 'legitimo_interesse', 'prospeccao',
			'2025-01-01T12:00:00Z', true, 'VALIDO', ${optOut}
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

interface Cenario {
	readonly app: ReturnType<typeof buildServer>;
	readonly contaId: string;
	readonly leadId: string;
	readonly conversationId: string;
}

const cenario = async (
	tx: Db,
	opts: { readonly optOut?: boolean; readonly llm?: RoteiroScripted } = {},
): Promise<Cenario> => {
	const contaId = await inserirConta(tx);
	const leadId = await inserirLead(
		tx,
		`+55${Date.now() % 10_000_000_000}${Math.floor(Math.random() * 100)}`,
		opts.optOut ?? false,
	);
	const conversationId = await inserirConversa(tx, leadId, contaId);
	return {
		app: buildServer({ core: montarCore(tx, opts.llm) }),
		contaId,
		leadId,
		conversationId,
	};
};

describe("busca CRM (CRM-01)", () => {
	it("GET /api/crm/conversations?pipelineStatus=... devolve a conversa com tags", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app, conversationId } = await cenario(tx);
			await tx.execute(sql`
				update conversations set pipeline_status = 'qualificado'
				where id = ${conversationId}
			`);

			const r = await app.inject({
				method: "GET",
				url: "/api/crm/conversations?pipelineStatus=qualificado",
				headers: HDR,
			});
			expect(r.statusCode).toBe(200);
			const corpo = r.json() as {
				itens: {
					conversationId: string;
					pipelineStatus: string;
					tags: unknown[];
				}[];
			};
			const item = corpo.itens.find((i) => i.conversationId === conversationId);
			expect(item).toBeDefined();
			expect(item?.pipelineStatus).toBe("qualificado");
			expect(Array.isArray(item?.tags)).toBe(true);
			await app.close();
		});
	});

	it("status fora de D-14 → 400 na borda", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app } = await cenario(tx);
			const r = await app.inject({
				method: "GET",
				url: "/api/crm/conversations?pipelineStatus=nao_existe",
				headers: HDR,
			});
			expect(r.statusCode).toBe(400);
			await app.close();
		});
	});
});

describe("correção de status (D-14/D-15)", () => {
	it("novo → qualificado: 200, grava conversations + status_history + event_log", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app, conversationId } = await cenario(tx);
			const r = await app.inject({
				method: "POST",
				url: `/api/crm/conversations/${conversationId}/status`,
				headers: HDR,
				payload: { para: "qualificado" },
			});
			expect(r.statusCode).toBe(200);
			expect(r.json()).toMatchObject({
				ok: true,
				de: "novo",
				para: "qualificado",
			});

			const conv = primeiro(
				rows<{ pipeline_status: string }>(
					await tx.execute(sql`
						select pipeline_status from conversations where id = ${conversationId}
					`),
				),
			);
			expect(conv.pipeline_status).toBe("qualificado");

			const hist = primeiro(
				rows<{ n: number }>(
					await tx.execute(sql`
						select count(*)::int as n from status_history
						where conversation_id = ${conversationId}
							and from_state = 'novo' and to_state = 'qualificado'
					`),
				),
			);
			expect(hist.n).toBe(1);
			await app.close();
		});
	});

	it("status crítico sem motivo → 400 (Zod, RN-080)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app, conversationId } = await cenario(tx);
			const r = await app.inject({
				method: "POST",
				url: `/api/crm/conversations/${conversationId}/status`,
				headers: HDR,
				payload: { para: "proposta" },
			});
			expect(r.statusCode).toBe(400);
			await app.close();
		});
	});

	it("perdido com motivo válido grava closed_reason; motivo fora de D-15 → 400", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app, conversationId } = await cenario(tx);

			const invalido = await app.inject({
				method: "POST",
				url: `/api/crm/conversations/${conversationId}/status`,
				headers: HDR,
				payload: { para: "perdido", motivo: "porque sim" },
			});
			expect(invalido.statusCode).toBe(400);

			const r = await app.inject({
				method: "POST",
				url: `/api/crm/conversations/${conversationId}/status`,
				headers: HDR,
				payload: { para: "perdido", motivo: "sem_interesse" },
			});
			expect(r.statusCode).toBe(200);

			const conv = primeiro(
				rows<{ pipeline_status: string; closed_reason: string | null }>(
					await tx.execute(sql`
						select pipeline_status, closed_reason from conversations
						where id = ${conversationId}
					`),
				),
			);
			expect(conv.pipeline_status).toBe("perdido");
			expect(conv.closed_reason).toBe("sem_interesse");
			await app.close();
		});
	});

	it("lead em opt-out → 409 opt_out_irreversivel (R-024)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app, conversationId } = await cenario(tx, { optOut: true });
			const r = await app.inject({
				method: "POST",
				url: `/api/crm/conversations/${conversationId}/status`,
				headers: HDR,
				payload: { para: "qualificado" },
			});
			expect(r.statusCode).toBe(409);
			expect(r.json()).toMatchObject({ erro: "opt_out_irreversivel" });
			await app.close();
		});
	});
});

describe("tags (D-22)", () => {
	it("cria (201/200 idempotente), lista, renomeia, vincula ao lead e remove", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app, leadId } = await cenario(tx);
			const nome = `tag-${randomUUID().slice(0, 8)}`;

			const criada = await app.inject({
				method: "POST",
				url: "/api/crm/tags",
				headers: HDR,
				payload: { nome },
			});
			expect(criada.statusCode).toBe(201);
			const tag = criada.json() as { id: string; criada: boolean };
			expect(tag.criada).toBe(true);

			const repetida = await app.inject({
				method: "POST",
				url: "/api/crm/tags",
				headers: HDR,
				payload: { nome },
			});
			expect(repetida.statusCode).toBe(200);

			const lista = await app.inject({
				method: "GET",
				url: "/api/crm/tags",
				headers: HDR,
			});
			expect(lista.statusCode).toBe(200);
			const itens = (lista.json() as { itens: { id: string }[] }).itens;
			expect(itens.some((t) => t.id === tag.id)).toBe(true);

			const renomeada = await app.inject({
				method: "PATCH",
				url: `/api/crm/tags/${tag.id}`,
				headers: HDR,
				payload: { nome: `${nome}-v2` },
			});
			expect(renomeada.statusCode).toBe(200);

			const vinculo = await app.inject({
				method: "POST",
				url: `/api/crm/leads/${leadId}/tags`,
				headers: HDR,
				payload: { tagId: tag.id },
			});
			expect(vinculo.statusCode).toBe(200);
			expect(vinculo.json()).toMatchObject({ vinculado: true });

			const desvinculo = await app.inject({
				method: "DELETE",
				url: `/api/crm/leads/${leadId}/tags/${tag.id}`,
				headers: HDR,
			});
			expect(desvinculo.statusCode).toBe(200);

			const removida = await app.inject({
				method: "DELETE",
				url: `/api/crm/tags/${tag.id}`,
				headers: HDR,
			});
			expect(removida.statusCode).toBe(200);
			await app.close();
		});
	});
});

describe("notas, tarefas e responsável (D-22/R-028)", () => {
	it("POST/GET de notas: authorType admin e corpo persistido", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app, leadId } = await cenario(tx);
			const criada = await app.inject({
				method: "POST",
				url: `/api/crm/leads/${leadId}/notes`,
				headers: HDR,
				payload: { body: "Ligou de novo, quer proposta." },
			});
			expect(criada.statusCode).toBe(201);
			const { nota } = criada.json() as {
				nota: { id: string; authorType: string };
			};
			expect(nota.authorType).toBe("admin");

			const lista = await app.inject({
				method: "GET",
				url: `/api/crm/leads/${leadId}/notes`,
				headers: HDR,
			});
			expect(lista.statusCode).toBe(200);
			const itens = (lista.json() as { itens: { id: string }[] }).itens;
			expect(itens.some((n) => n.id === nota.id)).toBe(true);
			await app.close();
		});
	});

	it("POST/PATCH/GET de tarefas", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app, leadId } = await cenario(tx);
			const criada = await app.inject({
				method: "POST",
				url: "/api/crm/tasks",
				headers: HDR,
				payload: {
					leadId,
					title: "Enviar exemplo de site",
					dueAt: "2026-10-05T12:00:00.000Z",
				},
			});
			expect(criada.statusCode).toBe(201);
			const { tarefa } = criada.json() as {
				tarefa: { id: string; status: string };
			};
			expect(tarefa.status).toBe("pending");

			const patch = await app.inject({
				method: "PATCH",
				url: `/api/crm/tasks/${tarefa.id}`,
				headers: HDR,
				payload: { status: "done" },
			});
			expect(patch.statusCode).toBe(200);
			expect(patch.json()).toMatchObject({ tarefa: { status: "done" } });

			const lista = await app.inject({
				method: "GET",
				url: `/api/crm/tasks?leadId=${leadId}`,
				headers: HDR,
			});
			expect(lista.statusCode).toBe(200);
			expect((lista.json() as { total: number }).total).toBeGreaterThanOrEqual(
				1,
			);
			await app.close();
		});
	});

	it("PUT responsável: define e limpa (null); conversa inexistente → 404", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app, conversationId } = await cenario(tx);
			const definido = await app.inject({
				method: "PUT",
				url: `/api/crm/conversations/${conversationId}/responsavel`,
				headers: HDR,
				payload: { userId: null },
			});
			expect(definido.statusCode).toBe(200);

			const inexistente = await app.inject({
				method: "PUT",
				url: `/api/crm/conversations/${randomUUID()}/responsavel`,
				headers: HDR,
				payload: { userId: null },
			});
			expect(inexistente.statusCode).toBe(404);
			await app.close();
		});
	});
});

describe("copiloto (FLUP-06/CRM-03)", () => {
	it("sem porta de LLM → 503 (nunca inventa texto)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app, conversationId } = await cenario(tx);
			const r = await app.inject({
				method: "POST",
				url: `/api/crm/conversations/${conversationId}/copilot/sugestao`,
				headers: HDR,
			});
			expect(r.statusCode).toBe(503);
			await app.close();
		});
	});

	it("com LLM: 200, rascunho ai_suggestion + nota author_type='ia' no banco", async () => {
		await emTransacaoRevertida(async (tx) => {
			const texto =
				"Resumo\nLead quer presença digital.\nObjeções\nNenhuma por enquanto.\nPróximos passos\nMandar um exemplo amanhã.";
			const { app, conversationId, leadId } = await cenario(tx, {
				llm: { geracao: { replyText: texto } },
			});

			const r = await app.inject({
				method: "POST",
				url: `/api/crm/conversations/${conversationId}/copilot/sugestao`,
				headers: HDR,
			});
			expect(r.statusCode).toBe(200);
			const corpo = r.json() as {
				sugestao: { messageId: string } | null;
				nota: { notaId: string } | null;
				falhas: unknown[];
			};
			expect(corpo.sugestao).not.toBeNull();
			expect(corpo.nota).not.toBeNull();

			const drafts = primeiro(
				rows<{ n: number }>(
					await tx.execute(sql`
						select count(*)::int as n from messages
						where conversation_id = ${conversationId}
							and origin = 'ai_suggestion' and status = 'suggested'
					`),
				),
			);
			expect(drafts.n).toBe(1);

			const notas = primeiro(
				rows<{ n: number }>(
					await tx.execute(sql`
						select count(*)::int as n from lead_notes
						where lead_id = ${leadId} and author_type = 'ia'
					`),
				),
			);
			expect(notas.n).toBe(1);
			await app.close();
		});
	});

	it("conversa inexistente → 404", async () => {
		await emTransacaoRevertida(async (tx) => {
			const { app } = await cenario(tx, { llm: {} });
			const r = await app.inject({
				method: "POST",
				url: `/api/crm/conversations/${randomUUID()}/copilot/sugestao`,
				headers: HDR,
			});
			expect(r.statusCode).toBe(404);
			await app.close();
		});
	});
});
