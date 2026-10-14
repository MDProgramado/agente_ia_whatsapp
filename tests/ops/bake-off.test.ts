/**
 * Cobertura do harness de bake-off (D-10) — o auto-teste OFFLINE.
 *
 * Prova três coisas que não dependem de rede nem de chave:
 *
 * 1. O corpus é pt-BR e está na faixa pedida (20-40), cada item com estado e
 *    prompt já mascarado.
 * 2. `runBakeOff` roda os adaptadores ROTEIRIZADOS, ecoa o canário por transcript
 *    e produz um veredito ordenado — o harness funciona sem provider real.
 * 3. O score DISCRIMINA: um texto que viola um limite zera `limitesTaxa` e, como
 *    os limites têm peso maior (safety-first), derruba o combinado. Sem isso, o
 *    bake-off seria uma média que premia bonito-em-vez-de-seguro.
 */
import { describe, expect, it } from "vitest";
import {
	type AvaliacaoCandidato,
	avaliarRegistro,
	candidatosOffline,
	PESO_LIMITES,
	PESO_REGISTRO,
	runBakeOff,
	TEXTO_CONSULTIVO,
	TRANSCRIPTS,
	type Transcript,
} from "../../scripts/bake-off.js";
import { scriptedLlmAdapter } from "../../src/infra/llm/scripted-adapter.js";

const primeiro = <T>(lista: readonly T[]): T => {
	const item = lista[0];
	if (item === undefined) throw new Error("esperava ao menos um item");
	return item;
};

describe("bake-off (D-10)", () => {
	it("corpus tem entre 20 e 40 transcripts, todos com estado e prompt", () => {
		expect(TRANSCRIPTS.length).toBeGreaterThanOrEqual(20);
		expect(TRANSCRIPTS.length).toBeLessThanOrEqual(40);
		for (const t of TRANSCRIPTS) {
			expect(t.id).toMatch(/^t\d+$/);
			expect(t.estado.length).toBeGreaterThan(0);
			expect(t.prompt.length).toBeGreaterThan(0);
		}
		// ids únicos (um corpus com colisão mediria duas vezes o mesmo caso).
		const ids = new Set(TRANSCRIPTS.map((t) => t.id));
		expect(ids.size).toBe(TRANSCRIPTS.length);
	});

	it("avaliarRegistro satura em 1 para um texto consultivo", () => {
		expect(avaliarRegistro(TEXTO_CONSULTIVO)).toBe(1);
	});

	it("avaliarRegistro devolve 0 para um texto telegráfico sem pergunta", () => {
		expect(avaliarRegistro("ok")).toBe(0);
	});

	it("runBakeOff roda offline e ordena os candidatos roteirizados", async () => {
		const veredito = await runBakeOff(candidatosOffline());

		expect(veredito.modo).toBe("offline");
		expect(veredito.total).toBe(TRANSCRIPTS.length);
		expect(veredito.avaliacoes).toHaveLength(2);
		expect(veredito.vencedor).not.toBeNull();

		for (const a of veredito.avaliacoes) {
			expect(a.falhas).toBe(0);
			expect(a.limitesOk).toBe(TRANSCRIPTS.length);
			expect(a.limitesTaxa).toBe(1);
		}
		// ordenado por combinado desc: o primeiro tem o maior combinado.
		expect(veredito.avaliacoes[0]?.combinado).toBeGreaterThanOrEqual(
			veredito.avaliacoes[1]?.combinado ?? 0,
		);
	});

	it("um texto que viola limites zera limitesTaxa e afunda o combinado (safety-first)", async () => {
		const violador = {
			provider: "x",
			model: "y",
			adapter: scriptedLlmAdapter({
				geracao: { replyText: "Fica R$ 3.500, com 20% de desconto!" },
			}),
		};
		const recorte: Transcript[] = TRANSCRIPTS.slice(0, 3);

		const veredito = await runBakeOff([violador], { transcripts: recorte });
		const a: AvaliacaoCandidato = primeiro(veredito.avaliacoes);

		expect(a.total).toBe(3);
		expect(a.falhas).toBe(0);
		expect(a.limitesOk).toBe(0);
		expect(a.limitesTaxa).toBe(0);
		// combinado = 0.6*0 + 0.4*registroMedio — os limites NÃO foram mascarados.
		expect(a.combinado).toBeCloseTo(PESO_REGISTRO * a.registroMedio, 10);
		expect(a.combinado).toBeLessThan(PESO_LIMITES);
	});

	it("os pesos somam 1", () => {
		expect(PESO_LIMITES + PESO_REGISTRO).toBeCloseTo(1, 10);
	});
});
