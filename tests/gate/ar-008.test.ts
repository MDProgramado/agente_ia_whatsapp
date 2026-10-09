/**
 * AR-008 — limite diário (R-023).
 *
 * O teto é `min(limite configurado, cap físico)`: o Admin pode baixar o limite,
 * nunca subir acima do cap. O property test calcula o esperado a partir dos
 * mesmos componentes (não chama a implementação) e cobre a borda `>=`: com teto
 * 25, a 26ª mensagem é a que viola — `sentToday` já é o que foi reservado.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../src/domain/gate/evaluate-policy.js";
import { validInbound } from "./fixtures.js";

describe("AR-008 — limite diário", () => {
	it("bloqueia exatamente quando sentToday >= min(dailyMessageLimit, dailyMessageCap)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 40 }), // sentToday
				fc.integer({ min: 0, max: 30 }), // dailyMessageLimit
				fc.integer({ min: 0, max: 30 }), // dailyMessageCap
				(sentToday, dailyMessageLimit, dailyMessageCap) => {
					const teto = Math.min(dailyMessageLimit, dailyMessageCap);
					const decisao = evaluatePolicy(
						validInbound({
							outbound: { text: "Boa tarde! Posso ajudar em alguma coisa?" },
							context: { sentToday, dailyMessageLimit, dailyMessageCap },
						}),
					);

					if (sentToday >= teto) {
						expect(decisao).toMatchObject({
							action: "block",
							reason: "ar008_limite_diario",
						});
					} else {
						expect(decisao.action).toBe("send");
					}
				},
			),
			{ seed: 20260928, numRuns: 500 },
		);
	});
});
