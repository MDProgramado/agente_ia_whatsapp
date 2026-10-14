/**
 * Pós-gate de conteúdo (L4, CONV-07) — barreira determinística sobre o TEXTO GERADO.
 *
 * O teste é de CONTRATO, não de implementação: ele fixa a fronteira entre
 * "conteúdo que nunca deveria sair" e "contorno legítimo". A lista de liberados
 * é tão importante quanto a de proibidos — um pós-gate que cala toda conversa de
 * objeção é inútil (a IA existe para contornar objeção, R-042/AR-012) e o erro
 * cairia no lado caro: silêncio em conversa qualificada.
 *
 * Três decisões que o teste trava:
 *
 * 1. **Fail-closed, mas não cego.** "Sem custo para você" é frase de venda
 *    legítima e NÃO pode bloquear por causa da palavra "custo" (que não é termo
 *    de preço). O anexo `.pdf`/`áudio` é mídia (AR-004) e bloqueia.
 * 2. **Precedência estável.** Quando o texto casa mais de um termo (ex.:
 *    "me manda uma proposta com o valor"), o motivo devolvido é o do primeiro
 *    classificador — o mesmo `ar001_preco` que o gate canônico reportaria.
 * 3. **Discriminante honesto.** `allowed:true` nunca carrega `reason`; o motivo
 *    só existe no ramo bloqueado.
 */
import { describe, expect, it } from "vitest";
import type { GateReason } from "../../src/domain/gate/types.js";
import { scanPostGate } from "../../src/domain/llm/post-gate.js";

interface CasoProibido {
	readonly texto: string;
	readonly reason: GateReason;
}

/** Amostras que o pós-gate NUNCA pode deixar passar, com o motivo canônico. */
const PROIBIDOS: readonly CasoProibido[] = [
	// ── valor / percentual / desconto / promo (AR-001) ──────────────────────
	{ texto: "R$ 3.500", reason: "ar001_preco" },
	{ texto: "3500 reais", reason: "ar001_preco" },
	{ texto: "50% de desconto", reason: "ar001_preco" },
	{ texto: "desconto de 30%", reason: "ar001_preco" },
	{ texto: "promoção", reason: "ar001_preco" },
	{ texto: "é só 250 reais por mês", reason: "ar001_preco" },
	// ── documento comercial (AR-002) ────────────────────────────────────────
	{ texto: "me manda uma proposta", reason: "ar002_proposta" },
	{ texto: "segue o contrato assinado", reason: "ar002_proposta" },
	// ── promessa de agenda (AR-003) ─────────────────────────────────────────
	{ texto: "marquei terça às 14h", reason: "ar003_agendamento" },
	{ texto: "podemos marcar uma reunião amanhã?", reason: "ar003_agendamento" },
	// ── mídia no outbound (AR-004) ──────────────────────────────────────────
	{ texto: "PDF", reason: "ar004_midia_saida" },
	{ texto: "áudio", reason: "ar004_midia_saida" },
	{ texto: "segue o anexo", reason: "ar004_midia_saida" },
	{ texto: "te mando uma imagem do projeto", reason: "ar004_midia_saida" },
];

/**
 * Amostras que o pós-gate PRECISA liberar. Se qualquer uma bloquear, o teste
 * falha: é a prova de que a barreira não engoliu o contorno legítimo.
 */
const LIBERADOS: readonly string[] = [
	"posso te explicar como funciona",
	"cada projeto é único",
	// Frase de venda com "custo" — explicitamente NÃO é termo de preço.
	"Sem custo para você",
	"Entendo perfeitamente. Cada projeto é único, e a gente gosta de entender o seu momento antes de sugerir qualquer caminho.",
	// "agenda" (substantivo) não é "agendar" (verbo): não pode bloquear.
	"Faz sentido. Nossa agenda é cheia, então prefiro entender seu cenário primeiro.",
];

describe("scanPostGate — pós-gate de conteúdo (CONV-07)", () => {
	it.each(PROIBIDOS)(
		"bloqueia '$texto' com motivo $reason",
		({ texto, reason }) => {
			const veredito = scanPostGate(texto);
			expect(veredito.allowed).toBe(false);
			if (veredito.allowed) return;
			expect(veredito.reason).toBe(reason);
			// O detalhe é legível e marcado como pós-gate (o relatório da Task 3 o cita).
			expect(veredito.detail).toMatch(/p[óo]s-gate/i);
		},
	);

	it.each(LIBERADOS)("libera contorno legítimo: '$texto'", (texto) => {
		expect(scanPostGate(texto).allowed).toBe(true);
	});

	it("allowed:true nunca carrega motivo (discriminante honesto)", () => {
		const veredito = scanPostGate("tudo certo por aí?");
		expect(veredito.allowed).toBe(true);
		expect("reason" in veredito).toBe(false);
	});

	it("precedência: valor vence quando o texto casa preço e proposta", () => {
		const veredito = scanPostGate("segue a proposta com o valor de R$ 900");
		expect(veredito.allowed).toBe(false);
		if (veredito.allowed) return;
		expect(veredito.reason).toBe("ar001_preco");
	});
});
