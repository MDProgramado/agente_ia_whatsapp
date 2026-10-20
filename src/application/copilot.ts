/**
 * Modo copiloto (FLUP-06/R-014, D-24) e nota automática da IA (CRM-03/D-22/R-043).
 *
 * Dois produtos, uma regra invariante: este módulo NUNCA envia mensagem nenhuma.
 * A sugestão nasce em `messages` com `origin='ai_suggestion'`/`status='suggested'`
 * (D-03/D-04) e só sai pelo caminho de despacho do painel (03-03), por ação
 * explícita do Admin e com `origin='admin'`. A nota nasce em `lead_notes` com
 * `author_type='ia'` e não sai do painel.
 *
 * ## O gate roda IGUAL ao shadow
 *
 * A sugestão reaproveita o `persistDraft` de 02-02: um texto que violaria um
 * anti-requisito vira linha em `blocked_attempts` (a mesma trilha auditável de um
 * envio real, R-022), nunca um rascunho entregue. A nota é texto INTERNO — não
 * passa pelo gate de envio, mas passa pelo choke-point de egresso textual (abaixo).
 *
 * ## Nenhum prompt é montado aqui (D-16/Pitfall 4)
 *
 * `src/domain/llm/prompt-builder.ts` é o único ponto que monta texto para o
 * modelo — este módulo só CHAMA a porta da LLM com o prompt que aquele módulo
 * devolveu, já mascarado. A persona vive no prompt; este arquivo não descreve
 * personalidade, papel de consultor nem estilo em texto algum.
 *
 * ## Falha é silêncio + evento (D-10)
 *
 * `ok:false`, canário divergente, texto vazio ou nota sem as três seções →
 * `event_log` e nada mais: sem rascunho, sem nota inventada, sem notificação
 * fantasma. `llm_runs` registra a corrida (modelo/tokens/latência — nunca o
 * corpo) apenas no caminho validado, como em shadow.
 */
import type {
	ExtractionEnvelope,
	GenerationEnvelope,
} from "../domain/llm/envelope.js";
import { canarioEsperado, validaEcoCanario } from "../domain/llm/envelope.js";
import {
	buildGeneratePrompt,
	buildNotePrompt,
	NOTA_PROMPT_VERSION,
} from "../domain/llm/prompt-builder.js";
import type { LlmPort } from "../domain/ports/LlmPort.js";
import type { Db } from "../infra/db/client.js";
import {
	type AutorNota,
	criarNota,
	registrarEvento,
} from "../infra/db/queries/crm.js";
import { loadLlmContext } from "../infra/db/queries/llm-context.js";
import { recordLlmRun } from "../infra/db/queries/llm-runs.js";
import { POLICY_VERSION, PROMPT_VERSION } from "./inbound-handler.js";
import { type LlmRunMeta, persistDraft } from "./shadow.js";

export interface CopilotDeps {
	readonly db: Db;
	readonly llm: LlmPort<ExtractionEnvelope, GenerationEnvelope>;
	/** Instante do fato. Injetado — este módulo não chama `Date.now()`. */
	readonly agora?: () => Date;
}

/** Motivos de não-produção (fail-closed, D-10). */
export type MotivoCopilot =
	| "conversa_nao_encontrada"
	| "llm_falhou"
	| "canario_divergente"
	| "texto_vazio"
	| "gate_bloqueou"
	| "nota_invalida"
	| "persistencia_falhou";

export type SugestaoResultado =
	| {
			readonly ok: true;
			readonly messageId: string;
			readonly texto: string;
	  }
	| {
			readonly ok: false;
			readonly motivo: MotivoCopilot;
			readonly detail: string;
			/** Preenchido quando `motivo='gate_bloqueou'` (regra violada). */
			readonly blockedReason?: string;
	  };

export type NotaIaResultado =
	| { readonly ok: true; readonly notaId: string }
	| {
			readonly ok: false;
			readonly motivo: MotivoCopilot;
			readonly detail: string;
	  };

/** As três seções que a nota precisa ter (CRM-03/D-22) — validadas no código. */
const SECOES_NOTA: readonly {
	readonly rotulo: string;
	readonly padrao: RegExp;
}[] = [
	{ rotulo: "resumo", padrao: /\bresumo\b/i },
	{ rotulo: "objeções", padrao: /\bobje[çc][õo]es\b/i },
	{ rotulo: "próximos passos", padrao: /\bpr[óo]ximos passos\b/i },
];

/** Texto de nota válido = tem as três seções, cada uma com conteúdo. */
const notaCompleta = (texto: string): boolean => {
	const linhas = texto.split(/\r?\n/);
	return SECOES_NOTA.every(({ padrao }) => {
		const indice = linhas.findIndex((l) => padrao.test(l));
		if (indice === -1) return false;
		// Conteúdo da seção = o resto da própria linha (após o título) ou a
		// próxima linha não vazia que não seja outro título.
		const restoDaLinha = linhas[indice]
			?.replace(padrao, "")
			.replace(/[\s:—–-]+/g, "");
		if (restoDaLinha) return true;
		const proxima = linhas
			.slice(indice + 1)
			.find(
				(l) => l.trim() !== "" && !SECOES_NOTA.some((s) => s.padrao.test(l)),
			);
		return proxima !== undefined;
	});
};

/**
 * Gera uma sugestão de resposta no modo copiloto e a persiste como rascunho.
 *
 * A sugestão NUNCA é enviada: `persistDraft` grava `origin='ai_suggestion'`/
 * `status='suggested'` e o Admin decide no painel. A chave de idempotência é
 * ancorada no instante: gerar de novo no mesmo instante não duplica (o gesto
 * repetido do Admin é a mesma operação), e uma nova geração depois é um rascunho
 * novo — histórico íntegro, `messages` append-only (R-043).
 */
export const gerarSugestao = async (
	conversationId: string,
	deps: CopilotDeps,
): Promise<SugestaoResultado> => {
	const agora = deps.agora?.() ?? new Date();
	const contexto = await loadLlmContext(deps.db, conversationId);
	if (!contexto) {
		return {
			ok: false,
			motivo: "conversa_nao_encontrada",
			detail: `conversa ${conversationId} nao encontrada para sugestao`,
		};
	}

	const canario = canarioEsperado(
		`copilot:${conversationId}:${agora.getTime()}`,
	);
	const geracao = await deps.llm.generate({
		prompt: buildGeneratePrompt(contexto.payload, contexto.state, canario),
		canary: canario,
		resolvedState: contexto.state,
	});

	if (!geracao.ok) {
		await registrarEvento(deps.db, {
			eventType: "copilot_sugestao_falhou",
			entityType: "conversation",
			entityId: conversationId,
			leadId: contexto.leadId,
			conversationId,
			payload: { motivo: "llm_falhou", kind: geracao.error.kind },
			severity: "warn",
		});
		return {
			ok: false,
			motivo: "llm_falhou",
			detail: `${geracao.error.kind}: ${geracao.error.detail}`,
		};
	}

	const eco = validaEcoCanario(canario, geracao.output.canary);
	if (!eco.ok) {
		await registrarEvento(deps.db, {
			eventType: "copilot_sugestao_falhou",
			entityType: "conversation",
			entityId: conversationId,
			leadId: contexto.leadId,
			conversationId,
			payload: { motivo: "canario_divergente" },
			severity: "warn",
		});
		return {
			ok: false,
			motivo: "canario_divergente",
			detail: `canario esperado ${eco.esperado}, recebido ${eco.recebido}`,
		};
	}

	const texto = geracao.output.replyText.trim();
	if (!texto) {
		await registrarEvento(deps.db, {
			eventType: "copilot_sugestao_falhou",
			entityType: "conversation",
			entityId: conversationId,
			leadId: contexto.leadId,
			conversationId,
			payload: { motivo: "texto_vazio" },
			severity: "warn",
		});
		return { ok: false, motivo: "texto_vazio", detail: "replyText vazio" };
	}

	const meta: LlmRunMeta = {
		model: geracao.usage.model,
		promptTokens: geracao.usage.promptTokens,
		completionTokens: geracao.usage.completionTokens,
		latencyMs: geracao.usage.latencyMs,
		costUsd: geracao.costUsd,
		promptVersion: PROMPT_VERSION,
		policyVersion: POLICY_VERSION,
		zodParseOk: true,
		canaryOk: true,
	};

	const rascunho = await persistDraft(deps.db, {
		conversationId,
		generatedText: texto,
		idempotencyKey: `copilot:${conversationId}:${agora.getTime()}`,
		llmRun: meta,
		agora,
		leadId: contexto.leadId,
	});

	if (!rascunho.persisted) {
		// O gate bloqueou: o negativo já está em `blocked_attempts` (R-022) —
		// nada de rascunho, nada de envio. O motivo volta ao painel.
		return {
			ok: false,
			motivo: "gate_bloqueou",
			detail: rascunho.detail,
			blockedReason: rascunho.blockedReason,
		};
	}

	await registrarEvento(deps.db, {
		eventType: "copilot_sugestao_gerada",
		entityType: "conversation",
		entityId: conversationId,
		leadId: contexto.leadId,
		conversationId,
		payload: { messageId: rascunho.messageId, chars: texto.length },
	});

	return { ok: true, messageId: rascunho.messageId, texto };
};

/**
 * Gera a nota automática da conversa (CRM-03) e a persiste em `lead_notes`
 * com `author_type='ia'` (D-22).
 *
 * Só grava com as TRÊS seções preenchidas: uma nota pela metade é pior que
 * nota nenhuma (o consultor confiaria em "Objeções" que não existe). Falha
 * vira evento + `llm_runs` NÃO registra — não houve corrida válida para
 * auditar como nota.
 */
export const gerarNotaAutomatica = async (
	conversationId: string,
	deps: CopilotDeps,
): Promise<NotaIaResultado> => {
	const agora = deps.agora?.() ?? new Date();
	const contexto = await loadLlmContext(deps.db, conversationId);
	if (!contexto) {
		return {
			ok: false,
			motivo: "conversa_nao_encontrada",
			detail: `conversa ${conversationId} nao encontrada para nota`,
		};
	}

	const canario = canarioEsperado(`nota:${conversationId}:${agora.getTime()}`);
	const geracao = await deps.llm.generate({
		prompt: buildNotePrompt(contexto.payload, canario),
		canary: canario,
		resolvedState: contexto.state,
	});

	if (!geracao.ok) {
		await registrarEvento(deps.db, {
			eventType: "nota_ia_falhou",
			entityType: "lead",
			entityId: contexto.leadId,
			leadId: contexto.leadId,
			conversationId,
			payload: { motivo: "llm_falhou", kind: geracao.error.kind },
			severity: "warn",
		});
		return {
			ok: false,
			motivo: "llm_falhou",
			detail: `${geracao.error.kind}: ${geracao.error.detail}`,
		};
	}

	const eco = validaEcoCanario(canario, geracao.output.canary);
	if (!eco.ok) {
		await registrarEvento(deps.db, {
			eventType: "nota_ia_falhou",
			entityType: "lead",
			entityId: contexto.leadId,
			leadId: contexto.leadId,
			conversationId,
			payload: { motivo: "canario_divergente" },
			severity: "warn",
		});
		return {
			ok: false,
			motivo: "canario_divergente",
			detail: `canario esperado ${eco.esperado}, recebido ${eco.recebido}`,
		};
	}

	const texto = geracao.output.replyText.trim();
	if (!notaCompleta(texto)) {
		await registrarEvento(deps.db, {
			eventType: "nota_ia_invalida",
			entityType: "lead",
			entityId: contexto.leadId,
			leadId: contexto.leadId,
			conversationId,
			payload: { motivo: "nota_invalida", chars: texto.length },
			severity: "warn",
		});
		return {
			ok: false,
			motivo: "nota_invalida",
			detail: "nota sem as secoes Resumo/Objecoes/Proximos passos",
		};
	}

	// `llm_runs` referencia `message_id` — a nota não tem mensagem, então a
	// corrida é registrada sem vínculo (messageId nulo), como manda R-045.
	await recordLlmRun(deps.db, {
		messageId: null,
		model: geracao.usage.model,
		promptTokens: geracao.usage.promptTokens,
		completionTokens: geracao.usage.completionTokens,
		latencyMs: geracao.usage.latencyMs,
		costUsd: geracao.costUsd,
		promptVersion: NOTA_PROMPT_VERSION,
		policyVersion: POLICY_VERSION,
		zodParseOk: true,
		canaryOk: true,
		createdAt: agora,
	});

	const autorType: AutorNota = "ia";
	const nota = await criarNota(deps.db, {
		leadId: contexto.leadId,
		conversationId,
		body: texto,
		authorType: autorType,
	});
	if (!nota.ok) {
		return {
			ok: false,
			motivo: "persistencia_falhou",
			detail: `lead ${contexto.leadId} sumiu antes da nota (${nota.erro})`,
		};
	}
	return { ok: true, notaId: nota.nota.id };
};
