/**
 * AR-001 — preço. O anti-requisito mais grave: citar valor ao lead é o caminho
 * curto para o número irrecuperável (R-059).
 *
 * O guard corre sobre o TEXTO de saída, não sobre a intenção do LLM (`intent:
 * "conversa"` com "R$ 3.500" no corpo é o caso que mata o número). Por isso o
 * property test cobre as formas em que um preço aparece escrito — símbolo de
 * moeda, sigla, valor por extenso, percentual e termo de desconto — porque um
 * único formato não coberto é uma brecha real.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../src/domain/gate/evaluate-policy.js";
import { validInbound } from "./fixtures.js";

/**
 * Todas as grafias de preço que o guard tem de barrar. A moldura neutra
 * ("Sobre isso, …, certo?") prova que o gatilho é o termo, não a frase.
 */
const TERMOS = [
	"R$ 3.500",
	"US$ 1.200",
	"€ 500",
	"USD 1.000",
	"EUR 2.000",
	"cinco mil reais",
	"o valor do serviço",
	"o orçamento fica em X",
	"me passa o dinheiro",
	"uns dólares",
	"50%",
	"vinte por cento",
	"um desconto especial",
	"promoção especial",
	"black friday",
	"cupom",
] as const;

const comMoldura = fc
	.constantFrom(...TERMOS)
	.map((termo) => `Sobre isso, ${termo}, certo?`);

describe("AR-001 — preço", () => {
	it("bloqueia qualquer texto que cite preço, moeda, percentual ou desconto", () => {
		fc.assert(
			fc.property(comMoldura, (texto) => {
				const decisao = evaluatePolicy(
					validInbound({ outbound: { text: texto } }),
				);
				expect(decisao).toMatchObject({
					action: "block",
					reason: "ar001_preco",
				});
			}),
			{ seed: 20260928, numRuns: 500 },
		);
	});

	it.each([
		"O investimento fica a partir de 2 mil por mês",
		"preço começa em 1.500",
		"custa uns 3k",
		"sai por 990",
		"mensalidade é de 499",
		"10x de 199",
		"primeiro mês é grátis",
		"é de graça neste mês",
	])("bloqueia preço dito sem símbolo de moeda: %s", (texto) => {
		const decisao = evaluatePolicy(validInbound({ outbound: { text: texto } }));
		expect(decisao).toMatchObject({
			action: "block",
			reason: "ar001_preco",
		});
	});

	/**
	 * Auditoria 27/11b, item 5 — preço sem moeda nem palavra "preço": o número
	 * vem com "mil"/"k", "mensais", "por mês", "parcelas" ou "custo".
	 */
	it.each([
		"Fica em 2 mil por mês.",
		"Fica 1.500 mensais.",
		"O custo é de 3 mil.",
		"São 12 parcelas de 199.",
		"Fazemos por 5k.",
		"Sai a 1500 por mês.",
		"Uns 800 por mês resolve.",
	])("bloqueia preço coloquial (auditoria 27/11b): %s", (texto) => {
		const decisao = evaluatePolicy(validInbound({ outbound: { text: texto } }));
		expect(decisao).toMatchObject({
			action: "block",
			reason: "ar001_preco",
		});
	});

	/**
	 * O outro lado da fronteira: número que NÃO é preço (tempo de mercado,
	 * quantidade de clientes, entregas) e as frases comuns de apresentação.
	 * Um termo largo demais calaria a conversa normal — o erro caro do outro lado.
	 */
	it.each([
		"Obrigado, graças ao seu retorno!",
		"Boa tarde! Posso ajudar em alguma coisa?",
		"Temos mais de 50 clientes.",
		"Fazemos sites, apps e automações.",
		"Trabalhamos com empresas há 10 anos.",
		"Entendi, faz sentido pra vocês?",
		"Atendimento 24h",
		"Estamos no mercado por 10 anos.",
		"Atendemos por 3 estados.",
		"Atendemos mais de 2 mil empresas.",
		"Fazemos 1 entrega mensal.",
	])("libera frase sem preço (auditoria 27/11b): %s", (texto) => {
		const decisao = evaluatePolicy(validInbound({ outbound: { text: texto } }));
		expect(decisao.action).toBe("send");
	});

	it("germina: texto sem preço não é bloqueado por AR-001", () => {
		// Sem este caso, uma guarda que devolvesse `block` sempre passaria no
		// teste anterior sem provar nada.
		const decisao = evaluatePolicy(
			validInbound({
				outbound: { text: "Boa tarde! Posso ajudar em alguma coisa?" },
			}),
		);
		expect(decisao.action).toBe("send");
	});
});
