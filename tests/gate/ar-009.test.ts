/**
 * AR-009 — mídia recebida nunca é processada (R-038).
 *
 * O sinal vive em `conversations.pending_media_block`, ligado pelo inbound do
 * 01-03 quando o lead manda áudio/imagem/PDF. Enquanto estiver ligado, nenhum
 * outbound sai: o conteúdo não foi interpretado e o Admin precisa assumir.
 *
 * A distinção com o guard nomeado `lead_numero_invalido` (R-019) é explícita:
 * número inválido NÃO é AR-009. O segundo teste prende isso.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../src/domain/gate/evaluate-policy.js";
import { validInbound } from "./fixtures.js";

describe("AR-009 — mídia recebida", () => {
	it("bloqueia quando pendingMediaBlock é true; envia quando é false", () => {
		fc.assert(
			fc.property(fc.boolean(), (pendente) => {
				const decisao = evaluatePolicy(
					validInbound({ conversation: { pendingMediaBlock: pendente } }),
				);
				if (pendente) {
					expect(decisao).toMatchObject({
						action: "block",
						reason: "ar009_midia_recebida",
					});
				} else {
					expect(decisao.action).toBe("send");
				}
			}),
			{ seed: 20260928, numRuns: 500 },
		);
	});

	it("número inválido é o guard nomeado (LEAD-03), NÃO AR-009", () => {
		const decisao = evaluatePolicy(
			validInbound({
				conversation: { pendingMediaBlock: false },
				lead: { waValidationState: "invalido" },
			}),
		);
		expect(decisao).toMatchObject({
			action: "block",
			reason: "lead_numero_invalido",
		});
	});
});
