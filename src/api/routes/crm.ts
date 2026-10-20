/**
 * Rotas do CRM operacional (CRM-01/CRM-03/FLUP-06, D-14/D-15/D-22/D-25).
 *
 * Camada fina sobre `infra/db/queries/crm.ts` (que já é a fonte de verdade de
 * validação/auditoria): aqui Só se valida a borda (Zod, ASVS V5), se mapeia
 * erro de domínio para status HTTP e se serializa. Nenhuma regra de negócio
 * nova — em particular, nenhuma escrita de `pipeline_status` fora de
 * `corrigirStatus` (que trava a linha, checa opt-out e grava o histórico).
 *
 * ## `origin` nunca vem do cliente
 *
 * Como em `/api/dispatch`: a correção de status registra `changed_by='admin'`
 * fixo. Um request capturado não pode se passar por automação (nem o contrário).
 *
 * ## Copiloto (FLUP-06/R-014)
 *
 * `POST /api/crm/conversations/:id/copilot/sugestao` gera a sugestão E a nota
 * automática na mesma chamada — o cliente recebe as duas e os motivos de
 * falha de cada uma. A sugestão é um RASCUNHO (`ai_suggestion`/`suggested`);
 * o envio continua sendo exclusivamente `/api/dispatch`. Sem porta de LLM
 * injetada (testes de borda), a rota responde 503 — nunca inventa um texto.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
	gerarNotaAutomatica,
	gerarSugestao,
} from "../../application/copilot.js";
import {
	exigeJustificativa,
	isMotivo,
	PIPELINE_STATUS,
} from "../../domain/pipeline.js";
import {
	associarTag,
	atualizarTarefa,
	buscarConversas,
	corrigirStatus,
	criarNota,
	criarTag,
	criarTarefa,
	definirResponsavel,
	desassociarTag,
	listarNotas,
	listarPorStatus,
	listarTags,
	listarTarefas,
	removerTag,
	renomearTag,
} from "../../infra/db/queries/crm.js";
import type { PanelCore } from "../server.js";

// ---------------------------------------------------------------------------
// Validação da borda
// ---------------------------------------------------------------------------

const uuidParams = z.object({ id: z.uuid() });
const leadParams = z.object({ leadId: z.uuid() });
const leadTagParams = z.object({ leadId: z.uuid(), tagId: z.uuid() });

const paginacao = {
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(200).default(50),
} as const;

const buscaQuery = z.object({
	q: z.string().max(200).optional(),
	pipelineStatus: z.enum(PIPELINE_STATUS).optional(),
	tagId: z.uuid().optional(),
	...paginacao,
});

/**
 * Correção manual de status (D-14). A justificativa é exigida AQUI também
 * (RN-080) além de em `corrigirStatus`: erro de borda vira 400 com mensagem
 * clara, não um 409 de domínio depois de abrir transação.
 */
const correcaoBody = z
	.object({
		para: z.enum(PIPELINE_STATUS, {
			message: "para deve ser um status do pipeline (D-14)",
		}),
		motivo: z.string().max(500).optional(),
		manual: z.boolean().default(true),
	})
	.superRefine((val, ctx) => {
		const motivo = val.motivo?.trim() ?? "";
		if (exigeJustificativa(val.para) && !motivo) {
			ctx.addIssue({
				code: "custom",
				path: ["motivo"],
				message: `${val.para} exige justificativa (RN-080)`,
			});
		}
		if (val.para === "perdido" && motivo && !isMotivo(motivo)) {
			ctx.addIssue({
				code: "custom",
				path: ["motivo"],
				message: "motivo de PERDIDO fora do vocabulario de D-15",
			});
		}
	});

const tagBody = z.object({
	nome: z
		.string()
		.trim()
		.min(1, "nome obrigatorio")
		.max(50, "nome muito longo"),
});

const tagIdBody = z.object({ tagId: z.uuid() });

const notaBody = z.object({
	body: z
		.string()
		.trim()
		.min(1, "nota vazia: escreva o texto antes de salvar")
		.max(10000, "nota muito longa (max 10000 caracteres)"),
});

const notasQuery = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
});

const tarefaBody = z.object({
	leadId: z.uuid(),
	title: z.string().trim().min(1, "titulo obrigatorio").max(500),
	dueAt: z.coerce.date().nullable().optional(),
	responsibleUserId: z.uuid().nullable().optional(),
});

const tarefaPatchBody = z.object({
	title: z.string().trim().min(1, "titulo obrigatorio").max(500).optional(),
	status: z.enum(["pending", "done", "cancelled"]).optional(),
	dueAt: z.coerce.date().nullable().optional(),
	responsibleUserId: z.uuid().nullable().optional(),
});

const tarefasQuery = z.object({
	leadId: z.uuid().optional(),
	status: z.enum(["pending", "done", "cancelled"]).optional(),
	...paginacao,
});

const responsavelBody = z.object({ userId: z.uuid().nullable() });

/** Erro do driver com `code` (SQLSTATE) — usado só para mapear FK/unique. */
const codigoErroPg = (erro: unknown, codigo: string): boolean =>
	typeof erro === "object" &&
	erro !== null &&
	(erro as { code?: string }).code === codigo;

const detalhesDe = (erro: z.ZodError): string[] =>
	erro.issues.map((i) => i.message);

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export const registrarCrm = (app: FastifyInstance, core: PanelCore): void => {
	// --- Busca server-side (CRM-01) -----------------------------------------
	app.get("/api/crm/conversations", async (req, reply) => {
		const query = buscaQuery.safeParse(req.query);
		if (!query.success) {
			return reply
				.code(400)
				.send({ erro: "filtros invalidos", detalhes: detalhesDe(query.error) });
		}
		return await buscarConversas(core.db, {
			q: query.data.q ?? null,
			pipelineStatus: query.data.pipelineStatus ?? null,
			tagId: query.data.tagId ?? null,
			page: query.data.page,
			pageSize: query.data.pageSize,
		});
	});

	app.get("/api/crm/status/:status", async (req, reply) => {
		const params = z
			.object({ status: z.enum(PIPELINE_STATUS) })
			.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({
				erro: "status invalido (D-14)",
				detalhes: detalhesDe(params.error),
			});
		}
		const query = z.object(paginacao).safeParse(req.query);
		if (!query.success) {
			return reply.code(400).send({
				erro: "paginacao invalida",
				detalhes: detalhesDe(query.error),
			});
		}
		return await listarPorStatus(core.db, params.data.status, {
			page: query.data.page,
			pageSize: query.data.pageSize,
		});
	});

	// --- Correção de status (D-14/D-15, R-022/R-024) ------------------------
	app.post("/api/crm/conversations/:id/status", async (req, reply) => {
		const params = uuidParams.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}
		const body = correcaoBody.safeParse(req.body);
		if (!body.success) {
			return reply
				.code(400)
				.send({ erro: "correcao invalida", detalhes: detalhesDe(body.error) });
		}

		const resultado = await corrigirStatus(core.db, {
			conversationId: params.data.id,
			para: body.data.para,
			motivo: body.data.motivo ?? null,
			// Correção vinda do painel → sempre ação do Admin (changed_by fixo).
			changedBy: "admin",
			manual: body.data.manual,
		});

		if (resultado.ok) {
			return {
				ok: true,
				de: resultado.de,
				para: resultado.para,
				statusHistoryId: resultado.statusHistoryId,
			};
		}
		const status =
			resultado.erro === "conversa_nao_encontrada"
				? 404
				: resultado.erro === "opt_out_irreversivel" ||
						resultado.erro === "transicao_invalida"
					? 409
					: 400;
		return reply
			.code(status)
			.send({ erro: resultado.erro, mensagem: resultado.mensagem });
	});

	// --- Tags (D-22) ---------------------------------------------------------
	app.get("/api/crm/tags", async () => ({ itens: await listarTags(core.db) }));

	app.post("/api/crm/tags", async (req, reply) => {
		const body = tagBody.safeParse(req.body);
		if (!body.success) {
			return reply
				.code(400)
				.send({ erro: "tag invalida", detalhes: detalhesDe(body.error) });
		}
		const tag = await criarTag(core.db, { nome: body.data.nome });
		return reply.code(tag.criada ? 201 : 200).send(tag);
	});

	app.patch("/api/crm/tags/:id", async (req, reply) => {
		const params = uuidParams.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}
		const body = tagBody.safeParse(req.body);
		if (!body.success) {
			return reply
				.code(400)
				.send({ erro: "tag invalida", detalhes: detalhesDe(body.error) });
		}
		try {
			const tag = await renomearTag(core.db, params.data.id, body.data.nome);
			if (!tag) return reply.code(404).send({ erro: "tag nao encontrada" });
			return tag;
		} catch (erro) {
			if (codigoErroPg(erro, "23505")) {
				return reply.code(409).send({ erro: "ja existe tag com esse nome" });
			}
			throw erro;
		}
	});

	app.delete("/api/crm/tags/:id", async (req, reply) => {
		const params = uuidParams.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}
		const removida = await removerTag(core.db, params.data.id);
		if (!removida) return reply.code(404).send({ erro: "tag nao encontrada" });
		return { removido: true };
	});

	app.post("/api/crm/leads/:leadId/tags", async (req, reply) => {
		const params = leadParams.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ erro: "leadId invalido" });
		}
		const body = tagIdBody.safeParse(req.body);
		if (!body.success) {
			return reply
				.code(400)
				.send({ erro: "tagId invalido", detalhes: detalhesDe(body.error) });
		}
		try {
			const vinculado = await associarTag(core.db, {
				leadId: params.data.leadId,
				tagId: body.data.tagId,
			});
			return { vinculado };
		} catch (erro) {
			if (codigoErroPg(erro, "23503")) {
				return reply.code(404).send({ erro: "lead ou tag inexistente" });
			}
			throw erro;
		}
	});

	app.delete("/api/crm/leads/:leadId/tags/:tagId", async (req, reply) => {
		const params = leadTagParams.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ erro: "ids invalidos" });
		}
		const desvinculado = await desassociarTag(
			core.db,
			params.data.leadId,
			params.data.tagId,
		);
		if (!desvinculado) {
			return reply.code(404).send({ erro: "vinculo nao encontrado" });
		}
		return { desvinculado };
	});

	// --- Notas do lead (D-22) ------------------------------------------------
	app.get("/api/crm/leads/:leadId/notes", async (req, reply) => {
		const params = leadParams.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ erro: "leadId invalido" });
		}
		const query = notasQuery.safeParse(req.query);
		if (!query.success) {
			return reply.code(400).send({
				erro: "limit invalido",
				detalhes: detalhesDe(query.error),
			});
		}
		const itens = await listarNotas(
			core.db,
			params.data.leadId,
			query.data.limit,
		);
		return { itens };
	});

	app.post("/api/crm/leads/:leadId/notes", async (req, reply) => {
		const params = leadParams.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ erro: "leadId invalido" });
		}
		const body = notaBody.safeParse(req.body);
		if (!body.success) {
			return reply
				.code(400)
				.send({ erro: "nota invalida", detalhes: detalhesDe(body.error) });
		}
		const nota = await criarNota(core.db, {
			leadId: params.data.leadId,
			body: body.data.body,
			// Nota pelo painel → sempre do Admin; a da IA nasce em copilot.ts.
			authorType: "admin",
		});
		if (!nota.ok) {
			return reply.code(404).send({ erro: "lead nao encontrado" });
		}
		return reply.code(201).send({ nota: nota.nota });
	});

	// --- Tarefas e lembretes (D-22) ------------------------------------------
	app.get("/api/crm/tasks", async (req, reply) => {
		const query = tarefasQuery.safeParse(req.query);
		if (!query.success) {
			return reply
				.code(400)
				.send({ erro: "filtros invalidos", detalhes: detalhesDe(query.error) });
		}
		return await listarTarefas(core.db, {
			leadId: query.data.leadId ?? null,
			status: query.data.status ?? null,
			page: query.data.page,
			pageSize: query.data.pageSize,
		});
	});

	app.post("/api/crm/tasks", async (req, reply) => {
		const body = tarefaBody.safeParse(req.body);
		if (!body.success) {
			return reply
				.code(400)
				.send({ erro: "tarefa invalida", detalhes: detalhesDe(body.error) });
		}
		try {
			const tarefa = await criarTarefa(core.db, {
				leadId: body.data.leadId,
				title: body.data.title,
				dueAt: body.data.dueAt ?? null,
				responsibleUserId: body.data.responsibleUserId ?? null,
			});
			if (!tarefa.ok) {
				return tarefa.erro === "responsavel_invalido"
					? reply
							.code(400)
							.send({ erro: "responsavel precisa ser usuario ativo" })
					: reply.code(404).send({ erro: "lead nao encontrado" });
			}
			return reply.code(201).send({ tarefa: tarefa.tarefa });
		} catch (erro) {
			if (codigoErroPg(erro, "23503")) {
				return reply.code(404).send({ erro: "lead ou usuario inexistente" });
			}
			throw erro;
		}
	});

	app.patch("/api/crm/tasks/:id", async (req, reply) => {
		const params = uuidParams.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}
		const body = tarefaPatchBody.safeParse(req.body);
		if (!body.success) {
			return reply
				.code(400)
				.send({ erro: "patch invalido", detalhes: detalhesDe(body.error) });
		}
		try {
			const tarefa = await atualizarTarefa(core.db, params.data.id, {
				title: body.data.title,
				status: body.data.status,
				dueAt: body.data.dueAt,
				responsibleUserId: body.data.responsibleUserId,
			});
			if (tarefa === null) {
				return reply.code(404).send({ erro: "tarefa nao encontrada" });
			}
			if (tarefa === "responsavel_invalido") {
				return reply
					.code(400)
					.send({ erro: "responsavel precisa ser usuario ativo" });
			}
			return { tarefa };
		} catch (erro) {
			if (codigoErroPg(erro, "23503")) {
				return reply.code(404).send({ erro: "usuario inexistente" });
			}
			throw erro;
		}
	});

	// --- Responsável pela conversa (R-028) -----------------------------------
	app.put("/api/crm/conversations/:id/responsavel", async (req, reply) => {
		const params = uuidParams.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}
		const body = responsavelBody.safeParse(req.body);
		if (!body.success) {
			return reply.code(400).send({
				erro: "responsavel invalido",
				detalhes: detalhesDe(body.error),
			});
		}
		const resultado = await definirResponsavel(core.db, {
			conversationId: params.data.id,
			userId: body.data.userId,
		});
		if (!resultado.ok) {
			return resultado.erro === "conversa_nao_encontrada"
				? reply
						.code(404)
						.send({ erro: resultado.erro, mensagem: resultado.mensagem })
				: reply
						.code(400)
						.send({ erro: resultado.erro, mensagem: resultado.mensagem });
		}
		return { ok: true, userId: body.data.userId };
	});

	// --- Copiloto: sugestão + nota automática (FLUP-06/CRM-03) ---------------
	app.post(
		"/api/crm/conversations/:id/copilot/sugestao",
		async (req, reply) => {
			const params = uuidParams.safeParse(req.params);
			if (!params.success) {
				return reply.code(400).send({ erro: "id invalido" });
			}
			const llm = core.llm;
			if (!llm) {
				return reply
					.code(503)
					.send({ erro: "copiloto indisponivel: porta de LLM nao injetada" });
			}

			const deps = { db: core.db, llm, agora: core.agora };
			const sugestao = await gerarSugestao(params.data.id, deps);
			const nota = await gerarNotaAutomatica(params.data.id, deps);

			const falhas: {
				operacao: "sugestao" | "nota";
				motivo: string;
				detail: string;
				blockedReason?: string;
			}[] = [];
			if (!sugestao.ok) {
				falhas.push({
					operacao: "sugestao",
					motivo: sugestao.motivo,
					detail: sugestao.detail,
					...(sugestao.blockedReason !== undefined
						? { blockedReason: sugestao.blockedReason }
						: {}),
				});
			}
			if (!nota.ok) {
				falhas.push({
					operacao: "nota",
					motivo: nota.motivo,
					detail: nota.detail,
				});
			}

			// Conversa inexistente: as duas operações falham pelo mesmo motivo.
			if (
				!sugestao.ok &&
				!nota.ok &&
				sugestao.motivo === "conversa_nao_encontrada" &&
				nota.motivo === "conversa_nao_encontrada"
			) {
				return reply.code(404).send({ erro: "conversa nao encontrada" });
			}

			return {
				sugestao: sugestao.ok
					? { messageId: sugestao.messageId, texto: sugestao.texto }
					: null,
				nota: nota.ok ? { notaId: nota.notaId } : null,
				falhas,
			};
		},
	);
};
