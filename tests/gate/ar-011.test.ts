/**
 * AR-011 — base legal e registro (R-064, LGPD).
 *
 * Quatro campos obrigatórios: origem, base legal, finalidade e a data do
 * registro. Falta qualquer um e o envio para. A data é comparada com `now`
 * (`>=`), então um registro no futuro também barra — registrar "antes de existir"
 * é tão inválido quanto não registrar.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../src/domain/gate/evaluate-policy.js";
import type { GateInput } from "../../src/domain/gate/types.js";
import { DIA_UTIL_DENTRO_DA_JANELA, validInbound } from "./fixtures.js";

const CAMPOS = [
	"originSource",
	"legalBasis",
	"purpose",
	"legalRegisteredAt",
] as const;

/** Zera um campo do lead, preservando o tipo `Partial<GateInput["lead"]>`. */
const semCampo = (
	campo: (typeof CAMPOS)[number],
): Partial<GateInput["lead"]> => {
	const over: Partial<GateInput["lead"]> = {};
	over[campo] = null;
	return over;
};

describe("AR-011 — base legal", () => {
	it("bloqueia quando falta qualquer campo do registro legal", () => {
		fc.assert(
			fc.property(fc.constantFrom(...CAMPOS), (campo) => {
				const decisao = evaluatePolicy(validInbound({ lead: semCampo(campo) }));
				expect(decisao).toMatchObject({
					action: "block",
					reason: "ar011_base_legal",
				});
			}),
			{ seed: 20260928, numRuns: 500 },
		);
	});

	it("bloqueia registro de base legal no futuro (ou no mesmo instante)", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 3650 }), (diasFuturo) => {
				const agora = new Date(DIA_UTIL_DENTRO_DA_JANELA);
				const futuro = new Date(agora.getTime() + diasFuturo * 86_400_000);
				const decisao = evaluatePolicy(
					validInbound({
						lead: { legalRegisteredAt: futuro.toISOString() },
						context: { now: agora },
					}),
				);
				expect(decisao).toMatchObject({
					action: "block",
					reason: "ar011_base_legal",
				});
			}),
			{ seed: 20260928, numRuns: 500 },
		);
	});

	it("germina: registro completo e passado envia", () => {
		const decisao = evaluatePolicy(
			validInbound({
				outbound: { text: "Boa tarde! Posso ajudar em alguma coisa?" },
			}),
		);
		expect(decisao.action).toBe("send");
	});
});
