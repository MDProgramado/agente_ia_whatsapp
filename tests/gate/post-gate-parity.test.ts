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
	// Auditoria 27/11b, item 5 — têm de bloquear nos dois.
	"Fica em 2 mil por mês.",
	"Fica 1.500 mensais.",
	"O custo é de 3 mil.",
	"São 12 parcelas de 199.",
	"Fazemos por 5k.",
	"Sai a 1500 por mês.",
	"Uns 800 por mês resolve.",
	"Te chamo amanhã 15h pra gente alinhar?",
	"Bora uma ligação rápida?",
	"Tem 5 minutinhos amanhã de manhã?",
	// … e têm de passar nos dois.
	"Obrigado, graças ao seu retorno!",
	"Temos mais de 50 clientes.",
	"Fazemos sites, apps e automações.",
	"Trabalhamos com empresas há 10 anos.",
	"Entendi, faz sentido pra vocês?",
	"Estamos no mercado por 10 anos.",
	"Atendemos por 3 estados.",
	"Atendemos mais de 2 mil empresas.",
	"Fazemos 1 entrega mensal.",
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
