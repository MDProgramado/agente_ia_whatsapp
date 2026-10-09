/**
 * AR-005 — opt-out. Bloqueio total e irreversível (R-024).
 *
 * O guard mais simples de propósito: a irreversibilidade já é garantida no banco
 * pelo trigger `fn_opt_out_irreversible` (01-02), então o trabalho aqui é **não
 * deixar passar** — dentro da janela, com cota sobrando, com handoff inativo,
 * venha o que vier. O property test usa `fc.string()` livre: não importa o texto,
 * opt-out ligado é bloqueio.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../src/domain/gate/evaluate-policy.js";
import { validInbound } from "./fixtures.js";

describe("AR-005 — opt-out", () => {
	it("bloqueia QUALQUER texto quando optOut é true", () => {
		fc.assert(
			fc.property(fc.string(), (texto) => {
				const decisao = evaluatePolicy(
					validInbound({ lead: { optOut: true }, outbound: { text: texto } }),
				);
				expect(decisao).toMatchObject({
					action: "block",
					reason: "ar005_opt_out",
				});
			}),
			{ seed: 20260928, numRuns: 500 },
		);
	});

	it("opt-out vence o preço: AR-005 vem antes de AR-001 na ordem", () => {
		// Um texto que casaria AR-001 é auditado como AR-005 — o motivo mais grave
		// para o lead. Se a ordem mudasse, o painel mostraria "preço" onde a
		// mensagem foi barrada por pedido de saída.
		const decisao = evaluatePolicy(
			validInbound({
				lead: { optOut: true },
				outbound: { text: "o valor fica em R$ 3.500" },
			}),
		);
		expect(decisao).toMatchObject({
			action: "block",
			reason: "ar005_opt_out",
		});
	});

	it("germina: optOut false e texto neutro envia", () => {
		const decisao = evaluatePolicy(
			validInbound({
				outbound: { text: "Boa tarde! Posso ajudar em alguma coisa?" },
			}),
		);
		expect(decisao.action).toBe("send");
	});
});
