/**
 * AR-012 — preço tratado como objeção (contornar).
 *
 * A distinção de AR-001 é de **forma**: AR-001 cita o número, AR-012 contorna sem
 * citar ("consigo ver com o pessoal", "depois a gente negocia"). Os termos
 * escolhidos aqui são deliberadamente **livres de preço** — porque AR-001 vem
 * antes na ordem e capturaria qualquer termo que também cite valor.
 *
 * O último teste prende essa interação: um termo de contorno que *também* contém
 * preço ("te mando um valor mais baixo") é auditado como AR-001, e isso é o
 * comportamento correto — a violação mais grave ganha o motivo.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../src/domain/gate/evaluate-policy.js";
import { validInbound } from "./fixtures.js";

/** Termos fortes de contorno que NÃO citam preço — auditar como AR-012. */
const TERMOS = [
	"consigo ver com o pessoal",
	"vou pedir pro pessoal",
	"consigo aprovar",
	"vai ser difícil",
	"depois a gente negocia",
	"consigo fazer um esforço",
	"dá pra quebrar",
] as const;

const comMoldura = fc
	.constantFrom(...TERMOS)
	.map((termo) => `Olha, ${termo}, tá?`);

describe("AR-012 — contorno de preço", () => {
	it("bloqueia contorno forte de preço sem valor explícito", () => {
		fc.assert(
			fc.property(comMoldura, (texto) => {
				const decisao = evaluatePolicy(
					validInbound({ outbound: { text: texto } }),
				);
				expect(decisao).toMatchObject({
					action: "block",
					reason: "ar012_preco_como_objecao",
				});
			}),
			{ seed: 20260928, numRuns: 500 },
		);
	});

	it("contorno que também cita preço é auditado como AR-001 (vem antes)", () => {
		const decisao = evaluatePolicy(
			validInbound({ outbound: { text: "te mando um valor mais baixo" } }),
		);
		expect(decisao).toMatchObject({
			action: "block",
			reason: "ar001_preco",
		});
	});

	it("germina: texto sem contorno envia", () => {
		const decisao = evaluatePolicy(
			validInbound({
				outbound: {
					text: "Entendi perfeitamente. Vamos conversar sobre isso.",
				},
			}),
		);
		expect(decisao.action).toBe("send");
	});
});
