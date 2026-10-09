/**
 * AR-010 — agir após handoff (R-066). Silêncio total.
 *
 * Três eixos disparam, e o guard é de **modo**, não só de flag:
 *   (a) `handoffActive === true`;
 *   (b) `engagementMode` em `human`/`awaiting_human`;
 *   (c) `state` em `awaiting_human`/`human` — cobre o intervalo em que a flag já
 *       voltou a `false` mas o modo ainda não.
 *
 * O property test compõe os três e calcula o esperado no próprio teste.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../src/domain/gate/evaluate-policy.js";
import type { GateInput } from "../../src/domain/gate/types.js";
import { validInbound } from "./fixtures.js";

const MODOS: readonly GateInput["conversation"]["engagementMode"][] = [
	"bot_active",
	"awaiting_human",
	"human",
	"copilot",
	"pausado",
];

const ESTADOS = [
	"novo",
	"bot_active",
	"awaiting_human",
	"human",
	"encerrado",
] as const;

describe("AR-010 — pós-handoff", () => {
	it("bloqueia quando handoffActive, modo humano ou estado humano", () => {
		fc.assert(
			fc.property(
				fc.boolean(),
				fc.constantFrom(...MODOS),
				fc.constantFrom(...ESTADOS),
				(handoffActive, engagementMode, state) => {
					const esperado =
						handoffActive ||
						engagementMode === "human" ||
						engagementMode === "awaiting_human" ||
						state === "awaiting_human" ||
						state === "human";

					const decisao = evaluatePolicy(
						validInbound({
							conversation: { handoffActive, engagementMode, state },
						}),
					);

					if (esperado) {
						expect(decisao).toMatchObject({
							action: "block",
							reason: "ar010_handoff_ativo",
						});
					} else {
						expect(decisao.action).toBe("send");
					}
				},
			),
			{ seed: 20260928, numRuns: 500 },
		);
	});

	it("copilot NÃO é handoff: o modo copiloto deixa o bot atuar com revisão", () => {
		const decisao = evaluatePolicy(
			validInbound({
				conversation: { handoffActive: false, engagementMode: "copilot" },
			}),
		);
		expect(decisao.action).toBe("send");
	});
});
