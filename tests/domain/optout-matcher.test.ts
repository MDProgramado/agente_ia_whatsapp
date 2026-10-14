/**
 * Matcher determinístico de opt-out pt-BR (02-02 Task 1, D-14).
 *
 * O que este teste trava: o matcher é a AUTORIDADE do opt-out. Um sinal da LLM
 * (`pedido_optout`) só REFORÇA — nunca desbloqueia nem rebaixa. Por isso a função
 * é pura sobre o TEXTO: não há parâmetro de sinal, então não existe assinatura em
 * que o modelo possa mudar a classe.
 *
 * A matriz cobre FORTE (opt-out irreversível), AMBIGUO (→ handoff, jamais
 * opt-out) e NAO (segue o fluxo), com acentos, maiúsculas e pontuação. A recusa
 * implícita definida ("não tenho interesse", "não quero") é FORTE; o adiamento
 * ("agora não", "depois eu vejo") é AMBIGUO.
 */
import { describe, expect, it } from "vitest";
import {
	classifyOptout,
	OptoutClass,
} from "../../src/domain/optout/optout-matcher.js";
import { corpus } from "../adversarial/corpus.js";

describe("classifyOptout — autoridade determinística pt-BR (D-14)", () => {
	it("recusa explícita/implícita definida → FORTE", () => {
		const fortes = [
			"não me mande mais mensagem",
			"para de me chamar",
			"me tira da lista",
			"descadastra",
			"não quero mais",
			"não tenho interesse",
			"sem interesse",
			"não quero",
			"não me manda mais nada",
			"não quero receber mais nada",
		];
		for (const frase of fortes) {
			expect(classifyOptout(frase), frase).toBe(OptoutClass.FORTE);
		}
	});

	it("reconhece variações de pontuação, maiúsculas e acentos", () => {
		expect(classifyOptout("Não, obrigado")).toBe(OptoutClass.FORTE);
		expect(classifyOptout("NAO QUERO!!!")).toBe(OptoutClass.FORTE);
		expect(classifyOptout("pare")).toBe(OptoutClass.FORTE);
		expect(classifyOptout("  PARA   de   me   mandar  ")).toBe(
			OptoutClass.FORTE,
		);
	});

	it("adiamento/hesitação → AMBIGUO (nunca opt-out)", () => {
		expect(classifyOptout("agora não")).toBe(OptoutClass.AMBIGUO);
		expect(classifyOptout("depois eu vejo")).toBe(OptoutClass.AMBIGUO);
		expect(classifyOptout("talvez outro momento")).toBe(OptoutClass.AMBIGUO);
		expect(classifyOptout("mais pra frente")).toBe(OptoutClass.AMBIGUO);
		expect(classifyOptout("não é o momento")).toBe(OptoutClass.AMBIGUO);
		expect(classifyOptout("vou pensar")).toBe(OptoutClass.AMBIGUO);
	});

	it("conversa neutra → NAO", () => {
		expect(classifyOptout("bom dia, tudo bem?")).toBe(OptoutClass.NAO);
		expect(classifyOptout("qual o valor do serviço?")).toBe(OptoutClass.NAO);
		expect(classifyOptout("gostaria de saber mais")).toBe(OptoutClass.NAO);
	});

	it("objeção de tempo NÃO é opt-out (anti-padrão da regex gananciosa)", () => {
		expect(classifyOptout("não quero perder tempo")).toBe(OptoutClass.NAO);
	});

	it("a LLM só reforça: a assinatura não aceita sinal — a classe é do texto", () => {
		// Aridade 1 prova estruturalmente que não há parâmetro de sinal da LLM que
		// possa rebaixar AMBIGUO. Um `pedido_optout` verdadeiro não muda nada aqui.
		expect(classifyOptout.length).toBe(1);
		expect(classifyOptout("agora não")).toBe(OptoutClass.AMBIGUO);
	});

	it("corpus adversário: FORTE e AMBIGUO classificam como o esperado", () => {
		for (const frase of corpus.optoutForte) {
			expect(classifyOptout(frase), frase).toBe(OptoutClass.FORTE);
		}
		for (const frase of corpus.optoutAmbiguo) {
			expect(classifyOptout(frase), frase).toBe(OptoutClass.AMBIGUO);
		}
	});
});
