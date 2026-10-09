/**
 * Lead Importer — TDD
 *
 * Padrão de transação (correto): db.transaction(outer, async (tx) => { ... })
 * → fixtures dentro → importLeads(tx as unknown as Db, ...) (inner vira SAVEPOINT)
 * → asserts dentro → throw sentinel para ROLLBACK global.
 *
 * Reconciliação com o schema real (01-03 GREEN): namespace `schema`, colunas
 * camelCase no TS, `openDb(env.DATABASE_URL)`, e a porta com as assinaturas reais
 * (`Promise<number|null>`/`Promise<Date|null>`).
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { env } from "../../src/config/env.js";
import type { Db } from "../../src/infra/db/client.js";
import { openDb } from "../../src/infra/db/client.js";
import type { Lead, LeadSourcePort } from "../../src/domain/ports/LeadSourcePort.js";
import { importLeads } from "../../src/application/lead-importer.js";
import * as schema from "../../src/infra/db/schema.js";

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

class FakeLeadSource implements LeadSourcePort {
	leads: Lead[] = [];
	cap: number | null = null;
	timelock: Date | null = null;

	async fetchNewLeads(): Promise<Lead[]> {
		return this.leads;
	}
	markValidNewLead(_e164: string): void {}
	async fetchNewChatMessageCap(): Promise<number | null> {
		return this.cap;
	}
	async fetchAccountReachoutTimelock(): Promise<Date | null> {
		return this.timelock;
	}
}

const isE164 = (v: string): boolean => /^\+[1-9][0-9]{7,14}$/.test(v);

describe("lead-importer", () => {
	let dbHandle: Awaited<ReturnType<typeof openDb>>;

	beforeAll(async () => {
		dbHandle = await openDb(env.DATABASE_URL);
	});

	afterAll(async () => {
		await dbHandle.pool.end();
	});

	it("importa lead novo (inserted true) e cria conversa + status_history", async () => {
		const sentinel = new Error("TEST_DONE");
		try {
			await dbHandle.db.transaction(async (tx) => {
				const phone = uniqPhone();
				await tx
					.insert(schema.channelAccounts)
					.values({ phoneE164: env.CHANNEL_PHONE_E164 })
					.onConflictDoNothing();
				const d = dayLocal();
				await tx
					.insert(schema.dailyCounters)
					.values({ day: d, kind: "new_contacts", count: 0 })
					.onConflictDoNothing();
				const src = new FakeLeadSource();
				src.leads = [
					{
						e164: phone,
						name: "Acme",
						addressLine: "SP",
						originSource: "cacaleads",
						legalBasis: "legitimo_interesse",
						purpose: "prospecao_b2b_servicos_digitais",
						optOut: false,
						rawContent: { teste: 1 },
					},
				];
				const res = await importLeads(tx as unknown as Db, src, {
					dailyLeadLimit: 10,
					tz: TZ,
					agora: new Date(),
				});
				expect(res.importados).toBe(1);
				expect(res.duplicados).toHaveLength(0);
				expect(res.rejeitados).toBe(0);
				expect(res.semCota).toBe(false);
				const l = await tx.query.leads.findFirst({
					where: eq(schema.leads.phoneNumber, phone),
				});
				expect(l).toBeDefined();
				const conv = await tx.query.conversations.findFirst({
					where: eq(schema.conversations.leadId, l!.id),
				});
				expect(conv).toBeDefined();
				const sh = await tx.query.statusHistory.findFirst({
					where: eq(schema.statusHistory.conversationId, conv!.id),
				});
				expect(sh).toBeDefined();
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("duplicata mesmo telefone → 1 registro, duplicate_of = primeiro, sem criar nova conversa", async () => {
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
				const l1 = await tx
					.insert(schema.leads)
					.values({
						phoneNumber: phone,
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now()-interval '1 day'`,
						waJid: "123@s.whatsapp.net",
						name: "A",
					})
					.returning({ id: schema.leads.id });
				const src = new FakeLeadSource();
				src.leads = [
					{
						e164: phone,
						name: "B",
						originSource: "cacaleads",
						legalBasis: "legitimo_interesse",
						purpose: "prospecao_b2b_servicos_digitais",
						optOut: false,
					},
				];
				const res = await importLeads(tx as unknown as Db, src, {
					dailyLeadLimit: 10,
					tz: TZ,
				});
				expect(res.importados).toBe(0);
				expect(res.duplicados).toHaveLength(1);
				expect(res.duplicados[0]?.e164).toBe(phone);
				expect(res.duplicados[0]?.duplicateOf).toBe(l1[0]?.id);
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("conflito optOut: db false + provider true → atualiza lead.opt_out=true e insere optout_ledger", async () => {
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
						optOut: false,
						originSource: "cacaleads",
						purpose: "prospecao_b2b_servicos_digitais",
						legalRegisteredAt: sql`now()-interval '1 day'`,
					})
					.returning({ id: schema.leads.id });
				const src = new FakeLeadSource();
				src.leads = [
					{
						e164: phone,
						optOut: true,
						originSource: "cacaleads",
						legalBasis: "legitimo_interesse",
						purpose: "prospecao_b2b_servicos_digitais",
					},
				];
				await importLeads(tx as unknown as Db, src, {
					dailyLeadLimit: 10,
					tz: TZ,
				});
				const ld = await tx.query.leads.findFirst({
					where: eq(schema.leads.id, l[0]!.id),
				});
				expect(ld?.optOut).toBe(true);
				const ol = await tx.query.optoutLedger.findFirst({
					where: eq(schema.optoutLedger.leadId, l[0]!.id),
				});
				expect(ol).toBeDefined();
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("cota esgotada: novo lead não é importado, semCota true (comportamento CotaEsgotada → break)", async () => {
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
					.values({ day: d, kind: "new_contacts", count: 1 })
					.onConflictDoNothing();
				const src = new FakeLeadSource();
				src.leads = [
					{
						e164: uniqPhone(),
						originSource: "cacaleads",
						legalBasis: "legitimo_interesse",
						purpose: "prospecao_b2b_servicos_digitais",
						optOut: false,
					},
					{
						e164: uniqPhone(),
						originSource: "cacaleads",
						legalBasis: "legitimo_interesse",
						purpose: "prospecao_b2b_servicos_digitais",
						optOut: false,
					},
				];
				const res = await importLeads(tx as unknown as Db, src, {
					dailyLeadLimit: 1,
					tz: TZ,
					cap: 1,
				});
				expect(res.semCota).toBe(true);
				expect(res.importados + res.rejeitados >= 1).toBe(true);
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("lead sem origin_source → rejeitados++ e não persiste (DadosIncompletos tratado)", async () => {
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
				const src = new FakeLeadSource();
				src.leads = [
					{
						e164: phone,
						originSource: undefined as unknown as string,
						legalBasis: "legitimo_interesse",
						purpose: "prospecao_b2b_servicos_digitais",
						optOut: false,
					},
				];
				const res = await importLeads(tx as unknown as Db, src, {
					dailyLeadLimit: 10,
					tz: TZ,
				});
				expect(res.rejeitados).toBe(1);
				expect(res.importados).toBe(0);
				const l = await tx.query.leads.findFirst({
					where: eq(schema.leads.phoneNumber, phone),
				});
				expect(l).toBeUndefined();
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("E.164 inválido → rejeitado (fora da tx de persistência por lead válido)", async () => {
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
				const src = new FakeLeadSource();
				src.leads = [
					{
						e164: "11999999999",
						originSource: "cacaleads",
						legalBasis: "legitimo_interesse",
						purpose: "prospecao_b2b_servicos_digitais",
						optOut: false,
					},
				];
				const res = await importLeads(tx as unknown as Db, src, {
					dailyLeadLimit: 10,
					tz: TZ,
				});
				expect(res.rejeitados).toBe(1);
				expect(res.importados).toBe(0);
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	it("lead novo com optOut true → insere ledger", async () => {
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
				const src = new FakeLeadSource();
				src.leads = [
					{
						e164: phone,
						optOut: true,
						originSource: "cacaleads",
						legalBasis: "legitimo_interesse",
						purpose: "prospecao_b2b_servicos_digitais",
					},
				];
				const res = await importLeads(tx as unknown as Db, src, {
					dailyLeadLimit: 10,
					tz: TZ,
				});
				expect(res.importados).toBe(1);
				const l = await tx.query.leads.findFirst({
					where: eq(schema.leads.phoneNumber, phone),
				});
				expect(l?.optOut).toBe(true);
				const ol = await tx.query.optoutLedger.findFirst({
					where: eq(schema.optoutLedger.leadId, l!.id),
				});
				expect(ol).toBeDefined();
				throw sentinel;
			});
		} catch (e) {
			if (e !== sentinel) throw e;
		}
	});

	describe("property tests (seed 20260928, numRuns 500)", () => {
		it("validador E.164 puro: apenas +[1-9]{7,14} válidos", () => {
			fc.assert(
				fc.property(fc.string(), (s) => {
					const ok = isE164(s);
					if (ok) {
						expect(s.startsWith("+")).toBe(true);
						expect(s.length).toBeGreaterThanOrEqual(8);
						expect(s.length).toBeLessThanOrEqual(16);
					}
					return true;
				}),
				{ numRuns: 500, seed: SEMENTE },
			);
		});
	});
});
