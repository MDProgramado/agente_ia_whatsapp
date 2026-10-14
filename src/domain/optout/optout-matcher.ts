/**
 * Matcher determinístico de opt-out pt-BR — a AUTORIDADE do opt-out (02-02, D-14).
 *
 * A regra do produto é assimétrica de propósito: um pedido de opt-out mal
 * interpretado é uma violação de R-024/LGPD, e uma recusa mal interpretada é uma
 * conversa que continua. Por isso o classificar é **código**, não prompt: a LLM
 * pode reforçar (o sinal `pedido_optout` da Camada 1), mas está estruturalmente
 * fora da decisão — `classifyOptout` só recebe texto, então não existe assinatura
 * em que um sinal do modelo rebaixe uma classe. Reforço é aditivo, nunca OR-negado.
 *
 * ## Duas listas, no formato de `price-workaround.ts`
 *
 * `FORTE_TERM` dispara sozinho: recusa explícita ("não me mande mais mensagem")
 * e recusa implícita DEFINIDA ("não tenho interesse", "não quero"). Uma recusa
 * definida vira opt-out irreversível — `leads.opt_out = true` + `optout_ledger`,
 * que nenhum código desfaz (R-024).
 *
 * `AMBIGUO_TERM` cobre adiamento e hesitação ("agora não", "depois eu vejo",
 * "vou pensar"). Ambíguo NUNCA vira opt-out: vira **handoff** para decisão
 * humana. Colapsar os dois lados é o erro que a fase existe para proibir.
 *
 * ## Fronteira e acento (decisão herdada de `automation-disclosure.ts`)
 *
 * Todo termo tem `\b` para não casar substring ("pare" deve casar a palavra, não
 * "aparecer"). Acento vira classe de caractere (`[ãa]`, `[ôo]`, `[úu]`), nunca
 * normalização em runtime — o match roda sobre o texto real, colapsado em
 * espaços, com `i` para maiúsculas.
 */
import { primeiroTermoQueCasa } from "../gate/patterns/automation-disclosure.js";

/**
 * Classe do pedido. `FORTE` → opt-out irreversível; `AMBIGUO` → handoff;
 * `NAO` → segue o fluxo normal.
 */
export const OptoutClass = {
	NAO: "nao",
	AMBIGUO: "ambiguo",
	FORTE: "forte",
} as const;

export type OptoutClass = (typeof OptoutClass)[keyof typeof OptoutClass];

/**
 * Recusa explícita e implícita DEFINIDA. Um casamento aqui é opt-out, com toda a
 * irreversibilidade que R-024/AR-005 exigem.
 *
 * O lookahead de `n[ãa]o quero` exclui "não quero perder tempo" — uma objeção de
 * tempo, não um pedido de saída. Sem ele, a regex gananciosa transformaria uma
 * reclamação comum em opt-out permanente.
 */
export const FORTE_TERM: readonly RegExp[] = [
	/\bn[ãa]o\s+(?:me\s+)?(?:mande|manda|mandar|envie|envia|enviar)\s+(?:mais\s+)?(?:mensage(?:m|ns)|nada)\b/i,
	/\b(?:para|pare)\s+de\s+me\s+(?:mandar|manda|chamar|chama|enviar|envia)\b/i,
	/\bn[ãa]o\s+me\s+(?:mande|manda|chame|chama|contate|contata|contacte|perturbe|incomode|ligue|ligar)\b/i,
	/\bme\s+(?:tira|tire|remove|remova|retira|retire|exclui|exclua|apaga|apague)\s+(?:da|do)\s+(?:lista|contato|contatos|cadastro|base|sistema)\b/i,
	/\b(?:me\s+)?descadastr(?:a|ar|e|em|o)\b/i,
	/\b(?:remove|remover|excluir|exclua|apagar|apague)\s+(?:meu|o\s+meu)\s+(?:n[úu]mero|contato|cadastro)\b/i,
	/\bn[ãa]o\s+quero\s+(?:mais|receber|ser\s+contatad[oa]|nada|falar)\b/i,
	// Lookahead: "não quero perder tempo" é objeção de tempo, não opt-out.
	/\bn[ãa]o\s+quero\b(?!\s+(?:perder|gastar)\s+tempo)/i,
	/\bn[ãa]o\s+tenho\s+interesse\b/i,
	/\bsem\s+interesse\b/i,
	/\bn[ãa]o\s*,?\s*obrigad[oa]\b/i,
	/\bpare\b/i,
];

/**
 * Adiamento e hesitação. Um casamento aqui é **handoff**, jamais opt-out: o
 * sistema para e o Admin decide, sem gravar um opt-out que o titular não pediu.
 */
export const AMBIGUO_TERM: readonly RegExp[] = [
	/\bagora\s+n[ãa]o\b/i,
	/\bdepois\s+eu\s+vejo\b/i,
	/\btalvez\s+(?:em\s+)?(?:outro|outra)\s+(?:momento|hora|ocasi[ãa]o)\b/i,
	/\bmais\s+(?:pra|para)\s+frente\b/i,
	/\bem\s+outro\s+momento\b/i,
	/\bn[ãa]o\s+[ée]\s+o\s+momento\b/i,
	/\bsem\s+tempo\s+(?:agora|no\s+momento)\b/i,
	/\bt[ôo]\s+sem\s+tempo\b/i,
	/\bvou\s+pensar\b/i,
	/\bmais\s+tarde\b/i,
];

/** Colapsa espaços em branco (quebras de linha, tabs) antes do match. */
const normalizar = (texto: string): string => texto.replace(/\s+/g, " ").trim();

/**
 * Classifica o texto do lead. A ordem importa: FORTE vence AMBIGUO — uma frase
 * que peça saída e hesite ao mesmo tempo é uma saída.
 */
export const classifyOptout = (texto: string): OptoutClass => {
	const normalizado = normalizar(texto);
	if (primeiroTermoQueCasa(normalizado, FORTE_TERM) !== null)
		return OptoutClass.FORTE;
	if (primeiroTermoQueCasa(normalizado, AMBIGUO_TERM) !== null)
		return OptoutClass.AMBIGUO;
	return OptoutClass.NAO;
};
