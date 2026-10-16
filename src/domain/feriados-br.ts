/**
 * Feriados nacionais brasileiros — local, puro, sem I/O (D-09).
 *
 * Três blocos:
 *   1. `pascoa(ano)` — algoritmo de Meeus (Gregoriano, válidos 1583–4099).
 *   2. `feriadosMoveis(ano)` — derivados da Páscoa: Carnaval (P−47d),
 *      Sexta-feira Santa (P−2d), Corpus Christi (P+60d).
 *   3. `feriadosNacionais(ano)` — fixos + móveis, em ISO `YYYY-MM-DD`.
 *
 * Por que local: o calendário de feriados BR é determinístico (dados + aritmética
 * de Páscoa). API externa adicionaria uma dependência de rede ao CAMPO MAIS
 * CRÍTICO do 03-01 — o cálculo de "quando um follow-up é permitido". Se a API
 * cair num domingo à noite, a fila não teria como decidir; se o algoritmo
 * estiver errado, o teste de 2026 (âncora) pega na hora.
 *
 * Override manual: `settings.calendar.holidays` é INJETADO por parâmetro pelo
 * chamador (`ehFeriado(data, feriados)`) — este módulo nunca toca banco nem
 * config. Datação feriada local = bug, não feature (Pitfall 8).
 */

/** Offset de dias entre a Páscoa e cada feriado móvel. */
const DIAS_ATE_CARNAVAL = -47; // terça de Carnaval (P−47)
const DIAS_ATE_SEXTA_SANTA = -2; // sexta-feira da Paixão (P−2)
const DIAS_ATE_CORPUS_CHRISTI = 60; // quinta-feira de Corpus Christi (P+60)

/**
 * Páscoa no calendário Gregoriano (algoritmo de Meeus/Jones/Butcher).
 * Retorna `YYYY-MM-DD`.
 */
export const pascoa = (ano: number): string => {
	const a = ano % 19;
	const b = Math.floor(ano / 100);
	const c = ano % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const mes = Math.floor((h + l - 7 * m + 114) / 31);
	const dia = ((h + l - 7 * m + 114) % 31) + 1;
	return `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
};

/** Data ISO somada dias de calendário (puro, UTC — só usa a parte de data). */
const maisDias = (iso: string, dias: number): string => {
	const [ano, mes, dia] = iso.split("-").map(Number);
	if (ano === undefined || mes === undefined || dia === undefined) {
		throw new Error(`data ISO invalida: ${iso}`);
	}
	const alvo = new Date(Date.UTC(ano, mes - 1, dia) + dias * 86_400_000);
	return alvo.toISOString().slice(0, 10);
};

/**
 * Feriados móveis de `ano` em ISO: Carnaval (terça), Sexta-feira Santa e
 * Corpus Christi. A quarta-feira de Cinzas NÃO entra: não é feriado nacional
 * (é ponto facultativo por convenção coletiva — fora do escopo da janela R-006).
 */
export const feriadosMoveis = (ano: number): string[] => {
	const p = pascoa(ano);
	return [
		maisDias(p, DIAS_ATE_CARNAVAL),
		maisDias(p, DIAS_ATE_SEXTA_SANTA),
		maisDias(p, DIAS_ATE_CORPUS_CHRISTI),
	];
};

/**
 * Feriados fixos nacionais (Lei 605/49; Consciência Negra pela Lei 14.759/23).
 * Nenhum item é incluído aqui sem âncora de teste em `feriados-br.test.ts`.
 */
const FIXOS: readonly string[] = [
	"01-01", // Confraternização Universal
	"04-21", // Tiradentes
	"05-01", // Dia do Trabalho
	"09-07", // Independência do Brasil
	"10-12", // Nossa Senhora Aparecida
	"11-02", // Finados
	"11-15", // Proclamação da República
	"11-20", // Dia Nacional de Zumbi e da Consciência Negra
	"12-25", // Natal
];

/**
 * Feriados nacionais de `ano` (fixos + móveis), em ISO `YYYY-MM-DD`,
 * ordenados por data. Sem duplicatas.
 */
export const feriadosNacionais = (ano: number): string[] => {
	const prefixo = `${String(ano).padStart(4, "0")}-`;
	const fixos = FIXOS.map((md) => `${prefixo}${md}`);
	return [...new Set([...fixos, ...feriadosMoveis(ano)])].sort();
};

/**
 * `dataIso` (`YYYY-MM-DD`) é feriado?
 *
 * O conjunto vem de FORA (`feriados` pode ser `readonly string[]` ou
 * `Set<string>`): o chamador decide se usa `feriadosNacionais(ano)` puro,
 * ou o override manual de `settings.calendar.holidays`. Puro e síncrono —
 * é o caminho que `business-hours` chama em loop.
 */
export const ehFeriado = (
	dataIso: string,
	feriados: Iterable<string>,
): boolean => {
	if (feriados instanceof Set) return feriados.has(dataIso);
	for (const f of feriados) if (f === dataIso) return true;
	return false;
};
