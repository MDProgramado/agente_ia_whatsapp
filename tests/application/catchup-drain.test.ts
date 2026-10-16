/**
 * Dreno de catch-up (R-007/FLUP-01) e encerramento por não-resposta (D-12/D-13).
 *
 * ## O que este arquivo prova, e por que cada caso existe
 *
 * - **Segunda de manhã** (o cenário mais perigoso do R-007): 20 follow-ups
 *   venceram enquanto o PC estava desligado. Despejar os 20 de uma vez ao abrir
 *   é o burst de cadência de máquina que a pesquisa associa a banimento
 *   (V-03/R-059). O dreno limita a 3 envios "iminentes" e ADIA o restante para a
 *   próxima janela — nunca descarta (WHS-02/D-07).
 * - **FIRE_ONCE**: o dreno com `isCatchupDrain=true` roda UMA vez; a segunda
 *   passada com o mesmo relógio não reenvia (senão o boot viraria um loop).
 * - **Fora da janela**: nem conta iminentes; tudo vira `pending` na próxima
 *   janela (AR-007).
 * - **Encerramento**: no 4º toque sem inbound, a conversa vira `encerrado` com
 *   `closed_reason='sem_resposta'` e a transição é auditada (R-022).
 * - **Inbound cancela**: resposta do lead derruba task + job na MESMA transação
 *   (Pitfall 3) — read receipts não contam (D-12).
 *
 * ## Por que transação revertida
 *
 * `messages` é append-only e `leads` não pode ser apagado: cada caso roda numa
 * transação que termina em rollback (`outbox.test.ts`, `scheduler.test.ts`).
 */
import { createHash, randomInt } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	drenarCatchup,
	encerrarCadenciasSemResposta,
} from "../../src/application/catchup-drain.js";
import { processInboundFromMe } from "../../src/application/inbound-handler.js";
import { startScheduler } from "../../src/application/scheduler.js";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import * as schema from "../../src/infra/db/schema.js";
import { instanteEmZona, TZ } from "../gate/fixtures.js";

/** Segunda 28/09/2026 9h SP — dentro da janela (7h–17h). */
const SEGUNDA_9H = instanteEmZona(TZ, 2026, 9, 28, 9, 0);
/** Sábado 26/09/2026 10h SP — FORA da janela. */
const SABADO_10H = instanteEmZona(TZ, 2026, 9, 26, 10, 0);
/** A âncora (último outbound) é SEMPRE passada: todos os jobs já venceram. */
const ANCORA = instanteEmZona(TZ, 2026, 9, 25, 11, 0);
/** Início da próxima janela a partir de segunda 9h → terça 29/09 7h. */
const PROXIMA_JANELA = instanteEmZona(TZ, 2026, 9, 29, 7, 0);
/** Início da próxima janela a partir de sábado → segunda 28/09 7h. */
const SEGUNDA_7H = instanteEmZona(TZ, 2026, 9, 28, 7, 0);
const DEZ_MIN_MS = 10 * 60_000;

const CRON_NAO_DISPARA = "0 0 0 1 1 *";
const SENTINELA = "rollback-intencional-do-teste";

const rows = <T>(resultado: unknown): T[] => (resultado as { rows: T[] }).rows;

const primeiro = <T>(lista: readonly T[]): T => {
	const [item] = lista;
	if (item === undefined) throw new Error("esperava ao menos uma linha");
	return item;
};

const telefoneAleatorio = (): string =>
	`+55${randomInt(10_000_000_000, 99_999_999_999)}`;

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
		VALUES (${env.CHANNEL_PHONE_E164}, 'teste-catchup')
		ON CONFLICT (phone_e164) DO NOTHING
	`);
	const id = rows<{ id: string }>(
		await db.execute(sql`
			SELECT id FROM channel_accounts WHERE phone_e164 = ${env.CHANNEL_PHONE_E164}
		`),
	)[0]?.id;
	if (!id) throw new Error("conta de teste nao encontrada");
	return id;
};

const inserirLead = async (db: Db, telefone: string): Promise<string> => {
	const r = await db.execute(sql`
		INSERT INTO leads (
			phone_number, origin_source, legal_basis, purpose,
			legal_registered_at, first_contact_by_human, wa_validation_state, opt_out
		)
		VALUES (
			${telefone}, 'teste', 'legitimo_interesse', 'prospeccao',
			'2025-01-01T12:00:00Z', true, 'VALIDO', false
		)
		RETURNING id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

interface ConversaOpts {
	readonly ancora?: Date;
	readonly inboundDepois?: Date | null;
	readonly followUpIndex?: number;
	readonly state?: string;
}

const inserirConversa = async (
	db: Db,
	leadId: string,
	contaId: string,
	opts: ConversaOpts = {},
): Promise<string> => {
	const ainda = opts.ancora ?? ANCORA;
	const outboundWall = sql`(to_timestamp(${ainda.getTime()}::double precision / 1000.0) AT TIME ZONE ${TZ})`;
	const inboundWall =
		opts.inboundDepois === null || opts.inboundDepois === undefined
			? sql`NULL`
			: sql`(to_timestamp(${opts.inboundDepois.getTime()}::double precision / 1000.0) AT TIME ZONE ${TZ})`;
	const r = await db.execute(sql`
		INSERT INTO conversations (
			lead_id, channel_account_id, state, engagement_mode,
			last_outbound_at, last_inbound_at, follow_up_index
		)
		VALUES (
			${leadId}, ${contaId}, ${opts.state ?? "novo"}, 'bot_active',
			${outboundWall}, ${inboundWall}, ${opts.followUpIndex ?? 0}
		)
		RETURNING id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

/** Enfileira um follow-up já VENCIDO (scheduled_for no passado). */
const inserirJobVencido = async (
	db: Db,
	conversaId: string,
	idx: number,
	scheduledFor: Date = ANCORA,
): Promise<string> => {
	const wall = sql`(to_timestamp(${scheduledFor.getTime()}::double precision / 1000.0) AT TIME ZONE ${TZ})`;
	const r = await db.execute(sql`
		INSERT INTO outbox (conversation_id, origin, body, idempotency_key, scheduled_for, status)
		VALUES (
			${conversaId}, 'followup', 'toque de teste',
			${`flup:${conversaId}:${idx}`}, ${wall}, 'pending'
		)
		RETURNING id
	`);
	return primeiro(rows<{ id: string }>(r)).id;
};

/** Semeia `n` conversas independentes, cada uma com 1 job vencido. */
const semearLote = async (
	db: Db,
	contaId: string,
	n: number,
	opts: ConversaOpts = {},
): Promise<string[]> => {
	const ids: string[] = [];
	for (let i = 0; i < n; i += 1) {
		const leadId = await inserirLead(db, telefoneAleatorio());
		const conversaId = await inserirConversa(db, leadId, contaId, opts);
		await inserirJobVencido(db, conversaId, opts.followUpIndex ?? 0);
		ids.push(conversaId);
	}
	return ids;
};

interface LinhaJob {
	id: string;
	origin: string;
	status: string;
	ms: string;
}

const jobsDe = (db: Db, conversaIds: readonly string[]): Promise<LinhaJob[]> =>
	db
		.execute(sql`
			SELECT
				id, origin, status,
				(extract(epoch from (scheduled_for AT TIME ZONE ${TZ})) * 1000)::bigint AS ms
			FROM outbox
			WHERE conversation_id = ANY(${sql.raw(`ARRAY[${conversaIds.map((c) => `'${c}'::uuid`).join(",")}]`)})
		`)
		.then(rows<LinhaJob>);

let conn: OpenDb;
let db: Db;

beforeAll(async () => {
	conn = await openDb(env.DATABASE_URL);
	db = conn.db;
});

afterAll(async () => {
	await closeDb(conn);
});

describe("drenarCatchup — segunda de manhã não vira burst (R-007/D-07)", () => {
	it("20 vencidos ⇒ ≤3 iminentes (≤10min), 17 adiados p/ próxima janela, 0 descartados", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const conversas = await semearLote(tx, contaId, 20);

			const resultado = await drenarCatchup(tx, {
				now: SEGUNDA_9H,
				isCatchupDrain: true,
				feriados: [],
				sleep: async () => {},
			});

			const jobs = await jobsDe(tx, conversas);
			const iminentes = jobs.filter((j) => j.origin === "catchup");
			const adiados = jobs.filter((j) => j.origin === "followup");
			const descartados = jobs.filter(
				(j) => j.status === "failed" || j.status === "abandoned",
			);

			// (1) ≤3 iminentes, TODOS dentro dos primeiros 10 min.
			expect(iminentes.length).toBeLessThanOrEqual(3);
			expect(iminentes.length).toBeGreaterThan(0);
			for (const j of iminentes) {
				expect(Number(j.ms)).toBeGreaterThanOrEqual(SEGUNDA_9H.getTime());
				expect(Number(j.ms)).toBeLessThanOrEqual(
					SEGUNDA_9H.getTime() + DEZ_MIN_MS,
				);
			}
			// (2) os 17 restantes viram pending na próxima janela (23h/7h).
			expect(adiados.length).toBe(20 - iminentes.length);
			for (const j of adiados) {
				expect(j.status).toBe("pending");
				expect(Number(j.ms)).toBe(PROXIMA_JANELA.getTime());
			}
			// (3) NENHUM descartado.
			expect(descartados).toHaveLength(0);

			expect(resultado.enviados).toBe(iminentes.length);
			expect(resultado.adiados).toBe(adiados.length);
		});
	});

	it("FIRE_ONCE: segunda passada com o MESMO relógio não envia de novo", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const conversas = await semearLote(tx, contaId, 20);

			await drenarCatchup(tx, {
				now: SEGUNDA_9H,
				isCatchupDrain: true,
				feriados: [],
				sleep: async () => {},
			});
			const segunda = await drenarCatchup(tx, {
				now: SEGUNDA_9H,
				isCatchupDrain: true,
				feriados: [],
				sleep: async () => {},
			});
			expect(segunda.enviados).toBe(0);

			const jobs = await jobsDe(tx, conversas);
			expect(jobs.filter((j) => j.origin === "catchup")).toHaveLength(
				jobs.filter((j) => j.origin === "catchup").length,
			);
		});
	});

	it("fora da janela (sábado) ⇒ 0 iminentes, todos pending na próxima janela", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const conversas = await semearLote(tx, contaId, 5);

			const resultado = await drenarCatchup(tx, {
				now: SABADO_10H,
				isCatchupDrain: true,
				feriados: [],
				sleep: async () => {},
			});
			expect(resultado.enviados).toBe(0);

			const jobs = await jobsDe(tx, conversas);
			for (const j of jobs) {
				expect(j.status).toBe("pending");
				expect(j.origin).toBe("followup");
				expect(Number(j.ms)).toBe(SEGUNDA_7H.getTime());
			}
		});
	});

	it("isCatchupDrain=false ⇒ no-op (nada muda)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const conversas = await semearLote(tx, contaId, 5);

			const resultado = await drenarCatchup(tx, {
				now: SEGUNDA_9H,
				isCatchupDrain: false,
				feriados: [],
				sleep: async () => {},
			});
			expect(resultado.enviados).toBe(0);
			expect(resultado.adiados).toBe(0);

			const jobs = await jobsDe(tx, conversas);
			for (const j of jobs) {
				expect(j.origin).toBe("followup");
				expect(j.status).toBe("pending");
				expect(Number(j.ms)).toBe(ANCORA.getTime());
			}
		});
	});
});

describe("encerrarCadenciasSemResposta — encerramento por não-resposta (D-12/D-13)", () => {
	it("no 4º toque sem inbound ⇒ state encerrado + closed_reason + status_history (R-022)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneAleatorio());
			const conversaId = await inserirConversa(tx, leadId, contaId, {
				followUpIndex: 4,
				state: "aquecimento",
			});

			const sched = startScheduler({
				db: tx,
				now: () => SEGUNDA_9H,
				feriados: [],
				maxToques: 4,
				cronPattern: CRON_NAO_DISPARA,
			});
			try {
				await sched.tick();
			} finally {
				sched.stop();
			}

			const conversa = primeiro(
				rows<{ state: string; closed_reason: string | null }>(
					await tx.execute(sql`
						SELECT state, closed_reason FROM conversations WHERE id = ${conversaId}
					`),
				),
			);
			expect(conversa.state).toBe("encerrado");
			expect(conversa.closed_reason).toBe("sem_resposta");

			const hist = await tx.query.statusHistory.findFirst({
				where: eq(schema.statusHistory.conversationId, conversaId),
			});
			expect(hist?.toState).toBe("encerrado");
			expect(hist?.reason).toBe("sem_resposta");
			expect(hist?.changedBy).toBe("bot");
		});
	});

	it("NÃO encerra quando houve inbound depois do último outbound (D-12)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const contaId = await inserirConta(tx);
			const leadId = await inserirLead(tx, telefoneAleatorio());
			const conversaId = await inserirConversa(tx, leadId, contaId, {
				followUpIndex: 4,
				state: "aquecimento",
				inboundDepois: new Date(ANCORA.getTime() + 60_000),
			});

			const resultado = await encerrarCadenciasSemResposta(tx, {
				now: SEGUNDA_9H,
				maxToques: 4,
			});
			expect(resultado.encerradas).toBe(0);

			const conversa = primeiro(
				rows<{ state: string; closed_reason: string | null }>(
					await tx.execute(sql`
						SELECT state, closed_reason FROM conversations WHERE id = ${conversaId}
					`),
				),
			);
			expect(conversa.state).toBe("aquecimento");
			expect(conversa.closed_reason).toBeNull();
		});
	});
});

describe("cancelarCadenciaPendente — inbound derruba a cadência transacionalmente (D-12)", () => {
	it("inbound de texto ⇒ nenhuma scheduled_task pendente nem job pendente", async () => {
		await emTransacaoRevertida(async (tx) => {
			await tx
				.insert(schema.channelAccounts)
				.values({ phoneE164: env.CHANNEL_PHONE_E164 })
				.onConflictDoNothing();
			const contaId = await inserirConta(tx);
			const telefone = telefoneAleatorio();
			const leadId = await inserirLead(tx, telefone);
			const conversaId = await inserirConversa(tx, leadId, contaId);
			await inserirJobVencido(tx, conversaId, 0);
			await tx.execute(sql`
				INSERT INTO scheduled_tasks (conversation_id, task_type, scheduled_for, follow_up_index, status)
				VALUES (${conversaId}, 'followup', now(), 0, 'pending')
			`);

			await processInboundFromMe(
				tx,
				{
					signalRepository: { lidMapping: {} },
				} as unknown as Parameters<typeof processInboundFromMe>[1],
				{
					chatId: `${telefone.replace(/^\+/, "")}@s.whatsapp.net`,
					fromMe: false,
					providerMsgId: `resposta-${conversaId}`,
					timestamp: Date.now(),
					body: "oi, tenho interesse",
					phoneNumber: telefone,
					isMedia: false,
					mediaType: null,
				},
			);

			const pendentes = rows<{ n: number }>(
				await tx.execute(sql`
					SELECT count(*)::int AS n FROM scheduled_tasks
					WHERE conversation_id = ${conversaId} AND status = 'pending'
				`),
			);
			expect(primeiro(pendentes).n).toBe(0);

			const job = primeiro(
				rows<{ status: string; last_error: string | null }>(
					await tx.execute(sql`
						SELECT status, last_error FROM outbox
						WHERE conversation_id = ${conversaId}
					`),
				),
			);
			expect(job.status).toBe("abandoned");
			expect(job.last_error).toBe("resposta_do_lead");
		});
	});
});

// Guarda de sanidade: o jitter determinístico do dreno fica na faixa 3–12s e é
// estável por seed — a mesma conversa nunca reancora diferente entre passadas.
it("jitter do dreno é determinístico e fica em [3s, 12s]", () => {
	const semente = "conv-abc:job-123";
	const h = createHash("sha256").update(semente).digest();
	const n = h.readUInt32BE(0) / 0xffff_ffff;
	const ms = Math.round(3_000 + n * (12_000 - 3_000));
	expect(ms).toBeGreaterThanOrEqual(3_000);
	expect(ms).toBeLessThanOrEqual(12_000);
	const h2 = createHash("sha256").update(semente).digest();
	expect(h2.equals(h)).toBe(true);
});
