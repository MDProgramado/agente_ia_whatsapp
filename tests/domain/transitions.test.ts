/**
 * FSM da conversa (D-07, CONV-01/R-002, R-051).
 *
 * O ponto do teste é que o estado é decidido por CÓDIGO PURO, nunca pelo modelo:
 * `resolveNextState` recebe uma `hint` (que o modelo pode sugerir) e as guardas
 * LOCAIS. As guardas vencem a hint; a hint só é aceita se constar em
 * `ALLOWED[prev]`. Uma hint inválida nunca muda o estado.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	ALLOWED,
	type Estado,
	resolveNextState,
} from "../../src/domain/orchestrator/transitions.js";

/** Semente fixa: uma falha de propriedade é reproduzível com o mesmo número. */
const SEMENTE = 20261013;

/** Os 9 estados do `conversations_state_check` (migration 0000/0003). */
const ESTADOS: readonly Estado[] = [
	"novo",
	"aquecimento",
	"qualificando",
	"aquecido",
	"awaiting_human",
	"human",
	"copilot",
	"pausado",
	"encerrado",
];

describe("resolveNextState (FSM pura)", () => {
	it("ALLOWED cobre exatamente os 9 estados do conversations_state_check", () => {
		expect(Object.keys(ALLOWED).sort()).toEqual([...ESTADOS].sort());
	});

	it("opt-out ativo vence QUALQUER hint → encerrado (AR-005)", () => {
		for (const prev of ESTADOS) {
			for (const hint of [...ESTADOS, "inexistente", undefined]) {
				expect(
					resolveNextState(prev, hint as string | undefined, {
						optOutAtivo: true,
					}),
				).toBe("encerrado");
			}
		}
	});

	it("handoff disparado → awaiting_human, vencendo a hint (AR-010)", () => {
		for (const prev of ESTADOS) {
			expect(
				resolveNextState(prev, "aquecido", { handoffDisparado: true }),
			).toBe("awaiting_human");
		}
	});

	it("verba e decisão confirmadas → aquecido (R-051)", () => {
		expect(
			resolveNextState("qualificando", undefined, {
				engagementMode: "bot_active",
				qualification: { verba: 2, decisao: 2 },
			}),
		).toBe("aquecido");
	});

	it("Admin manda a 1ª mensagem sem resposta do lead → aquecimento (CONV-01/R-002)", () => {
		expect(
			resolveNextState("novo", undefined, { adminPrimeiraMensagem: true }),
		).toBe("aquecimento");
		// E uma hint qualquer NÃO rebaixa esse resultado.
		expect(
			resolveNextState("novo", "encerrado", { adminPrimeiraMensagem: true }),
		).toBe("aquecimento");
	});

	it("hint válida em ALLOWED[prev] avança o estado", () => {
		expect(
			resolveNextState("novo", "qualificando", { engagementMode: "bot_active" }),
		).toBe("qualificando");
		expect(
			resolveNextState("awaiting_human", "human", {
				engagementMode: "bot_active",
			}),
		).toBe("human");
	});

	it("estado terminal é sumidouro: encerrado não transita", () => {
		for (const hint of ESTADOS) {
			expect(
				resolveNextState("encerrado", hint, { engagementMode: "bot_active" }),
			).toBe("encerrado");
		}
	});

	describe("property tests (seed 20261013)", () => {
		it("hint fora de ALLOWED[prev] NUNCA muda o estado (numRuns 300)", () => {
			fc.assert(
				fc.property(
					fc.constantFrom(...ESTADOS),
					fc.string(),
					(prev, hint) => {
						fc.pre(!(ALLOWED[prev] as readonly string[]).includes(hint));
						expect(
							resolveNextState(prev, hint, { engagementMode: "bot_active" }),
						).toBe(prev);
					},
				),
				{ numRuns: 300, seed: SEMENTE },
			);
		});

		it("engagementMode fora de bot_active/shadow mantém o estado (numRuns 300)", () => {
			fc.assert(
				fc.property(
					fc.constantFrom(...ESTADOS),
					fc.constantFrom("human", "copilot", "pausado", "awaiting_human"),
					(prev, modo) => {
						expect(
							resolveNextState(prev, "aquecido", { engagementMode: modo }),
						).toBe(prev);
					},
				),
				{ numRuns: 300, seed: SEMENTE },
			);
		});
	});
});
