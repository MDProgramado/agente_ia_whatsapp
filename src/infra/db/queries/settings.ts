/**
 * Leitura das chaves de `settings` que a Fase 3 consome (D-02/D-09).
 *
 * `settings` é `jsonb` mutável em runtime — dado **não confiável na forma**. O
 * padrão deste módulo é: desempacotar com `value #>> '{}'` (jsonb → texto do
 * escalar, o mesmo idioma que o `snapshot.ts` usa para o kill switch —
 * Pitfall 10) e, para valores de forma variável (a lista de feriados), deixar o
 * driver parsear o jsonb e **validar a forma aqui**. Valor malformado é
 * IGNORADO (cai no default), nunca derruba o tick (T-03-02) — um `settings`
 * editado à mão não pode parar a operação.
 *
 * Quem consome: o scheduler (03-02) no boot (`lerFeriadosOverride` +
 * `lerMaxToques`) e o painel (03-03).
 */
import { inArray, sql } from "drizzle-orm";
import { maxToques } from "../../../domain/cadence.js";
import type { Db } from "../client.js";
import { settings } from "../schema.js";

/** `settings.followup.max_touches` — o teto de toques por conversa (D-02). */
export const CHAVE_MAX_TOQUES = "followup.max_touches";
/** `settings.calendar.holidays` — datas extras em ISO, além das nacionais (D-09). */
export const CHAVE_FERIADOS = "calendar.holidays";

/** Só `YYYY-MM-DD` de verdade entra na lista de feriados. */
const ISO_DIA = /^\d{4}-\d{2}-\d{2}$/;

/** Um valor de `settings`: o jsonb parseado e o escalar já desempacotado. */
export interface ValorSetting {
	/** O jsonb como o driver o entregou (escalar, array ou objeto). */
	readonly bruto: unknown;
	/** `value #>> '{}'` — o escalar como texto; `null` se o valor não for escalar. */
	readonly texto: string | null;
}

/**
 * Lê as `keys` pedidas em UMA instrução. Chave ausente simplesmente não aparece
 * no `Map` — o chamador decide o default, e é isso que mantém "ausente" e
 * "presente mas inválido" distinguíveis para quem precisa.
 */
export const lerSettings = async (
	db: Db,
	keys: readonly string[],
): Promise<Map<string, ValorSetting>> => {
	if (keys.length === 0) return new Map();
	const linhas = await db
		.select({
			key: settings.key,
			bruto: settings.value,
			texto: sql<string | null>`${settings.value} #>> '{}'`,
		})
		.from(settings)
		.where(inArray(settings.key, [...keys]));
	return new Map(
		linhas.map((l) => [l.key, { bruto: l.bruto, texto: l.texto }] as const),
	);
};

/**
 * Teto de toques configurado, já clampado em `1..4` por `maxToques` (D-02).
 *
 * Aceita as duas formas que um operador pode ter gravado: o objeto
 * `{"max_touches": 2}` (forma do plano) e o número cru `2`. Qualquer outra
 * coisa — inclusive `"2"` como string, que seria uma forma ambígua — cai no
 * default 4: errar para menos toques é seguro, errar para mais não é opção.
 */
export const lerMaxToques = async (db: Db): Promise<number> => {
	const lidos = await lerSettings(db, [CHAVE_MAX_TOQUES]);
	const bruto = lidos.get(CHAVE_MAX_TOQUES)?.bruto;
	if (typeof bruto === "number") return maxToques({ max_touches: bruto });
	return maxToques(bruto);
};

/**
 * Datas extras de feriado (`settings.calendar.holidays`), em ISO, sem
 * duplicatas e ordenadas. Fora de forma → `[]`, nunca exceção (T-03-02).
 *
 * Só datas ISO válidas passam; uma entrada `"25/12"` ou um número são
 * descartados silenciosamente, e o sistema volta ao calendário nacional em vez
 * de operar com um feriado inventado.
 */
export const lerFeriadosOverride = async (
	db: Db,
): Promise<readonly string[]> => {
	const lidos = await lerSettings(db, [CHAVE_FERIADOS]);
	const bruto = lidos.get(CHAVE_FERIADOS)?.bruto;
	if (!Array.isArray(bruto)) return [];
	const validos = bruto.filter(
		(d): d is string => typeof d === "string" && ISO_DIA.test(d),
	);
	return [...new Set(validos)].sort();
};
