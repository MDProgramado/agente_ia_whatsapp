/**
 * A janela operacional (AR-007 / R-006 / R-058): dias úteis, 7h–17h.
 *
 * Módulo separado e sem I/O porque a mesma pergunta é feita em dois lugares: o
 * guard AR-007 decide, e a fila pergunta "quando reprocessar?". Se fosse código
 * inline no guard, os dois divergiriam com o tempo.
 *
 * **A janela é do negócio, não da máquina.** Se o código usasse `getHours()`,
 * o mesmo instante aprobaria ou barraria dependendo do TZ do processo. Tudo aqui
 * formata explicitamente no fuso recebido.
 */

import { ehFeriado } from "./feriados-br.js";

const WEEKDAY_INDEX: Record<string, number> = {
	Sun: 0,
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
};

const partesEmZona = (
	instante: Date,
	tz: string,
): {
	ano: number;
	mes: number;
	dia: number;
	hora: number;
	minuto: number;
	segundo: number;
	diaDaSemana: number;
} => {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		weekday: "short",
		hourCycle: "h23",
	});
	const partes = fmt.formatToParts(instante);
	const n = (tipo: Intl.DateTimeFormatPartTypes) =>
		Number(partes.find((p) => p.type === tipo)?.value ?? "0");
	const t = (tipo: Intl.DateTimeFormatPartTypes) =>
		partes.find((p) => p.type === tipo)?.value ?? "";
	return {
		ano: n("year"),
		mes: n("month"),
		dia: n("day"),
		hora: n("hour"),
		minuto: n("minute"),
		segundo: n("second"),
		diaDaSemana: WEEKDAY_INDEX[t("weekday")] ?? -1,
	};
};

/** `0` → `00`, `7` → `07` — só a parte de data/hora, sem arredondamento. */
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Data local (`YYYY-MM-DD`) de `instante` no fuso `tz`. */
const dataEmZona = (instante: Date, tz: string): string => {
	const { ano, mes, dia } = partesEmZona(instante, tz);
	return `${ano}-${pad2(mes)}-${pad2(dia)}`;
};

/**
 * É dia útil? Sábado/domingo fora; com `feriados` (D-09) a data local também
 * é conferida contra a lista injetada — parâmetro opcional para preservar a
 * assinatura e o comportamento dos guards da Fase 1/2.
 */
export const ehDiaUtil = (
	instante: Date,
	tz: string,
	feriados: readonly string[] = [],
): boolean => {
	const { diaDaSemana } = partesEmZona(instante, tz);
	if (diaDaSemana < 1 || diaDaSemana > 5) return false;
	if (feriados.length === 0) return true;
	return !ehFeriado(dataEmZona(instante, tz), feriados);
};

/**
 * Janela **half-open** `[inicio, fim)`: 7h00 entra, 17h00 não.
 *
 * O half-open não é detalhe: com `fim` inclusivo, uma mensagem disparada às
 * 17h00:00 entraria e outra às 17h00:30 não — a fronteira viraria uma decisão
 * de sub-segundo. Com `[inicio, fim)`, 16h59:59 é o último instante aceito.
 */
export const isWithinWindow = (
	instante: Date,
	tz: string,
	inicio: number,
	fim: number,
): boolean => {
	const { hora, minuto } = partesEmZona(instante, tz);
	const minutosDoDia = hora * 60 + minuto;
	return minutosDoDia >= inicio * 60 && minutosDoDia < fim * 60;
};

/** `HH:MM` no fuso do negócio — para a fila calcular o próximo instante válido. */
export const formatarHoraLocal = (instante: Date, tz: string): string => {
	const { hora, minuto } = partesEmZona(instante, tz);
	return `${String(hora).padStart(2, "0")}:${String(minuto).padStart(2, "0")}`;
};

/** Janela completa, já combinada: dia útil E dentro do horário. */
export const dentroDaJanelaOperacional = (
	instante: Date,
	tz: string,
	inicio: number,
	fim: number,
): boolean =>
	ehDiaUtil(instante, tz) && isWithinWindow(instante, tz, inicio, fim);

/**
 * Constrói o instante UTC que corresponde a `ano-mes-dia hora:00` **no fuso**.
 *
 * Duas passadas: assume que o horário local é UTC, mede o offset naquele ponto e
 * corrige. A segunda passada resolve o caso em que o offset do horário-alvo
 * difere do offset do palpite inicial (virada de horário de verão). Espelha o
 * `instanteEmZona` dos fixtures de teste.
 */
const instanteLocal = (
	tz: string,
	ano: number,
	mes: number,
	dia: number,
	hora: number,
): Date => {
	const alvo = Date.UTC(ano, mes - 1, dia, hora, 0, 0);
	const primeira = partesEmZona(new Date(alvo), tz);
	const comoUtc = Date.UTC(
		primeira.ano,
		primeira.mes - 1,
		primeira.dia,
		primeira.hora,
		primeira.minuto,
		primeira.segundo,
	);
	return new Date(alvo - (comoUtc - alvo));
};

/**
 * Início da próxima janela **estritamente depois** de `instante` (AR-007/R-006).
 *
 * Usado pelo dreno da fila para reprogramar uma mensagem que bateu na janela:
 *   - dia útil antes de `inicio` → hoje às `inicio`;
 *   - qualquer outro caso (fim de semana, feriado, depois de `inicio`,
 *     madrugada) → o próximo dia útil às `inicio`. Sexta depois da janela cai
 *     na segunda; se a segunda é feriado (D-09), na terça.
 *
 * `feriados` é opcional e vem de fora (`feriadosNacionais(ano)` e/ou override
 * manual de settings) — funções puras, nenhuma leitura de banco aqui.
 *
 * O retorno é um instante UTC real; `formatarHoraLocal` dele devolve `inicio`.
 */
export const nextWindow = (
	instante: Date,
	tz: string,
	inicio: number,
	fim: number,
	feriados: readonly string[] = [],
): Date => {
	if (fim <= inicio) {
		throw new Error(`janela invalida: [${inicio}, ${fim})`);
	}
	const p = partesEmZona(instante, tz);
	const hojeInicio = instanteLocal(tz, p.ano, p.mes, p.dia, inicio);
	if (
		p.diaDaSemana >= 1 &&
		p.diaDaSemana <= 5 &&
		!ehFeriado(dataEmZona(instante, tz), feriados) &&
		hojeInicio.getTime() > instante.getTime()
	) {
		return hojeInicio;
	}
	// Calendário em passos de 1 dia civil (UTC) a partir da data local atual;
	// o offset de fuso não importa porque só lemos a parte de data. O teto de
	// 14 dias cobre qualquer sequência real de feriados + fim de semana (e
	// feriados manuais adjacente a um feriado nacional).
	const baseCivil = Date.UTC(p.ano, p.mes - 1, p.dia);
	let salto = 1;
	while (salto <= 14) {
		const dia = new Date(baseCivil + salto * 86_400_000);
		const diaDaSemana = dia.getUTCDay();
		const ehUtil =
			diaDaSemana >= 1 &&
			diaDaSemana <= 5 &&
			!ehFeriado(dia.toISOString().slice(0, 10), feriados);
		if (ehUtil) break;
		salto += 1;
	}
	const alvo = new Date(baseCivil + salto * 86_400_000);
	return instanteLocal(
		tz,
		alvo.getUTCFullYear(),
		alvo.getUTCMonth() + 1,
		alvo.getUTCDate(),
		inicio,
	);
};

/**
 * Primeiro dia útil com `inicio:00` **estritamente depois** de `instante`,
 * no fuso `tz` (D-10).
 *
 * `proximoDiaUtil(quinta18h, tz, ["2026-04-03"])` → segunda 07:00: pula a
 * sexta-feira feriada, sábado e domingo. Antes de `inicio` no próprio dia útil
 * → devolve o próprio dia às `inicio` (é o próximo instante futuro válido).
 *
 * Lança se nenhum dia útil aparecer em 14 dias — condição impossível com
 * feriados reais, mas fail-closed em vez de devolver um dia inválido.
 */
export const proximoDiaUtil = (
	instante: Date,
	tz: string,
	feriados: readonly string[] = [],
	inicio = 7,
): Date => {
	const p = partesEmZona(instante, tz);
	const baseCivil = Date.UTC(p.ano, p.mes - 1, p.dia);
	for (let salto = 0; salto <= 14; salto += 1) {
		const dia = new Date(baseCivil + salto * 86_400_000);
		const diaDaSemana = dia.getUTCDay();
		if (diaDaSemana < 1 || diaDaSemana > 5) continue;
		if (ehFeriado(dia.toISOString().slice(0, 10), feriados)) continue;
		const alvo = instanteLocal(
			tz,
			dia.getUTCFullYear(),
			dia.getUTCMonth() + 1,
			dia.getUTCDate(),
			inicio,
		);
		if (alvo.getTime() > instante.getTime()) return alvo;
	}
	throw new Error(
		`nenhum dia util com inicio ${inicio}h nas proximas 14 dias a partir de ${instante.toISOString()}`,
	);
};
