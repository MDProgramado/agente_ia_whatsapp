import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../src/domain/gate/evaluate-policy.js";
import { scanPostGate } from "../../src/domain/llm/post-gate.js";
import { validInbound } from "./fixtures.js";

const TEXTOS = [
	"R$ 3.500",
	"o investimento começa em 500",
	"mensalidade de 499",
	"10x de 199",
	"50% de desconto",
	"me manda uma proposta",
	"marquei terça às 14h",
	"retornamos às 14h",
	"Atendimento 24h",
	"Nossa agenda é cheia",
	"Sem custo para você",
	"Boa tarde! Posso ajudar em alguma coisa?",
] as const;

describe("gate canônico × pós-gate — paridade de vocabulário", () => {
	it.each(TEXTOS)("decidem o mesmo para: %s", (texto) => {
		const decisao = evaluatePolicy(validInbound({ outbound: { text: texto } }));
		const veredito = scanPostGate(texto);

		if (decisao.action === "block") {
			expect(veredito.allowed).toBe(false);
			if (!veredito.allowed) expect(veredito.reason).toBe(decisao.reason);
			return;
		}

		expect(decisao.action).toBe("send");
		expect(veredito.allowed).toBe(true);
	});
});
