/**
 * `src/domain/feriados-br.ts` — calendário de feriados BR local (D-09).
 *
 * Sem I/O e sem API externa: a lista é derivada de dados (fixos) e do algoritmo
 * de Páscoa (móveis). O override manual (`settings.calendar.holidays`) é
 * INJETADO por parâmetro pelo chamador — este módulo não toca banco, e é por
 * isso que `ehFeriado` recebe o conjunto como argumento.
 *
 * Contra o que se prova (Pitfall 8): um feriado móvel errado por 1 dia faz um
 * follow-up sair em feriado. Os valores de 2026 são a âncora do teste.
 */
import { describe, expect, it } from "vitest";
import {
	ehFeriado,
	feriadosMoveis,
	feriadosNacionais,
	pascoa,
} from "../../src/domain/feriados-br.js";

describe("feriados-br — Páscoa (algoritmo Gregoriano/Meeus)", () => {
	it("Páscoa 2026 = 05/04, com anos de conferência", () => {
		expect(pascoa(2026)).toBe("2026-04-05");
		expect(pascoa(2025)).toBe("2025-04-20");
		expect(pascoa(2024)).toBe("2024-03-31");
		expect(pascoa(2027)).toBe("2027-03-28");
	});
});

describe("feriados-br — móveis derivados da Páscoa (2026)", () => {
	it("Carnaval = Páscoa−47d = 17/02; Sexta Santa = Páscoa−2d = 03/04; Corpus Christi = Páscoa+60d = 04/06", () => {
		const moveis = feriadosMoveis(2026);
		expect(moveis).toContain("2026-02-17");
		expect(moveis).toContain("2026-04-03");
		expect(moveis).toContain("2026-06-04");
		// Carnaval tem DUAS terças-feiras (ou trasladação) — o móvel declarado é
		// a terça do Carnaval; a segunda quarta-feira também é feriado nacional.
		expect(moveis).not.toContain("2026-04-05"); // a Páscoa em si não é feriado
	});
});

describe("feriados-br — feriadosNacionais (fixos + móveis)", () => {
	it("contém os 9 fixos de 2026 e os móveis, em ISO YYYY-MM-DD", () => {
		const nacionais = feriadosNacionais(2026);
		for (const fixo of [
			"2026-01-01", // Confraternização
			"2026-04-21", // Tiradentes
			"2026-05-01", // Dia do Trabalho
			"2026-09-07", // Independência
			"2026-10-12", // N. Sra. Aparecida
			"2026-11-02", // Finados
			"2026-11-15", // Proclamação
			"2026-11-20", // Consciência Negra
			"2026-12-25", // Natal
		]) {
			expect(nacionais, `fixo ${fixo}`).toContain(fixo);
		}
		for (const movel of feriadosMoveis(2026)) {
			expect(nacionais).toContain(movel);
		}
		// 9 fixos + 3 móveis — nenhuma data repetida, nenhum extra fantasma.
		expect(new Set(nacionais).size).toBe(12);
		expect(nacionais).toHaveLength(12);
	});
});

describe("feriados-br — ehFeriado é puro e recebe o conjunto por parâmetro", () => {
	it("true dentro do conjunto, false fora e com lista vazia", () => {
		expect(ehFeriado("2026-04-05", ["2026-04-05"])).toBe(true);
		expect(ehFeriado("2026-04-06", ["2026-04-05"])).toBe(false);
		expect(ehFeriado("2026-10-12", [])).toBe(false);
		// Override manual (D-09): o chamador injeta datas extras.
		expect(ehFeriado("2026-08-11", ["2026-08-11"])).toBe(true);
	});

	it("funciona com Set<string> (forma que business-hours usa)", () => {
		expect(ehFeriado("2026-04-03", new Set(["2026-04-03"]))).toBe(true);
		expect(ehFeriado("2026-04-04", new Set(["2026-04-03"]))).toBe(false);
	});
});
