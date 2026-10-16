/**
 * Cadência de follow-up (R-004/R-005, D-01/D-02): o cálculo PURO de "quando é
 * a próxima tentativa".
 *
 * **A âncora é o último toque, nunca o relógio.** `proximaTentativa` recebe
 * `lastOutboundAt` explicitamente e não contém `Date.now()` em nenhum caminho:
 * o tick do scheduler compare `proximaTentativa <= now`, e a comparação é a
 * única coisa que o tempo real influencia (Pitfall 2). Se o tick REANCORASSE em
 * `now()`, o mesmo `(conversation, index)` teria um `scheduled_for` novo a cada
 * 30s, o alvo nunca venceria, e o `follow_up_index` divergiria do que de fato
 * foi enviado.
 *
 * **Quatro tentativas, e o 15º dia não existe.** A cadência é `1h → 1d → 3d →
 * 7d` (ADR-009: "1 semana já basta"); o teto de 4 toques encerra a cadência no
 * 7º dia. Não há delta de 15 dias — um valor a mais aqui seria um follow-up que
 * o ADR-009 proíbe (FLUP-03).
 *
 * Sem I/O: o módulo é importável pelo scheduler, pelo painel e pelo teste sem
 * banco, sem fuso e sem rede.
 */

const HORA_MS = 3_600_000;
const DIA_MS = 86_400_000;

/**
 * Deltas de cada toque, em ms, na ordem em que saem (R-004): 1h, 1d, 3d, 7d.
 * `readonly as const` para o índice virar literal e o teste provar o tamanho.
 */
export const DELTAS_TOQUE = [
	1 * HORA_MS,
	1 * DIA_MS,
	3 * DIA_MS,
	7 * DIA_MS,
] as const;

/** Teto duro de tentativas (D-02). Nem settings pode aumentar isto. */
export const MAX_TOQUES_TETO = 4;
/** Default quando `settings.followup.max_touches` está ausente ou malformado. */
export const MAX_TOQUES_DEFAULT = 4;

/**
 * Instante da tentativa de índice `index` = `lastOutboundAt + DELTAS_TOQUE[index]`.
 *
 * `index` é o `conversations.follow_up_index` — o contador de toques JÁ
 * enviados. Índice `>= 4` não tem delta (o 5º toque não existe): lançar é
 * fail-closed, porque devolver um instante inventado agendaria uma tentativa
 * proibida. O chamador deve consultar `cadenciaEncerrada(index, max)` antes.
 */
export const proximaTentativa = (lastOutboundAt: Date, index: number): Date => {
	const delta = DELTAS_TOQUE[index];
	if (delta === undefined) {
		throw new Error(
			`indice de toque fora da cadencia: ${index} (DELTAS_TOQUE tem ${DELTAS_TOQUE.length} entradas)`,
		);
	}
	return new Date(lastOutboundAt.getTime() + delta);
};

/**
 * Quantos toques esta conversa permite: `settings.followup.max_touches`,
 * com default 4 e TETO DURO 4 (D-02, T-03-01).
 *
 * O `settings` é `jsonb` mutável em runtime — dado não confiável na forma.
 * Qualquer coisa que não seja inteiro em `1..4` cai no default 4, inclusive
 * valores que *aumentariam* o volume (9, 999): o teto existe para limitar risco
 * de banimento, então errar para menos toques é seguro e errar para mais não é
 * uma opção. Isto é um clamp, não uma validação que rejeita config.
 */
export const maxToques = (settingsValue: unknown): number => {
	if (
		typeof settingsValue !== "object" ||
		settingsValue === null ||
		Array.isArray(settingsValue)
	) {
		return MAX_TOQUES_DEFAULT;
	}
	const bruto = (settingsValue as { max_touches?: unknown }).max_touches;
	if (
		typeof bruto !== "number" ||
		!Number.isInteger(bruto) ||
		bruto < 1 ||
		bruto > MAX_TOQUES_TETO
	) {
		return MAX_TOQUES_DEFAULT;
	}
	return bruto;
};

/**
 * A cadência desta conversa acabou? Verdadeiro quando o cursor já alcançou o
 * teto — o índice `max` é o PRÓXIMO toque, que não existe.
 *
 * Com `max = 4`: índices 0..3 ainda saem (o 4º toque, de 7d, é o último) e o
 * índice 4 encerra. É este predicado que o scheduler consulta antes de chamar
 * `proximaTentativa` — e é o que impede o toque de 15 dias de existir.
 */
export const cadenciaEncerrada = (index: number, max: number): boolean =>
	index >= max;
