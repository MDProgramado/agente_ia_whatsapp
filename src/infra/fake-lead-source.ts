/**
 * Fonte de leads FAKE — as 4 fixtures do plano (Task 2, passo 2).
 *
 * É este adaptador que o `dispatcher` do 01-01 (e o checkpoint de pareamento)
 * exercita sem rede: trocar a fonte real por ele é o que torna o pipeline
 * testável ponta a ponta sem depender do caça-leads.
 *
 * Fixtures:
 *  (a) lead novo limpo                  → o caminho felizes;
 *  (b) lead com `optOut: true`          → nunca reativado por import;
 *  (c) lead com o MESMO `e164` do (a)  → o teste de dedup por telefone;
 *  (d) `fetchNewChatMessageCap` = 0     → o teste de parada (D-05).
 *
 * `new_contacts: 0` no `rawContent` da fixture (d) é deliberado: deixa explícito
 * no payload que o `0` é do contador de contatos novos, e não um "cap ausente"
 * confundido com "cap zero".
 */
import type { Lead, LeadSourcePort } from "../domain/ports/LeadSourcePort.js";

const ORIGEM = "cacaleads";
const BASE_LEGAL = "legitimo_interesse";
const FINALIDADE = "prospeccao_b2b_servicos_digitais";

/** (a) Lead novo limpo. */
export const LEAD_NOVO_LIMPO: Lead = {
	e164: "+5511999990001",
	name: "Empresa Limpa Ltda",
	addressLine: "Av. Paulista, 1000 - Sao Paulo/SP",
	originSource: ORIGEM,
	legalBasis: BASE_LEGAL,
	purpose: FINALIDADE,
	optOut: false,
	rawContent: { fixture: "lead_novo_limpo", tipo: "novo" },
};

/** (b) Lead que já pediu opt-out na fonte — nunca pode ser reativado (AR-005). */
export const LEAD_OPT_OUT: Lead = {
	e164: "+5511999990002",
	name: "Empresa Opt Out Ltda",
	addressLine: "Rua A, 2 - Campinas/SP",
	originSource: ORIGEM,
	legalBasis: BASE_LEGAL,
	purpose: FINALIDADE,
	optOut: true,
	rawContent: { fixture: "lead_opt_out", tipo: "opt_out" },
};

/** (c) Duplicata por telefone: MESMO `e164` do (a) (LEAD-02). */
export const LEAD_DUPLICADO: Lead = {
	e164: LEAD_NOVO_LIMPO.e164,
	name: "Empresa Limpa (duplicata)",
	addressLine: LEAD_NOVO_LIMPO.addressLine,
	originSource: ORIGEM,
	legalBasis: BASE_LEGAL,
	purpose: FINALIDADE,
	optOut: false,
	rawContent: { fixture: "lead_duplicado", tipo: "duplicado" },
};

/** (d) Lead que acompanha o cap zero: a fonte manda parar (D-05). */
export const LEAD_COM_CAP_ZERO: Lead = {
	e164: "+5511999990004",
	name: "Empresa Cap Zero Ltda",
	addressLine: "Rua D, 4 - Santos/SP",
	originSource: ORIGEM,
	legalBasis: BASE_LEGAL,
	purpose: FINALIDADE,
	optOut: false,
	rawContent: { fixture: "lead_cap_zero", new_contacts: 0 },
};

/**
 * Fonte fake com as 4 fixtures. `newChatMessageCap = 0` por padrão é a fixture
 * (d): o teste de parada precisa de um adaptador que devolva `0` de verdade.
 */
export class FakeLeadSourceAdapter implements LeadSourcePort {
	readonly fixtures: readonly Lead[] = [
		LEAD_NOVO_LIMPO,
		LEAD_OPT_OUT,
		LEAD_DUPLICADO,
		LEAD_COM_CAP_ZERO,
	];

	/** `null` = não sei; `0` = pare. Default 0 (fixture d). */
	newChatMessageCap: number | null = 0;
	reachoutTimelockUntil: Date | null = null;

	async fetchNewLeads(): Promise<Lead[]> {
		return [...this.fixtures];
	}

	async markValidNewLead(_e164: string): Promise<void> {
		// No fake, marcar como válido não tem efeito de rede.
	}

	async fetchNewChatMessageCap(): Promise<number | null> {
		return this.newChatMessageCap;
	}

	async fetchAccountReachoutTimelock(): Promise<Date | null> {
		return this.reachoutTimelockUntil;
	}
}
