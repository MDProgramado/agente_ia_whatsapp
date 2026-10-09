/**
 * AR-002 — proposta, orçamento, contrato.
 *
 * A linha que separa AR-002 de AR-001 é **documento** versus **número**: um valor
 * isolado é AR-001; "segue a proposta", "manda o contrato" — o documento
 * comercial sem número — é AR-002. Por isso os termos de AR-002 usados aqui são
 * deliberadamente livres de preço: um termo que casasse os dois seria auditado
 * como AR-001 (que vem antes na ordem), e o painel nunca mostraria
 * `ar002_proposta`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../src/domain/gate/evaluate-policy.js";
import { validInbound } from "./fixtures.js";

const TERMOS = [
	"segue a proposta",
	"manda o contrato para assinar",
	"a minuta está pronta",
	"o termo de contrato já saiu",
	"preciso da cotação fechada",
	"mando o quote ainda hoje",
	"o número de parcelas pode mudar",
	"fica parcelado em 3 vezes",
	"o prazo de entrega é de duas semanas",
	"a garantia de 90 dias cobre isso",
	"o escopo do projeto está definido",
] as const;

const comMoldura = fc
	.constantFrom(...TERMOS)
	.map((termo) => `Perfeito, então: ${termo}.`);

describe("AR-002 — proposta / contrato", () => {
	it("bloqueia qualquer texto com termo de proposta, contrato ou condição comercial", () => {
		fc.assert(
			fc.property(comMoldura, (texto) => {
				const decisao = evaluatePolicy(
					validInbound({ outbound: { text: texto } }),
				);
				expect(decisao).toMatchObject({
					action: "block",
					reason: "ar002_proposta",
				});
			}),
			{ seed: 20260928, numRuns: 500 },
		);
	});

	it("NÃO confunde agendamento com proposta: agendar é AR-003", () => {
		const decisao = evaluatePolicy(
			validInbound({ outbound: { text: "Vamos agendar uma reunião" } }),
		);
		expect(decisao).toMatchObject({
			action: "block",
			reason: "ar003_agendamento",
		});
	});

	it("germina: texto sem termo comercial envia", () => {
		const decisao = evaluatePolicy(
			validInbound({
				outbound: { text: "Entendi, me conta um pouco mais sobre o seu caso." },
			}),
		);
		expect(decisao.action).toBe("send");
	});
});
