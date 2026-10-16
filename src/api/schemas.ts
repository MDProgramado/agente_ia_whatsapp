/**
 * Schemas Zod das rotas do painel (ASVS V5 — validação na borda).
 *
 * Um único lugar com o vocabulário de validação da API, no mesmo estilo do
 * `envSchema`/LLM: mensagens em pt-BR apontando a correção. Todo corpo de request
 * passa por aqui ANTES de tocar domínio/banco — um id malformado vira 400 com
 * mensagem clara, nunca um erro de driver no meio de uma transação.
 *
 * Os schemas de E.164/telefone casam com o CHECK do banco e o `envSchema`
 * (`^\+[1-9][0-9]{7,14}$`) — mesma forma, uma única regra de formato.
 */

import { z } from "zod";

/** Ids opacos vindos da rota (`:id`). Não são expostos como inteiros sequenciais. */
const idDeRota = z.string().min(1, "id obrigatorio na rota");

/**
 * `GET /api/leads` — lista paginada com busca/filtro básicos (D-22).
 * `pageSize` limitado: é o próprio anti-DoS da listagem (T-03-18).
 */
export const listarLeadsQuery = z.object({
	q: z.string().max(200, "busca muito longa (max 200 caracteres)").optional(),
	status: z.string().max(50).optional(),
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListarLeadsQuery = z.infer<typeof listarLeadsQuery>;

export const idParams = z.object({ id: idDeRota });

/**
 * `POST /api/dispatch` — o ÚNICO caminho de envio do painel (NFRQ-05).
 * `origin` NUNCA vem do cliente: a rota fixa `origin='admin'`. Aqui só
 * validamos o texto e o destino; o gate decide sent/blocked/deferred.
 */
export const dispatchBody = z.object({
	conversationId: idDeRota,
	text: z
		.string()
		.min(1, "mensagem vazia: digite um texto antes de enviar")
		.max(4000, "mensagem muito longa (max 4000 caracteres)"),
});
export type DispatchBody = z.infer<typeof dispatchBody>;

/**
 * `POST /api/conversations/:id/actions` — ações rápidas auditadas.
 * Cada valor vira um branch explícito na rota; schema impede string livre.
 */
export const acaoConversaBody = z.object({
	action: z.enum(["pausar", "assumir", "devolver", "copiloto"], {
		message: "action deve ser: pausar | assumir | devolver | copiloto",
	}),
});
export type AcaoConversaBody = z.infer<typeof acaoConversaBody>;

/**
 * `POST /api/system/kill-switch` — exige `confirm: true` explícito (type-to-confirm
 * no cliente, D-20). Um kill switch acionável por um clique acidental de um
 * request capturado seria ruim; o `confirm` força intenção deliberada.
 */
export const killSwitchBody = z.object({
	confirm: z.literal(true, {
		message: "kill switch exige confirm: true (intencao deliberada)",
	}),
});
export type KillSwitchBody = z.infer<typeof killSwitchBody>;
