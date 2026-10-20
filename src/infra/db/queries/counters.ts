/**
 * Cotas diárias reservadas atomicamente (AR-008 / R-023, e a trava de novos contatos
 * de D-04/D-05).
 *
 * **A operação é uma só.** `INSERT … ON CONFLICT DO UPDATE … WHERE count < teto
 * RETURNING count` faz checar-e-reservar em uma única instrução atômica. A
 * alternativa ingênua — `SELECT count`, depois `UPDATE` — é um TOCTOU: dois
 * workers leem 24, ambos veem espaço, ambos escrevem, e o dia fecha em 26. Com a
 * versão de uma instrução, o segundo `INSERT` serializa atrás do primeiro e a
 * cláusula `WHERE count < teto` falha, devolvendo `allowed: false`.
 *
 * **`WHERE` fica no `DO UPDATE`, não no `WHERE` do `SELECT`.** Isso é o que faz a
 * reserva ser condicional: um `ON CONFLICT DO UPDATE` sem `WHERE` engoliria a
 * tentativa e devolveria a linha com o contador antigo, e o gate acreditaria que a
 * cota foi reservada quando nada foi reservado.
 *
 * `teto = min(configuredLimit, cap)` implementa D-04/D-05. O `cap` vem do
 * servidor (`fetchNewChatMessageCap`); quando ele vem `0` — feature desativada
 * para a conta — o resultado é `allowed: false` e o sistema **para**. Nunca
 * degrada para envio ilimitado, que é o modo de falha que o cap existe para
 * impedir.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { dailyCounters } from "../schema.js";

/** `count` incorrente e se a reserva passou; `used = -1` quando `allowed` é falso. */
export interface Reserva {
	readonly allowed: boolean;
	readonly used: number;
	readonly limit: number;
}

/**
 * Os valores têm de ser EXATAMENTE os do `daily_counters_kind_check`
 * (`CHECK (kind IN ('sent', 'new_contacts'))`, `0000_initial.sql`). Estavam como
 * `'mensagem'`/`'novo_contato'`, que violam o CHECK: toda reserva morria no
 * INSERT — e `readQuota` (01-03) lê `kind = 'sent'`. Corrigido como [Rule 1] no
 * 01-03; ver SUMMARY.
 */
const kinds = {
	mensagem: "sent",
	novo_contato: "new_contacts",
} as const;

export type DailyCounterKind = (typeof kinds)[keyof typeof kinds];

/**
 * Lê UM contador do dia SEM reservar — a leitura fresca que o gate precisa.
 *
 * `newContactsToday` NÃO pode ser lido uma vez no boot: leads novos entram o
 * dia inteiro, e um valor congelado faria o gate avaliar o dia com o contador
 * do instante de subida do processo. Ausência da linha devolve 0 — dia sem
 * movimento não é falha.
 */
export const readDailyCounter = async (
	db: Db,
	day: string,
	kind: DailyCounterKind,
): Promise<number> => {
	const resultado = await db.execute(sql`
		select count from ${dailyCounters}
		where day = ${day} and kind = ${kind}
	`);
	const rows = (resultado as unknown as { rows: { count: number | string }[] })
		.rows;
	return Number(rows[0]?.count ?? 0);
};

/**
 * Uma única instrução, sem transação explícita e sem `SKIP LOCKED`.
 *
 * Não precisa de `FOR UPDATE`: o próprio `ON CONFLICT` serializa por conflict
 * target, e `SKIP LOCKED` seria ativamente **errado** aqui — pular a linha
 * lacrada devolveria um contador velho e o gate liberaria envio acima da cota. O
 * `SKIP LOCKED` do `outbox` (01-03) resolve outro problema, o de vários workers
 * competirem pela mesma linha de trabalho.
 */
async function reservar(
	db: Db,
	kind: DailyCounterKind,
	day: string,
	configuredLimit: number,
	cap: number,
): Promise<Reserva> {
	// `cap` negativo seria lixo de config; normalizar para 0 mantém a semântica
	// fail-closed de "cap = 0 significa parado" em vez de um teto negativo que
	// passaria qualquer comparison.
	const limit = Math.min(configuredLimit, Math.max(cap, 0));

	const resultado = await db.execute(sql`
		insert into ${dailyCounters} (day, kind, count)
		values (${day}, ${kind}, 1)
		on conflict (day, kind) do update
			set count = ${dailyCounters.count} + 1
			where ${dailyCounters.count} < ${limit}
		returning count
	`);

	// `db.execute` no node-postgres devolve um QueryResult; o valor vive em `.rows`.
	const rows = (resultado as unknown as { rows: { count: number }[] }).rows;
	const primeira = rows[0];

	// 0 linhas retornadas = a cláusula `WHERE` barrou a reserva = cota cheia.
	if (!primeira) return { allowed: false, used: -1, limit };

	return { allowed: true, used: primeira.count, limit };
}

/** Cota de mensagens enviadas (R-023: 20–30/dia, no piloto 25 operacional, 30 teto). */
export const reserveMessageQuota = (
	db: Db,
	day: string,
	configuredLimit: number,
	cap: number,
): Promise<Reserva> => reservar(db, kinds.mensagem, day, configuredLimit, cap);

/** Cota de contatos novos iniciados pela automação (D-04/D-05). */
export const reserveNewContactQuota = (
	db: Db,
	day: string,
	configuredLimit: number,
	cap: number,
): Promise<Reserva> =>
	reservar(db, kinds.novo_contato, day, configuredLimit, cap);
