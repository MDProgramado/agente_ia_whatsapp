/**
 * Pós-gate de conteúdo (L4, CONV-07) — barreira DETERMINÍSTICA sobre o texto
 * que a IA gerou, aplicada antes de qualquer persistência.
 *
 * ## Por que isto existe, se o gate já cobre o conteúdo
 *
 * `evaluatePolicy` já roda os guards de conteúdo (AR-001/AR-002/AR-003/AR-004)
 * sobre o texto gerado. Este módulo NÃO os substitui — ele é a camada L4 da
 * defesa em profundidade da §LLM Integration: uma checagem de texto pura, sem
 * banco, sem snapshot, sem estado, que pode ser provada com o corpus adversário
 * num teste de unidade. É a barreira que continua de pé mesmo se alguém
 * reordenar os guards ou curto-circuitar o gate.
 *
 * ## O que ele NÃO é
 *
 * Não é um substituto do prompt (L1 quality only) nem uma detecção de intenção.
 * Ele olha SÓ o texto de saída: valor monetário, percentual/desconto/promo,
 * documento comercial, promessa de agenda e mídia. Uma pergunta de preço do lead
 * (`pedido_preco`) é handoff — caminho diferente, `evaluatePolicy`.
 *
 * ## Reuso, não duplicação
 *
 * Os regex vêm dos mesmos módulos que os guards consomem
 * (`patterns/automation-disclosure.ts`, `patterns/proposal.ts`). Duas listas de
 * termos divergiriam no primeiro ajuste e a barreira de defesa em profundidade
 * passaria a barrar menos que o gate — o pior dos dois mundos. Só o que o
 * pós-gate precisa e os padrões de guard não têm mora aqui: `anexo` (mídia
 * anunciada por palavra, AR-004) e as conjugações de marcar/agendar (AR-003).
 */

import {
	CURRENCY_TERM,
	DISCOUNT_TERM,
	MEDIA_LINK_EXT,
	MEDIA_TERM,
	PERCENT_TERM,
	PRICE_TERM,
	SCHEDULE_TERM,
} from "../gate/patterns/automation-disclosure.js";
import { ORCAMENTO_TERM, PROPOSAL_TERM } from "../gate/patterns/proposal.js";
import type { GateReason } from "../gate/types.js";

/**
 * O veredito é um discriminante honesto: `allowed:true` NÃO carrega motivo.
 * Assim o chamador não pode "esquecer" de checar o motivo num texto liberado.
 */
export type PostGateVeredito =
	| { readonly allowed: true }
	| {
			readonly allowed: false;
			readonly reason: GateReason;
			readonly detail: string;
	  };

/**
 * Marcador do detalhe. O relatório de shadow (Task 3) e a auditoria separam um
 * bloqueio L4 dos demais pelo prefixo — e o teste de integração usa o mesmo
 * marcador para provar que o encadeamento existe.
 */
export const PREFIXO_DETALHE_POS_GATE = "pós-gate";

/**
 * AR-004: mídia anunciada por PALAVRA que `MEDIA_TERM` não cobre.
 *
 * "segue o anexo" é o caso real — o modelo oferece um arquivo sem dizer "PDF"
 * nem "imagem". `anexo`/`anexado`/`anexar` fecham essa lacuna. Fronteira de
 * palavra em todo termo, como nos padrões vizinhos (não casar "anexação
 * tributária" fora de contexto de arquivo... e ainda assim errar aqui é
 * fail-closed: melhor silenciar que vazar mídia).
 */
const ANEXO_TERM = /\banex(?:o|os|ad[oa]s?|ar)\b/i;

/** Algum dos regex da lista casa o texto? (Reusado para as listas `readonly RegExp[]`.) */
const algumCasa = (texto: string, termos: readonly RegExp[]): boolean =>
	termos.some((t) => t.test(texto));

/**
 * Classifica o texto gerado. A ORDEM é a precedência e espelha a do gate
 * canônico quando os motivos se sobrepõem: valor antes de proposta antes de
 * agenda antes de mídia. Assim uma frase que casa mais de um termo reporta o
 * mesmo motivo que o gate reportaria — o relatório não vê um bloqueio L4 e um
 * bloqueio canônico discordando sobre o mesmo texto.
 */
export const scanPostGate = (texto: string): PostGateVeredito => {
	// AR-001 — valor, percentual, desconto, promoção.
	if (
		CURRENCY_TERM.test(texto) ||
		PERCENT_TERM.test(texto) ||
		DISCOUNT_TERM.test(texto) ||
		PRICE_TERM.test(texto)
	) {
		return {
			allowed: false,
			reason: "ar001_preco",
			detail: `${PREFIXO_DETALHE_POS_GATE}: valor, percentual ou desconto no texto gerado (AR-001)`,
		};
	}

	// AR-002 — documento comercial (proposta, contrato, orçamento).
	if (algumCasa(texto, PROPOSAL_TERM) || algumCasa(texto, ORCAMENTO_TERM)) {
		return {
			allowed: false,
			reason: "ar002_proposta",
			detail: `${PREFIXO_DETALHE_POS_GATE}: proposta ou documento comercial no texto gerado (AR-002)`,
		};
	}

	// AR-003 — promessa de agendamento sem o Admin.
	if (SCHEDULE_TERM.test(texto)) {
		return {
			allowed: false,
			reason: "ar003_agendamento",
			detail: `${PREFIXO_DETALHE_POS_GATE}: promessa de agendamento no texto gerado (AR-003)`,
		};
	}

	// AR-004 — mídia no outbound (palavra, anexo ou extensão de link).
	if (
		MEDIA_TERM.test(texto) ||
		ANEXO_TERM.test(texto) ||
		MEDIA_LINK_EXT.test(texto)
	) {
		return {
			allowed: false,
			reason: "ar004_midia_saida",
			detail: `${PREFIXO_DETALHE_POS_GATE}: mídia no texto gerado (AR-004)`,
		};
	}

	return { allowed: true };
};
