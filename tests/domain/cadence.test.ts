/**
 * `src/domain/cadence.ts` — o cálculo da próxima tentativa é PURO e ancorado no
 * último toque (D-01, Pitfall 2).
 *
 * O que este arquivo protege, em uma frase: **o tick compara, nunca reancora.**
 * Se `proximaTentativa` lesse `Date.now()`, o mesmo `(conversation, index)` teria
 * um `scheduled_for` diferente a cada 30s, o follow-up nunca venceria, e o
 * `follow_up_index` divergiria do real. O teste abaixo prova a independência do
 * relógio movendo o relógio do processo no meio do cálculo.
 */
import { describe, expect, it, vi } from "vitest";
import {
	cadenciaEncerrada,
	DELTAS_TOQUE,
	maxToques,
	proximaTentativa,
} from "../../src/domain/cadence.js";

const HORA = 3_600_000;
const DIA = 86_400_000;

const toque = new Date("2026-10-16T12:00:00.000Z");

describe("cadence — DELTAS_TOQUE (R-004/D-01)", () => {
	it("tem exatamente 4 deltas: 1h, 1d, 3d e 7d", () => {
		expect([...DELTAS_TOQUE]).toEqual([1 * HORA, 1 * DIA, 3 * DIA, 7 * DIA]);
		expect(DELTAS_TOQUE).toHaveLength(4);
	});

	it("NÃO existe delta de 15 dias (FLUP-03: o toque de 15d nunca executa)", () => {
		expect(DELTAS_TOQUE).not.toContain(15 * DIA);
		expect(Math.max(...DELTAS_TOQUE)).toBe(7 * DIA);
	});
});

describe("cadence — proximaTentativa ancorada em lastOutboundAt (Pitfall 2)", () => {
	it("soma o delta do índice: +1h, +1d, +3d, +7d", () => {
		expect(proximaTentativa(toque, 0).getTime()).toBe(
			toque.getTime() + 1 * HORA,
		);
		expect(proximaTentativa(toque, 1).getTime()).toBe(
			toque.getTime() + 1 * DIA,
		);
		expect(proximaTentativa(toque, 2).getTime()).toBe(
			toque.getTime() + 3 * DIA,
		);
		expect(proximaTentativa(toque, 3).getTime()).toBe(
			toque.getTime() + 7 * DIA,
		);
	});

	it("é determinística em (lastOutboundAt, index) — o relógio do processo é irrelevante", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
			const antes = proximaTentativa(toque, 1).toISOString();
			// Um mês depois: o tick roda de novo, mas o alvo do MESMO par não muda.
			vi.setSystemTime(new Date("2026-11-20T03:00:00.000Z"));
			const depois = proximaTentativa(toque, 1).toISOString();
			expect(depois).toBe(antes);
			expect(depois).toBe("2026-10-17T12:00:00.000Z");
		} finally {
			vi.useRealTimers();
		}
	});

	it("não muta o instante recebido (retorna um Date novo)", () => {
		const original = new Date(toque.getTime());
		proximaTentativa(toque, 3);
		expect(toque.getTime()).toBe(original.getTime());
	});

	it("índice fora da faixa (>= 4) lança — o 5º toque não existe", () => {
		expect(() => proximaTentativa(toque, 4)).toThrow();
		expect(() => proximaTentativa(toque, -1)).toThrow();
	});
});

describe("cadence — maxToques: default 4 e TETO DURO 4 (D-02/T-03-01)", () => {
	it("lê o valor de settings quando está na faixa 1..4", () => {
		expect(maxToques({ max_touches: 2 })).toBe(2);
		expect(maxToques({ max_touches: 4 })).toBe(4);
		expect(maxToques({ max_touches: 1 })).toBe(1);
	});

	it("clampa um settings abusivo em 4 — nunca aumenta o volume além de D-02", () => {
		expect(maxToques({ max_touches: 9 })).toBe(4);
		expect(maxToques({ max_touches: 999 })).toBe(4);
	});

	it("cai no default 4 quando ausente, vazio ou malformado", () => {
		expect(maxToques(undefined)).toBe(4);
		expect(maxToques(null)).toBe(4);
		expect(maxToques({})).toBe(4);
		expect(maxToques({ max_touches: null })).toBe(4);
		expect(maxToques({ max_touches: "3" })).toBe(4); // string não é número: fail-closed
		expect(maxToques({ max_touches: 0 })).toBe(4); // 0 tentativas não é uma cadência
		expect(maxToques({ max_touches: -3 })).toBe(4);
		expect(maxToques({ max_touches: 2.7 })).toBe(4); // não-inteiro: fail-closed
		expect(maxToques("lixo")).toBe(4);
		expect(maxToques(42)).toBe(4);
	});
});

describe("cadence — cadenciaEncerrada: o 4º toque é o último", () => {
	it("encerra somente quando index >= max", () => {
		expect(cadenciaEncerrada(0, 4)).toBe(false);
		expect(cadenciaEncerrada(3, 4)).toBe(false); // o 4º toque (índice 3) ainda sai
		expect(cadenciaEncerrada(4, 4)).toBe(true); // índice 4 já é o vencido de 7d
		expect(cadenciaEncerrada(5, 4)).toBe(true);
	});

	it("respeita um max menor (settings max_touches=2)", () => {
		expect(cadenciaEncerrada(1, 2)).toBe(false);
		expect(cadenciaEncerrada(2, 2)).toBe(true);
	});
});
