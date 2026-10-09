import { primeiroTermoQueCasa } from "../patterns/automation-disclosure.js";
import {
	contemContornoDePreco,
	PRICE_WORKAROUND_TERM,
} from "../patterns/price-workaround.js";
import type { GateInput, GateReason } from "../types.js";

/**
 * AR-012 — tratar preço como objeção comum.
 *
 * Dispara quando o texto **contorna** o pedido de preço: promete, negocia por
 * dentro, "dá um jeito". A distinção de AR-001 está no cabeçalho de
 * `price-workaround.ts`: AR-012 existe para o caso que AR-001 não vê — o contorno
 * **sem** número.
 *
 * Na ordem canônica AR-001 vem antes de AR-012, então um texto que casa os dois é
 * auditado como `ar001_preco` — o correto, porque citar o valor é a violação mais
 * grave.
 *
 * **Este guard não olha `lastLeadSignalAt`, não olha estado da conversa e não
 * adiciona nada ao `GateInput`.** A versão anterior deste plano tratava AR-012
 * como progressão de estado; isso foi removido porque "forçar lead" não tem linha
 * em `docs/10-anti-requisitos.md`. AR-012 é preço, não progressão.
 */
export function evaluate(input: GateInput): GateReason | null {
	const { text } = input.outbound;
	if (primeiroTermoQueCasa(text, PRICE_WORKAROUND_TERM) !== null) {
		return "ar012_preco_como_objecao";
	}
	return contemContornoDePreco(text) ? "ar012_preco_como_objecao" : null;
}
