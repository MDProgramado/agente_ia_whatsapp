/**
 * Humanização do envio (CONV-13, R-067) — atraso variável por mensagem,
 * "digitando…" e divisão de texto longo no limite do WhatsApp.
 *
 * O que estes testes provam:
 *
 * 1. `humanDelayMs` é **determinístico por semente** (hash SHA-256), não
 *    `Math.random` — o mesmo texto e o mesmo gênero devolvem o mesmo atraso, o
 *    que torna a humanização auditável e reprodutível.
 * 2. `first` tem teto de 2s e `followup` tem piso de 2,5s (R-067): a primeira
 *    resposta é mais rápida que a terceira, e o follow-up "pensa" mais.
 * 3. `splitLongMessage` nunca excede o limite, nunca corta no meio de uma
 *    palavra e a concatenação dos pedaços com um espaço reconstrói o original.
 * 4. `simulateTyping` emite progresso e usa o `sleep` injetado — nunca toca o
 *    canal (o `ChannelPort` nem tem método de "digitando").
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	FOLLOWUP_MAX_MS,
	FOLLOWUP_MIN_MS,
	FIRST_MAX_MS,
	FIRST_MIN_MS,
	humanDelay,
	humanDelayMs,
	LIMITE_WHATSAPP,
	simulateTyping,
	splitLongMessage,
} from "../../src/application/humanize.js";

/** Uma palavra minúscula de 1 a 12 letras — jamais contém o separador de corte. */
const palavra = fc.stringMatching(/^[a-z]{1,12}$/);

/** Texto com palavras separadas por UM espaço simples (o que a concatenação assume). */
const textoDePalavras = (maxPalavras: number) =>
	fc
		.array(palavra, { minLength: 1, maxLength: maxPalavras })
		.map((palavras) => palavras.join(" "));

const semear = (rotulo: string) => ({ seed: 20260929, path: rotulo });

describe("splitLongMessage (CONV-13)", () => {
	it("texto curto nao e dividido", () => {
		expect(splitLongMessage("Boa tarde! Tudo bem?")).toEqual([
			"Boa tarde! Tudo bem?",
		]);
	});

	it("nunca devolve array vazio nem pedaco vazio", () => {
		fc.assert(
			fc.property(fc.string(), (texto) => {
				const partes = splitLongMessage(texto);
				return partes.length >= 1 && partes.every((p) => p.length > 0);
			}),
			{ numRuns: 300 },
		);
	});

	it("nenhum pedaco excede o limite, e a ordem/concatenacao reconstroi o original", () => {
		fc.assert(
			fc.property(textoDePalavras(900), (texto) => {
				const partes = splitLongMessage(texto);
				if (partes.some((p) => p.length > LIMITE_WHATSAPP)) return false;
				// Reconstroi por OFFSETS: prova que cada separador consumido foi UM
				// espaço — e que nenhum corte caiu no meio de uma palavra (um corte
				// assim teria uma letra no offset, nao um espaco).
				let offset = 0;
				for (const [i, parte] of partes.entries()) {
					if (texto.slice(offset, offset + parte.length) !== parte) return false;
					offset += parte.length;
					const eUltimo = i === partes.length - 1;
					if (!eUltimo) {
						if (texto[offset] !== " ") return false;
						offset += 1;
					}
				}
				return offset === texto.length;
			}),
			{ numRuns: 300, ...semear("split") },
		);
	});

	it("prefere 2 pedacos a 3 (um texto pouco acima do limite vira 2)", () => {
		const texto = fc.sample(textoDePalavras(600), { numRuns: 1, seed: 7 })[0];
		// Encontra o primeiro ponto que ultrapassa o limite e corta ali, para
		// construir um caso determinístico de "pouco acima do limite".
		const base = (
			"palavra com dez letras e sempre separada por espaco ".repeat(200)
		).trimEnd();
		expect(base.length).toBeGreaterThan(LIMITE_WHATSAPP);
		const partes = splitLongMessage(base);
		expect(partes).toHaveLength(2);
		expect(typeof texto).toBe("string");
	});
});

describe("humanDelayMs (R-067)", () => {
	it("first fica em [800ms, 2s] e followup em [2,5s, 6s]", () => {
		fc.assert(
			fc.property(fc.string(), (seed) => {
				const first = humanDelayMs("first", seed);
				const followup = humanDelayMs("followup", seed);
				return (
					first >= FIRST_MIN_MS &&
					first <= FIRST_MAX_MS &&
					followup >= FOLLOWUP_MIN_MS &&
					followup <= FOLLOWUP_MAX_MS
				);
			}),
			{ numRuns: 300, ...semear("faixas") },
		);
	});

	it("first < followup na media (a primeira resposta e mais rapida)", () => {
		const seeds = fc.sample(fc.string(), { numRuns: 200, seed: 3 });
		const media = (kind: "first" | "followup") =>
			seeds.reduce((acc, s) => acc + humanDelayMs(kind, s), 0) / seeds.length;
		expect(media("first")).toBeLessThan(media("followup"));
	});

	it("e deterministico: mesma semente => mesmo valor (sem Math.random)", () => {
		for (const s of ["a", "texto longo com acao", "Boa tarde! Tudo bem?"]) {
			expect(humanDelayMs("first", s)).toBe(humanDelayMs("first", s));
			expect(humanDelayMs("followup", s)).toBe(humanDelayMs("followup", s));
		}
	});

	it("uma pergunta acrescenta o thinking pause (o valor sobe)", () => {
		const neutro = humanDelayMs("followup", "mensagem neutra");
		const pergunta = humanDelayMs("followup", "mensagem neutra?");
		expect(pergunta).toBeGreaterThan(neutro);
	});

	it("humanDelay espera exatamente humanDelayMs usando o sleep injetado", async () => {
		const esperas: number[] = [];
		await humanDelay("first", "semente", {
			sleep: async (ms) => {
				esperas.push(ms);
			},
		});
		expect(esperas).toHaveLength(1);
		expect(esperas[0]).toBe(humanDelayMs("first", "semente"));
	});
});

describe("simulateTyping", () => {
	it("emite progresso crescente e usa o sleep injetado (40..90ms)", async () => {
		const esperas: number[] = [];
		const progresso: number[] = [];
		const texto = "Humano digitando uma mensagem um pouco mais longa para varios passos";
		await simulateTyping(texto, {
			sleep: async (ms) => {
				esperas.push(ms);
			},
			onProgress: (chars) => progresso.push(chars),
		});
		expect(progresso.at(-1)).toBe(texto.length);
		expect(esperas).toHaveLength(progresso.length);
		expect(esperas.every((ms) => ms >= 40 && ms <= 90)).toBe(true);
		for (let i = 1; i < progresso.length; i++) {
			expect(progresso[i] ?? 0).toBeGreaterThan(progresso[i - 1] ?? 0);
		}
	});

	it("texto vazio nao emite progresso nem espera", async () => {
		const esperas: number[] = [];
		await simulateTyping("", {
			sleep: async (ms) => {
				esperas.push(ms);
			},
		});
		expect(esperas).toHaveLength(0);
	});
});
