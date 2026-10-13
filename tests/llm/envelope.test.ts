/**
 * Envelope Zod da LLM (Camada 1 = extração; Camada 3 = geração) com campo-canário.
 *
 * Duas coisas se provam aqui:
 * 1. O enum de intenção separa `pedido_preco` (→ handoff, AR-001) de
 *    `objecao_preco` (→ contorno, R-042) — colapsá-los mandaria um pedido de
 *    preço para o caminho de "contornar objeção" (D-09).
 * 2. O canário é obrigatório no plural do envelope e validado por eco; ausente
 *    ou divergente vira erro TIPADO, que o adaptador trata como falha-fechada
 *    (D-10) — nunca texto livre.
 */
import { describe, expect, it } from "vitest";
import {
	canarioEsperado,
	envelopeExtracao,
	envelopeGeracao,
	INTENCOES,
	validaEcoCanario,
} from "../../src/domain/llm/envelope.js";

const extracaoValida = (): Record<string, unknown> => ({
	intent: "saudacao",
	signals: {
		pricingAsked: false,
		schedulingIntent: false,
		botSuspicion: false,
		irritation: false,
		optOutIntent: false,
		mediaReceived: false,
	},
	qualification: { verba: null, decisao: null },
	nextStateHint: "qualificando",
	canary: "CANARIO-fixo",
});

describe("envelope de extração (Camada 1)", () => {
	it("parseia um objeto válido com intent, signals, qualification e canary", () => {
		const r = envelopeExtracao.safeParse(extracaoValida());
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.data.intent).toBe("saudacao");
			expect(r.data.qualification).toEqual({ verba: null, decisao: null });
			expect(r.data.canary).toBe("CANARIO-fixo");
		}
	});

	it("pedido_preco e objecao_preco são valores VÁLIDOS e DISTINTOS (D-09)", () => {
		expect(INTENCOES).toContain("pedido_preco");
		expect(INTENCOES).toContain("objecao_preco");
		expect(new Set(INTENCOES).size).toBe(INTENCOES.length);
		expect(
			envelopeExtracao.safeParse({
				...extracaoValida(),
				intent: "pedido_preco",
			}).success,
		).toBe(true);
		expect(
			envelopeExtracao.safeParse({
				...extracaoValida(),
				intent: "objecao_preco",
			}).success,
		).toBe(true);
	});

	it("intenção fora do enum fechado é rejeitada", () => {
		expect(
			envelopeExtracao.safeParse({ ...extracaoValida(), intent: "inventado" })
				.success,
		).toBe(false);
	});

	it("canário ausente → erro tipado (falha-fechada)", () => {
		const base = extracaoValida();
		const semCanario: Record<string, unknown> = { ...base };
		delete semCanario.canary;
		expect(envelopeExtracao.safeParse(semCanario).success).toBe(false);
	});

	it("qualification fora de 0..2 ou não-inteira é rejeitada", () => {
		expect(
			envelopeExtracao.safeParse({
				...extracaoValida(),
				qualification: { verba: 3, decisao: null },
			}).success,
		).toBe(false);
		expect(
			envelopeExtracao.safeParse({
				...extracaoValida(),
				qualification: { verba: 1.5, decisao: null },
			}).success,
		).toBe(false);
	});
});

describe("canário: factory determinística + validador de eco", () => {
	it("a factory é determinística e o eco casa consigo mesmo", () => {
		const esperado = canarioEsperado("conv-1");
		expect(canarioEsperado("conv-1")).toBe(esperado);
		expect(canarioEsperado("conv-2")).not.toBe(esperado);
		expect(validaEcoCanario(esperado, esperado).ok).toBe(true);
	});

	it("canário divergente → erro tipado com esperado e recebido", () => {
		const r = validaEcoCanario(canarioEsperado("conv-1"), "outro-valor");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.esperado).toBe(canarioEsperado("conv-1"));
			expect(r.recebido).toBe("outro-valor");
		}
	});
});

describe("envelope de geração (Camada 3)", () => {
	it("parseia replyText + canary", () => {
		const r = envelopeGeracao.safeParse({
			replyText: "Claro, posso te contar mais sobre como funciona.",
			canary: "CANARIO-ger",
		});
		expect(r.success).toBe(true);
	});

	it("sem canário é rejeitado", () => {
		expect(
			envelopeGeracao.safeParse({ replyText: "texto qualquer" }).success,
		).toBe(false);
	});
});
