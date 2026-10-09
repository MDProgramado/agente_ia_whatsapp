import { primeiroTermoQueCasa } from "../patterns/automation-disclosure.js";
import {
	CONDICAO_COMERCIAL_TERM,
	ORCAMENTO_TERM,
	PROPOSAL_TERM,
} from "../patterns/proposal.js";
import type { GateInput, GateReason } from "../types.js";

/**
 * AR-002 — proposta, orçamento, contrato.
 *
 * Bloqueia tanto a **intenção** ("vou te mandar a proposta") quanto o **fato
 * declarado** ("a proposta está no e-mail"): nos dois casos o documento comercial
 * não pode sair pela IA, e a ação correta é handoff — acionado por quem **consome**
 * o block, não por este guard.
 *
 * **Não** é o guard de agendamento: agendar é `ar-003.ts` (01-01), e o texto
 * canônico deste guard não usa `SCHEDULE_TERM`. Também **não** é o guard de preço:
 * um valor isolado é `ar-001_preco`, que vem antes na ordem.
 */
export function evaluate(input: GateInput): GateReason | null {
	const achado = primeiroTermoQueCasa(input.outbound.text, [
		...PROPOSAL_TERM,
		...ORCAMENTO_TERM,
		...CONDICAO_COMERCIAL_TERM,
	]);
	return achado === null ? null : "ar002_proposta";
}
