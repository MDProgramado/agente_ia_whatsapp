/**
 * `src/domain/business-hours.ts` — a janela operacional isolada e testável.
 *
 * Fica em módulo próprio, sem dependência de I/O, porque a mesma pergunta é feita
 * em dois lugares: o guard AR-007 (decidir) e a fila (quando reprocessar). Se fosse
 * código inline dentro do guard, as duas perguntas divergiriam com o tempo.
 */
import { describe, expect, it } from "vitest";
import {
	ehDiaUtil,
	formatarHoraLocal,
	isWithinWindow,
	nextWindow,
	proximoDiaUtil,
} from "../../src/domain/business-hours.js";
import { instanteEmZona } from "../gate/fixtures.js";

const TZ = "America/Sao_Paulo";
const emSP = (dia: number, hora: number, minuto = 0) =>
	instanteEmZona(TZ, 2026, 9, dia, hora, minuto);

describe("business-hours — janela de dias úteis 7h–17h", () => {
	it("aceita os dias úteis dentro da janela", () => {
		for (const dia of [21, 22, 23, 24, 25, 28, 29, 30]) {
			expect(ehDiaUtil(emSP(dia, 12), TZ), `2026-09-${dia} 12h`).toBe(true);
		}
	});

	it("rejeita sábado e domingo", () => {
		expect(ehDiaUtil(emSP(26, 12), TZ)).toBe(false); // sábado
		expect(ehDiaUtil(emSP(27, 12), TZ)).toBe(false); // domingo
	});

	it("trata a janela como [7, 17): 6h59 e 17h00 ficam de fora", () => {
		expect(isWithinWindow(emSP(29, 6, 59), TZ, 7, 17)).toBe(false);
		expect(isWithinWindow(emSP(29, 7, 0), TZ, 7, 17)).toBe(true);
		expect(isWithinWindow(emSP(29, 16, 59), TZ, 7, 17)).toBe(true);
		expect(isWithinWindow(emSP(29, 17, 0), TZ, 7, 17)).toBe(false);
		expect(isWithinWindow(emSP(29, 23, 59), TZ, 7, 17)).toBe(false);
	});

	it("o meio-dia de São Paulo continua meio-dia com a máquina em UTC", () => {
		// 12h em São Paulo = 15hZ. Se alguém usasse a hora local do processo, isto
		// viraria 15hUTC e a janela mudaria de tamanho ao longo do dia.
		const meioDia = emSP(29, 12);
		expect(meioDia.toISOString()).toBe("2026-09-29T15:00:00.000Z");
		expect(formatarHoraLocal(meioDia, TZ)).toBe("12:00");
	});

	it("aceita a janela como parâmetros, sem hardcode", () => {
		// 7h–17h é a do plano, mas o parâmetro existe para o 01-05 mover a janela sem
		// editar o guard.
		expect(isWithinWindow(emSP(29, 9), TZ, 7, 12)).toBe(true);
		expect(isWithinWindow(emSP(29, 13), TZ, 7, 12)).toBe(false);
	});
});

/**
 * Fase 3 (D-09/D-10): `ehDiaUtil`/`nextWindow` passam a considerar feriado
 * nacional brasileiro, e `proximoDiaUtil` devolve o próximo dia útil às 07:00
 * no fuso da conversa. Feriados entram por PARÂMETRO (função pura, sem I/O).
 */
describe("business-hours — feriados BR (D-09) e próximo dia útil 07:00 (D-10)", () => {
	// Sexta-feira Santa 2026 (03/04) — sexta; N. Sra. Aparecida 2026 (12/10) — segunda.
	const FERIADOS_2026_ABRIL = ["2026-04-03"];
	const FERIADOS_2026_OUTUBRO = ["2026-10-12"];

	it("ehDiaUtil: sábado false, segunda comum true, feriado FIXO false (com a lista injetada)", () => {
		expect(ehDiaUtil(instanteEmZona(TZ, 2026, 10, 17, 12), TZ)).toBe(false); // sábado
		expect(ehDiaUtil(instanteEmZona(TZ, 2026, 10, 19, 12), TZ)).toBe(true); // segunda comum
		// 12/10/2026 É segunda — sem a lista seria "dia útil" de semana cheia.
		expect(
			ehDiaUtil(
				instanteEmZona(TZ, 2026, 10, 12, 12),
				TZ,
				FERIADOS_2026_OUTUBRO,
			),
		).toBe(false);
		// Sexta-feira Santa (03/04/2026).
		expect(
			ehDiaUtil(
				instanteEmZona(TZ, 2026, 4, 3, 12),
				TZ,
				FERIADOS_2026_ABRIL,
			),
		).toBe(false);
		// O parâmetro é opcional: sem ele, o comportamento antigo permanece.
		expect(ehDiaUtil(instanteEmZona(TZ, 2026, 4, 3, 12), TZ)).toBe(true);
	});

	it("proximoDiaUtil: sexta 17h01 → segunda 07:00", () => {
		const sexta1701 = instanteEmZona(TZ, 2026, 10, 16, 17, 1);
		const alvo = proximoDiaUtil(sexta1701, TZ);
		expect(alvo.getTime()).toBe(
			instanteEmZona(TZ, 2026, 10, 19, 7, 0).getTime(),
		);
		expect(formatarHoraLocal(alvo, TZ)).toBe("07:00");
	});

	it("proximoDiaUtil: quinta véspera de feriado na sexta → pula o feriado e cai na segunda 07:00", () => {
		const quinta = instanteEmZona(TZ, 2026, 4, 2, 18, 0);
		const alvo = proximoDiaUtil(quinta, TZ, FERIADOS_2026_ABRIL);
		expect(alvo.getTime()).toBe(
			instanteEmZona(TZ, 2026, 4, 6, 7, 0).getTime(),
		);
		expect(formatarHoraLocal(alvo, TZ)).toBe("07:00");
	});

	it("proximoDiaUtil: no máximo 7 dias à frente e sempre a um dia útil real", () => {
		// De uma segunda qualquer até o próximo feriado de segunda (12/10): o
		// retorno nunca pode ser 12/10.
		const segunda = instanteEmZona(TZ, 2026, 10, 9, 18, 0); // sexta 09/10 18h
		const alvo = proximoDiaUtil(segunda, TZ, FERIADOS_2026_OUTUBRO);
		expect(alvo.getTime()).toBe(
			instanteEmZona(TZ, 2026, 10, 13, 7, 0).getTime(),
		);
	});

	it("nextWindow sem feriados (assinatura atual preservada): sexta pós-janela → segunda 07:00", () => {
		const sexta1701 = instanteEmZona(TZ, 2026, 10, 16, 17, 1);
		const alvo = nextWindow(sexta1701, TZ, 7, 17);
		expect(alvo.getTime()).toBe(
			instanteEmZona(TZ, 2026, 10, 19, 7, 0).getTime(),
		);
	});

	it("nextWindow com feriados: sexta pós-janela, segunda é feriado → terça 07:00", () => {
		const sexta1701 = instanteEmZona(TZ, 2026, 10, 9, 17, 1);
		const alvo = nextWindow(sexta1701, TZ, 7, 17, FERIADOS_2026_OUTUBRO);
		expect(alvo.getTime()).toBe(
			instanteEmZona(TZ, 2026, 10, 13, 7, 0).getTime(),
		);
		expect(formatarHoraLocal(alvo, TZ)).toBe("07:00");
	});
});
