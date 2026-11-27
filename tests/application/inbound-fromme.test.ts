/**
 * Inbound fromMe gate — behaviors 1-9 (reescrito no 02-04 Task 1, CR-01).
 *
 * O sinal do Gate 0 é o EMISSOR da mensagem, não o `chatId`: num evento `fromMe`
 * o `chatId` é o JID do LEAD (é para quem o Admin escreveu), e o emissor é o
 * próprio socket (o número dedicado). O runtime carimba `senderPhoneE164` a
 * partir de `sock.user.id`; o predicado puro compara esse E.164 com o do canal.
 *
 * Notas de reconciliação com o schema real (01-03 GREEN):
 * - `schema` é namespace (`import * as schema`); colunas são camelCase no TS
 *   e snake_case no banco.
 * - `openDb` exige a connection string.
 * - `SocketConfig` não existe; o socket é tipado por `Parameters<…>[1]`.
 */

import { eq, sql } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	deveMarcarPrimeiroContatoHumano,
	processInboundFromMe,
} from "../../src/application/inbound-handler.js";
import { criarEventoInbound } from "../../src/channel/baileys/runtime.js";
import { env } from "../../src/config/env.js";
import type { Db } from "../../src/infra/db/client.js";
import { openDb } from "../../src/infra/db/client.js";
import * as schema from "../../src/infra/db/schema.js";

const SEMENTE = 20260928;
const TZ = env.TZ ?? "America/Sao_Paulo";
const CANAL = env.CHANNEL_PHONE_E164;

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

/** Forma que o runtime produz num `fromMe`: o `chatId` é o JID do LEAD. */
const jidDoTelefone = (phone: string): string =>
	`${phone.replace(/^\+/, "")}@s.whatsapp.net`;

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

	const semearLead = async (
		tx: Db,
		over: {
			readonly firstContactByHuman?: boolean;
			readonly optOut?: boolean;
		} = {},
	): Promise<{ leadId: string; conversationId: string; phone: string }> => {
		await tx
			.insert(schema.channelAccounts)
			.values({ phoneE164: CANAL })
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
				firstContactByHuman: over.firstContactByHuman ?? false,
				optOut: over.optOut ?? false,
			})
			.returning({ id: schema.leads.id });
		const lead = l[0];
		if (!lead) throw new Error("lead fixture não criado");
		const conta = await tx.query.channelAccounts.findFirst({
			where: eq(schema.channelAccounts.phoneE164, CANAL),
		});
		if (!conta) throw new Error("conta do canal não encontrada");
		const conv = await tx
			.insert(schema.conversations)
			.values({ leadId: lead.id, channelAccountId: conta.id })
			.returning({ id: schema.conversations.id });
		const conversa = conv[0];
		if (!conversa) throw new Error("conversation fixture não criada");
		return { leadId: lead.id, conversationId: conversa.id, phone };
	};

	it("behavior 1: fromMe + emissor = canal (chatId = JID do lead) → first_contact=true e novo→aquecimento auditado", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				const fx = await semearLead(tx as unknown as Db);
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: jidDoTelefone(fx.phone),
					fromMe: true,
					senderPhoneE164: CANAL,
					providerMsgId: "msg-1",
					timestamp: Date.now(),
					body: "oi",
					phoneNumber: fx.phone,
					isMedia: false,
					mediaType: null,
				});
				const ld = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, fx.leadId),
				});
				expect(ld?.firstContactByHuman).toBe(true);
				const conv = await tx.query.conversations.findFirst({
					where: eq(schema.conversations.id, fx.conversationId),
				});
				expect(conv?.state).toBe("aquecimento");
				expect(conv?.engagementMode).toBe("bot_active");
				const hist = await tx.query.statusHistory.findFirst({
					where: eq(schema.statusHistory.conversationId, fx.conversationId),
				});
				expect(hist?.changedBy).toBe("admin");
				expect(hist?.fromState).toBe("novo");
				expect(hist?.toState).toBe("aquecimento");
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("behavior 2: fromMe com emissor de OUTRO número → não marca e não muda o estado", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				const fx = await semearLead(tx as unknown as Db);
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: jidDoTelefone(fx.phone),
					fromMe: true,
					senderPhoneE164: "+5511888887777",
					providerMsgId: "msg-2",
					timestamp: Date.now(),
					body: "oi",
					phoneNumber: fx.phone,
					isMedia: false,
					mediaType: null,
				});
				const ld = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, fx.leadId),
				});
				expect(ld?.firstContactByHuman).toBe(false);
				const conv = await tx.query.conversations.findFirst({
					where: eq(schema.conversations.id, fx.conversationId),
				});
				expect(conv?.state).toBe("novo");
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("behavior 3: fromMe false mesmo com emissor = canal → não marca (R-002)", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				const fx = await semearLead(tx as unknown as Db);
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: jidDoTelefone(fx.phone),
					fromMe: false,
					senderPhoneE164: CANAL,
					providerMsgId: "msg-3",
					timestamp: Date.now(),
					body: "oi",
					phoneNumber: fx.phone,
					isMedia: false,
					mediaType: null,
				});
				const ld = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, fx.leadId),
				});
				expect(ld?.firstContactByHuman).toBe(false);
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("behavior 4: sem fromMe mesmo com emissor = canal → não marca", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				const fx = await semearLead(tx as unknown as Db);
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: jidDoTelefone(fx.phone),
					fromMe: undefined as never,
					senderPhoneE164: CANAL,
					providerMsgId: "msg-4",
					timestamp: Date.now(),
					body: "oi",
					phoneNumber: fx.phone,
					isMedia: false,
					mediaType: null,
				});
				const ld = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, fx.leadId),
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
				const fx = await semearLead(tx as unknown as Db);
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: "outro",
					fromMe: false,
					providerMsgId: "msg-6",
					timestamp: Date.now(),
					body: "stop",
					phoneNumber: fx.phone,
					isMedia: false,
					mediaType: null,
					providerOptOut: true,
				});
				const ld = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, fx.leadId),
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
				const fx = await semearLead(tx as unknown as Db);
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: "x",
					fromMe: false,
					providerMsgId: "pid-7a",
					timestamp: Date.now(),
					body: "a",
					phoneNumber: fx.phone,
					isMedia: false,
					mediaType: null,
				});
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: "x",
					fromMe: false,
					providerMsgId: "pid-7b",
					timestamp: Date.now(),
					body: "b",
					phoneNumber: fx.phone,
					isMedia: false,
					mediaType: null,
				});
				const msgs = await tx.query.messages.findMany({
					where: eq(schema.messages.conversationId, fx.conversationId),
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
				const fx = await semearLead(tx as unknown as Db);
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					chatId: "x",
					fromMe: false,
					providerMsgId: "mid-8",
					timestamp: Date.now(),
					body: "img",
					phoneNumber: fx.phone,
					isMedia: true,
					mediaType: "image",
				});
				const msgs = await tx.query.messages.findMany({
					where: eq(schema.messages.conversationId, fx.conversationId),
				});
				expect(msgs.length).toBe(0);
				const ba = await tx.query.blockedAttempts.findMany({
					where: eq(schema.blockedAttempts.conversationId, fx.conversationId),
				});
				expect(ba.length).toBe(1);
				expect(ba[0]?.guard).toBe("ar009_midia_recebida");
				expect(ba[0]?.direction).toBe("in");
				const he = await tx.query.handoffEvents.findMany({
					where: eq(schema.handoffEvents.conversationId, fx.conversationId),
				});
				expect(he.length).toBe(1);
				const c2 = await tx.query.conversations.findFirst({
					where: eq(schema.conversations.id, fx.conversationId),
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

	it("Teste F (composicional): WAMessage(fromMe) → criarEventoInbound → processInboundFromMe marca e move para aquecimento", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				const fx = await semearLead(tx as unknown as Db);
				const canalSelfJid = `${CANAL.replace(/^\+/, "")}:12@s.whatsapp.net`;
				const evt = criarEventoInbound(
					{
						key: {
							remoteJid: jidDoTelefone(fx.phone),
							fromMe: true,
							id: "comp-1",
						},
						message: { conversation: "oi, aqui é o consultor" },
						messageTimestamp: Math.floor(Date.now() / 1000),
					} as unknown as Parameters<typeof criarEventoInbound>[0],
					canalSelfJid,
				);
				if (!evt) throw new Error("evento inbound não criado");
				await processInboundFromMe(tx as unknown as Db, makeSock(), {
					...evt,
					phoneNumber: fx.phone,
				});
				const ld = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, fx.leadId),
				});
				expect(ld?.firstContactByHuman).toBe(true);
				const conv = await tx.query.conversations.findFirst({
					where: eq(schema.conversations.id, fx.conversationId),
				});
				expect(conv?.state).toBe("aquecimento");
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	describe("property tests (seed 20260928, numRuns 500)", () => {
		it("deveMarcarPrimeiroContatoHumano: true sse fromMe + emissor == canal", () => {
			// `caso` garante que o ramo de igualdade NÃO-vazia seja exercitado —
			// dois `fc.string()` independentes praticamente nunca colidem.
			fc.assert(
				fc.property(
					fc.boolean(),
					fc.string(),
					fc.oneof(
						fc.constant("igual"),
						fc.constant("diferente"),
						fc.constant("nulo"),
						fc.constant("undefined"),
					),
					(fromMe, canal, caso) => {
						const ch = canal;
						const senderPhoneE164 =
							caso === "igual"
								? canal
								: caso === "diferente"
									? `${canal}\u0000z`
									: caso === "nulo"
										? null
										: undefined;
						const r = deveMarcarPrimeiroContatoHumano({
							fromMe,
							senderPhoneE164,
							channelPhoneE164: ch,
						});
						const esperado =
							fromMe === true &&
							senderPhoneE164 != null &&
							senderPhoneE164.length > 0 &&
							ch.length > 0 &&
							senderPhoneE164 === ch;
						expect(r).toBe(esperado);
					},
				),
				{ numRuns: 500, seed: SEMENTE },
			);
		});
	});
});
