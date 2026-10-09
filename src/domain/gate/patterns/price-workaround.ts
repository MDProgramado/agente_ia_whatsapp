/**
 * Vocabulário de AR-012 — tratar preço como objeção comum.
 *
 * A definição canônica (§AR-012) é: "NUNCA tratar pedido de preço como objeção
 * comum (a ser contornada). Pedido de preço sempre aciona handoff." A distinção de
 * AR-001 é de **forma**, não de tema:
 *
 * - AR-001 dispara quando o texto **menciona** preço/valor/desconto (o guard
 *   `ar-001.ts` usa `CURRENCY_TERM`, `PERCENT_TERM`, `DISCOUNT_TERM`).
 * - AR-012 dispara quando o texto **contorna** — promete, negocia por dentro, "dá
 *   um jeito" — tipicamente **sem** citar um número, porque citar o número já é
 *   AR-001.
 *
 * AR-001 vem **antes** de AR-012 na ordem canônica, então um texto que casa os
 * dois é auditado como AR-001 — o que é correto: citar o valor é a violação mais
 * grave. Este arquivo existe para pegar o caso que AR-001 não vê: "consigo ver com
 * o pessoal", "depois a gente negocia", "vai ser difícil".
 *
 * ## Duas listas, de propósito
 *
 * `PRICE_WORKAROUND_TERM` são termos fortes e, em geral, **livres de preço**: por
 * si só já são contorno. `PRICE_WORKAROUND_CONTEXTUAL` são termos fracos que
 * aparecem em conversa normal ("no máximo de 2 dias", "sem compromisso") e só
 * contam como contorno quando um termo de preço aparece junto no mesmo texto —
 * senão o guard viraria um bloqueador de conversa comum.
 *
 * **Este é o único lugar do projeto onde a palavra "desconto" aparece numa lista
 * de termos permitidos** — e mesmo aqui é apenas para **bloquear** (AR-001/AR-012).
 */
import { primeiroTermoQueCasa } from "./automation-disclosure.js";

/** Contorno de preço — forte, dispara sozinho. AR-012. */
export const PRICE_WORKAROUND_TERM: readonly RegExp[] = [
	/\bconsigo ver com\b/i,
	/\bvou pedir (?:pro|para o|pro pro|ao|pra o) pessoal\b/i,
	/\bconsigo aprovar\b/i,
	/\bvai ser dif[íi]cil\b/i,
	/\bdepois a gente negocia\b/i,
	/\bconsigo fazer um esfor[çc]o\b/i,
	/\bd[áa] pra quebrar\b/i,
	/\bte mando um valor mais baixo\b/i,
	/\bfica no seu or[çc]amento\b/i,
	/\bsen[ãa]o [ée] o valor cheio\b/i,
];

/** Contorno fraco — só conta se houver termo de preço no mesmo texto. AR-012. */
export const PRICE_WORKAROUND_CONTEXTUAL: readonly RegExp[] = [
	/\bno m[áa]ximo\b/i,
	/\bsem compromisso\b/i,
	/\b[ée] s[óo] uma formalidade\b/i,
];

/**
 * Um termo de preço no sentido de AR-001, inline para evitar que este módulo
 * dependa do regex de `automation-disclosure.ts` (que pode evoluir por outro
 * motivo). A co-ocorrência é o que promove um termo contextual a contorno.
 */
const PRICE_TERM =
	/\br\$\s*\d|\breais?\b|\bdinheiro\b|\bvalor\b|\bor[çc]amento\b|\b\d+\s*%|\bpor\s?cento\b|\bdesconto\b|\bpromo[çc][ãa]o\b|\bcupom\b/i;

/**
 * `true` se o texto contorna o preço. Falso-positivo aqui custa uma resposta a
 * mais para o Admin; falso-negativo custa uma negociação — por isso o termo forte
 * dispara sozinho e o fraco exige contexto.
 */
export const contemContornoDePreco = (texto: string): boolean => {
	if (primeiroTermoQueCasa(texto, PRICE_WORKAROUND_TERM) !== null) return true;
	const contextual = primeiroTermoQueCasa(texto, PRICE_WORKAROUND_CONTEXTUAL);
	return contextual !== null && PRICE_TERM.test(texto);
};
