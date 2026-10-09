/**
 * O choke-point do R-001 — prova end-to-end que o primeiro contato não-humano
 * bloqueia **no dispatcher**, grava a trilha de negativos e **não** chama
 * `sendText` nem consome cota.
 *
 * O teste de grep (`tests/lint/choke-point.grep.test.ts`) prova que não existe
 * outro caminho de `sendText`. Este prova que o caminho único realmente barra.
 *
 * Roda numa transação revertida (ver nota em `outbox.test.ts`): `messages` é
 * append-only e `leads` não pode ser deletado, então a limpeza é por rollback.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type DispatchDeps,
	dispatch,
} from "../../src/application/dispatcher.js";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import {
	criarFakeChannel,
	type EnvioFake,
} from "../../src/infra/fake-channel.js";
import { instanteEmZona, TZ } from "../gate/fixtures.js";

/** Terça 29/09/2026 13h SP — dentro da janela. */
const DENTRO_DA_JANELA = instanteEmZona(TZ, 2026, 9, 29, 13, 0);

const TEXTO_NEUTRO = "Boa tarde! Posso ajudar em alguma coisa?";

const CTX: DispatchDeps["ctx"] = {
	tz: env.TZ,
	windowStartHour: env.WINDOW_START_HOUR,
	windowEndHour: env.WINDOW_END_HOUR,
	dailyMessageLimit: env.DAILY_MESSAGE_LIMIT,
	dailyMessageCap: 30,
	newContactsToday: 0,
};

const SENTINELA = "rollback-intencional-do-teste";

const rows = <T>(resultado: unknown): T[] => (resultado as { rows: T[] }).rows;

const primeiro = <T>(lista: readonly T[]): T => {
	const [item] = lista;
	if (item === undefined) throw new Error("esperava ao menos uma linha");
	return item;
};

const chaveDia = (d: Date): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(d);

const emTransacaoRevertida = async (
	fn: (tx: Db) => Promise<void>,
): Promise<void> => {
	try {
		await db.transaction(async (tx) => {
			await fn(tx as unknown as Db);
			throw new Error(SENTINELA);
		});
	} catch (erro) {
		if (!(erro instanceof Error) || erro.message !== SENTINELA) throw erro;
	}
};

const inserirConta = async (db: Db): Promise<string> => {
	await db.execute(sql`
		INSERT INTO channel_accounts (phone_e164, display_name)
		VALUES (${env.CHANNEL_PHONE_E164}, 'teste-choke-point')
		ON CONFLICT (phone_e164) DO NOTHING
	`);
	const r = await db.execute(sql`
		SELECT id FROM channel_accounts WHERE phone_e164 = ${env.CHANNEL_PHONE_E164}
	`);
	const id = rows<{ id: string }>(r)[0]?.id;
	if (!id) throw new Error("conta de teste nao encontrada");
	return id;
};

const inserirLead = async (db: Db, telefone: string): Promise<string> => {
	// `first_contact_by_human = false`: a violação sob teste é o Guard 0 (R-001).
	const r = await db.execute(sql`
		INSERT INTO leads (
			phone_number, origin_source, legal_basis, purpose,
			legal_registered_at, first_contact_by_human, wa_validation_state
		)
		VALUES (
			${telefone}, 'teste', 'legitimo_interesse', 'prospeccao',
			'2025-01-01T12:00:00Z', false, 'VALIDO'
		)
		RETURNING id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

const inserirConversa = async (
	db: Db,
	leadId: string,
	contaId: string,
): Promise<string> => {
	const r = await db.execute(sql`
		INSERT INTO conversations (lead_id, channel_account_id, state, engagement_mode)
		VALUES (${leadId}, ${contaId}, 'novo', 'bot_active')
		RETURNING id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

let conn: OpenDb;
let db: Db;

beforeAll(async () => {
	conn = await openDb(env.DATABASE_URL);
	db = conn.db;
});

afterAll(async () => {
	await closeDb(conn);
});

describe("dispatcher — choke-point R-001 (T-01-20)", () => {
	it("primeiro contato não-humano: bloqueia, grava 1 negativo, zero sendText, zero cota", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, `+55${Date.now() % 10_000_000_000}`);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			const enviados: EnvioFake[] = [];
			const channel = criarFakeChannel(new Map(), enviados);
			const deps: DispatchDeps = { db: tx, channel, ctx: CTX };

			// 1ª chamada: o bloqueio, com a trilha de auditoria.
			const r1 = await dispatch(deps, {
				conversationId: conversaId,
				text: TEXTO_NEUTRO,
				now: DENTRO_DA_JANELA,
				idempotencyKey: `cp-${randomUUID()}`,
			});
			expect(r1).toMatchObject({
				action: "blocked",
				reason: "r001_primeiro_contato_nao_humano",
			});

			// A AC do plano diz "guard = 'r001_primeiro_contato_nao_humano'", mas a
			// coluna `guard` carrega a grafia do REQUISITO ('R-001'); o GateReason vive
			// em `rule_reference`. O comportamento conferido é o do schema (o trigger
			// deriva `guard` de `rule_reference`) — ver desvio no SUMMARY.
			const negativos = rows<{ guard: string; rule_reference: string }>(
				await tx.execute(sql`
					SELECT guard, rule_reference FROM blocked_attempts
					WHERE conversation_id = ${conversaId}
				`),
			);
			expect(negativos).toHaveLength(1);
			expect(primeiro(negativos)).toMatchObject({
				guard: "R-001",
				rule_reference: "r001_primeiro_contato_nao_humano",
			});

			// 4 chamadas extras: o bloqueio é estável e não acumula cota.
			for (let i = 0; i < 4; i++) {
				await dispatch(deps, {
					conversationId: conversaId,
					text: TEXTO_NEUTRO,
					now: DENTRO_DA_JANELA,
					idempotencyKey: `cp-extra-${i}-${randomUUID()}`,
				});
			}

			expect(enviados).toHaveLength(0);

			const cota = rows<{ count: number }>(
				await tx.execute(sql`
					SELECT count FROM daily_counters
					WHERE day = ${chaveDia(DENTRO_DA_JANELA)} AND kind = 'sent'
				`),
			);
			expect(cota[0]?.count ?? 0).toBe(0);
		});
	});
});
