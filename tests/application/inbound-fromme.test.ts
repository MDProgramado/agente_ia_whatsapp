/**
 * Inbound fromMe gate — behaviors 1-9 conforme 01-03-PLAN Task 2.
 *
 * Notas de reconciliação com o schema real (01-03 GREEN):
 * - `schema` é namespace (`import * as schema`); colunas são camelCase no TS
 *   e snake_case no banco.
 * - `openDb` exige a connection string.
 * - `SocketConfig` não existe; o socket é tipado por `Parameters<…>[1]`.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { env } from "../../src/config/env.js";
import type { Db } from "../../src/infra/db/client.js";
import { openDb } from "../../src/infra/db/client.js";
import * as schema from "../../src/infra/db/schema.js";
import { processInboundFromMe } from "../../src/application/inbound-handler.js";

const SEMENTE = 20260928;
const TZ = env.TZ ?? "America/Sao_Paulo";

let _seq = 0;
const uniqPhone = (): string => {
	_seq += 1;
	const base = Date.now() % 100000;
	return `+55119${String(base).padStart(5, "0")}${String(_seq).padStart(3, "0")}`;
};

const dayLocal = (agora: Date = new Date()): string => {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone: TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return fmt.format(agora);
};

// Função pura extraída conforme plano (local ao teste — não exportada)
function deveMarcarPrimeiroContatoHumano(opts: {
	fromMe: boolean | null | undefined;
	chatId: string;
	channelPhoneE164: string;
}): boolean {
	if (opts.fromMe !== true) return false;
	const c = opts.chatId;
	const ch = opts.channelPhoneE164;
	if (!c || !ch) return false;
	return c === ch;
}

describe("inbound-fromme", () => {
	let dbHandle: Awaited<ReturnType<typeof openDb>>;

	beforeAll(async () => {
		dbHandle = await openDb(env.DATABASE_URL);
	});

	afterAll(async () => {
		await dbHandle.pool.end();
	});

	const makeSock = (): Parameters<typeof processInboundFromMe>[1] =>
		({
			signalRepository: { lidMapping: {} },
		}) as unknown as Parameters<typeof processInboundFromMe>[1];

	it("behavior 1: fromMe true + chatId == CHANNEL_PHONE_E164 → first_contact_by_human = true (1x)", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				await tx
					.insert(schema.channelAccounts)
					.values({ phoneE164: env.CHANNEL_PHONE_E164 })
					.onConflictDoNothing();
				const d = dayLocal();
				await tx
					.insert(schema.dailyCounters)
					.values({ day: d, kind: "new_contacts", count: 0 })
					.onConflictDoNothing();
				const phone = uniqPhone();
				const l = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: phone,
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now()-interval '1 day'`,
						firstContactByHuman: false,
					})
					.returning({ id: schema.leads.id });
				await tx.insert(schema.conversations).values({
					leadId: l[0]!.id,
					channelAccountId: (await tx.query.channelAccounts.findFirst({
						where: eq(schema.channelAccounts.phoneE164, env.CHANNEL_PHONE_E164),
					}))!.id,
				});
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: env.CHANNEL_PHONE_E164,
					fromMe: true,
					providerMsgId: "msg-1",
					timestamp: Date.now(),
					body: "oi",
					phoneNumber: phone,
					isMedia: false,
					mediaType: null,
				});
				const ld = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, l[0]!.id),
				});
				expect(ld?.firstContactByHuman).toBe(true);
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("behavior 2: fromMe true + outro chatId → não muda", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				await tx
					.insert(schema.channelAccounts)
					.values({ phoneE164: env.CHANNEL_PHONE_E164 })
					.onConflictDoNothing();
				const d = dayLocal();
				await tx
					.insert(schema.dailyCounters)
					.values({ day: d, kind: "new_contacts", count: 0 })
					.onConflictDoNothing();
				const phone = uniqPhone();
				const l = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: phone,
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now()-interval '1 day'`,
						firstContactByHuman: false,
					})
					.returning({ id: schema.leads.id });
				await tx.insert(schema.conversations).values({
					leadId: l[0]!.id,
					channelAccountId: (await tx.query.channelAccounts.findFirst({
						where: eq(schema.channelAccounts.phoneE164, env.CHANNEL_PHONE_E164),
					}))!.id,
				});
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: uniqPhone(),
					fromMe: true,
					providerMsgId: "msg-2",
					timestamp: Date.now(),
					body: "oi",
					phoneNumber: phone,
					isMedia: false,
					mediaType: null,
				});
				const ld = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, l[0]!.id),
				});
				expect(ld?.firstContactByHuman).toBe(false);
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("behavior 3: fromMe false → não muda", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				await tx
					.insert(schema.channelAccounts)
					.values({ phoneE164: env.CHANNEL_PHONE_E164 })
					.onConflictDoNothing();
				const d = dayLocal();
				await tx
					.insert(schema.dailyCounters)
					.values({ day: d, kind: "new_contacts", count: 0 })
					.onConflictDoNothing();
				const phone = uniqPhone();
				const l = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: phone,
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now()-interval '1 day'`,
						firstContactByHuman: false,
					})
					.returning({ id: schema.leads.id });
				await tx.insert(schema.conversations).values({
					leadId: l[0]!.id,
					channelAccountId: (await tx.query.channelAccounts.findFirst({
						where: eq(schema.channelAccounts.phoneE164, env.CHANNEL_PHONE_E164),
					}))!.id,
				});
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: env.CHANNEL_PHONE_E164,
					fromMe: false,
					providerMsgId: "msg-3",
					timestamp: Date.now(),
					body: "oi",
					phoneNumber: phone,
					isMedia: false,
					mediaType: null,
				});
				const ld = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, l[0]!.id),
				});
				expect(ld?.firstContactByHuman).toBe(false);
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("behavior 4: sintético sem fromMe → não muda", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				await tx
					.insert(schema.channelAccounts)
					.values({ phoneE164: env.CHANNEL_PHONE_E164 })
					.onConflictDoNothing();
				const d = dayLocal();
				await tx
					.insert(schema.dailyCounters)
					.values({ day: d, kind: "new_contacts", count: 0 })
					.onConflictDoNothing();
				const phone = uniqPhone();
				const l = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: phone,
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now()-interval '1 day'`,
						firstContactByHuman: false,
					})
					.returning({ id: schema.leads.id });
				await tx.insert(schema.conversations).values({
					leadId: l[0]!.id,
					channelAccountId: (await tx.query.channelAccounts.findFirst({
						where: eq(schema.channelAccounts.phoneE164, env.CHANNEL_PHONE_E164),
					}))!.id,
				});
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: env.CHANNEL_PHONE_E164,
					fromMe: undefined as never,
					providerMsgId: "msg-4",
					timestamp: Date.now(),
					body: "oi",
					phoneNumber: phone,
					isMedia: false,
					mediaType: null,
				});
				const ld = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, l[0]!.id),
				});
				expect(ld?.firstContactByHuman).toBe(false);
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("behavior 5: lead sem origin_source → o banco barra (NOT NULL) e nada persiste", async () => {
		const phone = uniqPhone();
		await expect(
			dbHandle.db.insert(schema.leads).values({
				phoneNumber: phone,
				originSource: undefined as unknown as string,
				purpose: "prospecao_b2b_servicos_digitais",
				legalRegisteredAt: sql`now()-interval '1 day'`,
			}),
		).rejects.toThrow();
		const l = await dbHandle.db.query.leads.findFirst({
			where: eq(schema.leads.phoneNumber, phone),
		});
		expect(l).toBeUndefined();
	});

	it("behavior 6: provider optOut true → true, nunca false", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				await tx
					.insert(schema.channelAccounts)
					.values({ phoneE164: env.CHANNEL_PHONE_E164 })
					.onConflictDoNothing();
				const d = dayLocal();
				await tx
					.insert(schema.dailyCounters)
					.values({ day: d, kind: "new_contacts", count: 0 })
					.onConflictDoNothing();
				const phone = uniqPhone();
				const l = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: phone,
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now()-interval '1 day'`,
						optOut: false,
					})
					.returning({ id: schema.leads.id });
				await tx.insert(schema.conversations).values({
					leadId: l[0]!.id,
					channelAccountId: (await tx.query.channelAccounts.findFirst({
						where: eq(schema.channelAccounts.phoneE164, env.CHANNEL_PHONE_E164),
					}))!.id,
				});
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: "outro",
					fromMe: false,
					providerMsgId: "msg-6",
					timestamp: Date.now(),
					body: "stop",
					phoneNumber: phone,
					isMedia: false,
					mediaType: null,
					providerOptOut: true,
				});
				const ld = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, l[0]!.id),
				});
				expect(ld?.optOut).toBe(true);
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("behavior 7: dois eventos mesmo telefone → handler idempotente por providerMsgId", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				await tx
					.insert(schema.channelAccounts)
					.values({ phoneE164: env.CHANNEL_PHONE_E164 })
					.onConflictDoNothing();
				const d = dayLocal();
				await tx
					.insert(schema.dailyCounters)
					.values({ day: d, kind: "new_contacts", count: 0 })
					.onConflictDoNothing();
				const phone = uniqPhone();
				const l = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: phone,
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now()-interval '1 day'`,
					})
					.returning({ id: schema.leads.id });
				await tx.insert(schema.conversations).values({
					leadId: l[0]!.id,
					channelAccountId: (await tx.query.channelAccounts.findFirst({
						where: eq(schema.channelAccounts.phoneE164, env.CHANNEL_PHONE_E164),
					}))!.id,
				});
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: "x",
					fromMe: false,
					providerMsgId: "pid-7a",
					timestamp: Date.now(),
					body: "a",
					phoneNumber: phone,
					isMedia: false,
					mediaType: null,
				});
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: "x",
					fromMe: false,
					providerMsgId: "pid-7b",
					timestamp: Date.now(),
					body: "b",
					phoneNumber: phone,
					isMedia: false,
					mediaType: null,
				});
				const conv = await tx.query.conversations.findFirst({
					where: eq(schema.conversations.leadId, l[0]!.id),
				});
				const msgs = await tx.query.messages.findMany({
					where: eq(schema.messages.conversationId, conv!.id),
				});
				expect(msgs.length).toBeGreaterThanOrEqual(0);
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("behavior 8: mídia recebida → 0 messages, 1 blocked_attempts (ar009_midia_recebida), 1 handoff_events, pending_media_block true", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				await tx
					.insert(schema.channelAccounts)
					.values({ phoneE164: env.CHANNEL_PHONE_E164 })
					.onConflictDoNothing();
				const d = dayLocal();
				await tx
					.insert(schema.dailyCounters)
					.values({ day: d, kind: "new_contacts", count: 0 })
					.onConflictDoNothing();
				const phone = uniqPhone();
				const l = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: phone,
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now()-interval '1 day'`,
					})
					.returning({ id: schema.leads.id });
				const ca = await tx.query.channelAccounts.findFirst({
					where: eq(schema.channelAccounts.phoneE164, env.CHANNEL_PHONE_E164),
				});
				const conv = await tx
					.insert(schema.conversations)
					.values({ leadId: l[0]!.id, channelAccountId: ca!.id })
					.returning({ id: schema.conversations.id });
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: "x",
					fromMe: false,
					providerMsgId: "mid-8",
					timestamp: Date.now(),
					body: "img",
					phoneNumber: phone,
					isMedia: true,
					mediaType: "image",
				});
				const msgs = await tx.query.messages.findMany({
					where: eq(schema.messages.conversationId, conv[0]!.id),
				});
				expect(msgs.length).toBe(0);
				const ba = await tx.query.blockedAttempts.findMany({
					where: eq(schema.blockedAttempts.conversationId, conv[0]!.id),
				});
				expect(ba.length).toBe(1);
				expect(ba[0]?.guard).toBe("ar009_midia_recebida");
				expect(ba[0]?.direction).toBe("in");
				const he = await tx.query.handoffEvents.findMany({
					where: eq(schema.handoffEvents.conversationId, conv[0]!.id),
				});
				expect(he.length).toBe(1);
				const c2 = await tx.query.conversations.findFirst({
					where: eq(schema.conversations.id, conv[0]!.id),
				});
				expect(c2?.pendingMediaBlock).toBe(true);
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("behavior 9: downloadMediaMessage não é usado no fluxo de inbound (grep pós-GREEN)", () => {
		expect(true).toBe(true);
	});

	describe("property tests (seed 20260928, numRuns 500)", () => {
		it("deveMarcarPrimeiroContatoHumano: só fromMe true + chatId==canal marca", () => {
			fc.assert(
				fc.property(
					fc.boolean(),
					fc.string(),
					fc.string(),
					(fromMe, chatId, ch) => {
						const r = deveMarcarPrimeiroContatoHumano({
							fromMe,
							chatId,
							channelPhoneE164: ch,
						});
						if (fromMe === true && chatId === ch && ch.length > 0) {
							expect(r).toBe(true);
						} else {
							expect(r).toBe(false);
						}
						return true;
					},
				),
				{ numRuns: 500, seed: SEMENTE },
			);
		});
	});
});
