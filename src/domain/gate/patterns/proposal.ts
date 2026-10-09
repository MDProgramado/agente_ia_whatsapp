/**
 * Vocabulário de AR-002 — fechamento de proposta.
 *
 * O documento (§AR-002) proíbe "enviar proposta, orçamento, contrato, confirmar
 * escopo técnico, prazo de entrega ou condições de pagamento". A linha que separa
 * AR-002 de AR-001 é a de **documento** versus **número**: um valor isolado é
 * AR-001 (preço, e o guard `ar-001.ts` do 01-01 o bloqueia a partir de
 * `CURRENCY_TERM`); uma proposta comercial sem número — "segue a proposta",
 * "manda o contrato" — é AR-002.
 *
 * Por isso `PROPOSAL_TERM` **não** inclui preço/valor/dinheiro: se incluísse, todo
 * texto de AR-002 também seria AR-001, e como AR-001 vem antes na ordem canônica,
 * o painel nunca mostraria `ar002_proposta`. A vocação de AR-002 é o documento e a
 * condição comercial, não o número.
 *
 * Convenção (a mesma de `automation-disclosure.ts`): acento vira classe de
 * caractere (`[çc]`, `[ãa]`) em vez de normalização de runtime, e fronteira de
 * palavra (`\b`) em todo termo, para não casar substring.
 */

/** Documento comercial formal. AR-002. */
export const PROPOSAL_TERM: readonly RegExp[] = [
	/\bproposta\b/i,
	/\bcontrato\b/i,
	/\bminuta\b/i,
	/\btermo de contrato\b/i,
	/\bcota[çc][ãa]o\b/i,
	/\bquote\b/i,
];

/**
 * `or\u00e7amento` separado de `PROPOSAL_TERM` porque o guard nomeia os dois
 * conjuntos explicitamente (item 1 da task) e porque ele é o único termo de
 * AR-002 que também aparece em `CURRENCY_TERM` (AR-001) — mantê-lo isolado
 * documenta esse overlap.
 */
export const ORCAMENTO_TERM: readonly RegExp[] = [/\bor[çc]amento\b/i];

/**
 * Condições comerciais que só fazem sentido junto de um documento: número de
 * parcelas, prazo de entrega, garantia, validade. É o "confirmar escopo técnico,
 * prazo de entrega ou condições de pagamento" da definição canônica.
 */
export const CONDICAO_COMERCIAL_TERM: readonly RegExp[] = [
	/\bn[úu]mero de parcelas\b/i,
	/\bparcelado em\b/i,
	/\bprazo de (entrega|execu[çc][ãa]o)\b/i,
	/\bgarantia de\b/i,
	/\bvalidade da proposta\b/i,
	/\bescopo\b/i,
];
