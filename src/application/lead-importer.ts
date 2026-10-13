/**
 * Importador de leads do caça-leads (LEAD-01..04, R-064, D-04/D-05) — Task 2, passo 6.
 *
 * **Uma transação por lead.** Um lead problemático não pode derrubar o lote, e um
 * lead importado não pode ficar meio-gravado. É o que permite "lead sem origem →
 * rejeitado e a transação inteira revertida" ser um comportamento, e não um
 * comentário: o `throw` de `DadosIncompletos` desfaz tudo o que aquele lead fez.
 *
 * Regras que este arquivo materializa:
 *
 * - **E.164 validado antes de qualquer escrita** (`^\+[1-9][0-9]{7,14}$`), igual ao
 *   CHECK do banco. Lead inválido é rejeitado com log — nunca persistido.
 * - **`originSource`, `legalBasis` e `purpose` são obrigatórios** (R-064). Faltou
 *   um → `DadosIncompletos` e a transação reverte. Lead sem lastro é lead sem base
 *   legal.
 * - **O `opt_out` do banco é autoritativo.** O import NUNCA copia o `opt_out` do
 *   registro EXCLUDED para a coluna: a fonte só pode ATIVAR (`false`→`true`), e nesse
 *   caso grava o evento em `optout_ledger` (AR-005, R-024). Um caça-leads
 *   desatualizado não reativa quem pediu para sair.
 * - **Dedup por `phone_number` com `wa_jid` preenchido** (LEAD-02): dois registros
 *   para o mesmo telefone produzem duas conversas, e o gate não tem como
 *   reconciliá-las.
 * - **Cota de novos contatos** reservada atomicamente (D-04/D-05); cota negada →
 *   o lead volta para o próximo dia útil (`semCota = true`) e o lote PARA.
 */
import { eq, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import type { Lead, LeadSourcePort } from "../domain/ports/LeadSourcePort.js";
import type { Db } from "../infra/db/client.js";
import { reserveNewContactQuota } from "../infra/db/queries/counters.js";
import {
	channelAccounts,
	conversations,
	leads,
	optoutLedger,
	statusHistory,
} from "../infra/db/schema.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger("lead_importer");

/** Mesmo formato do CHECK `leads_phone_number_check` (0000_initial.sql). */
const E164_REGEX = /^\+[1-9][0-9]{7,14}$/;

/** Lead rejeitado por falta de validação/persistência — não é erro do lote. */
export class DadosIncompletos extends Error {
	constructor(mensagem: string) {
		super(mensagem);
		this.name = "DadosIncompletos";
	}
}

/** Cota de novos contatos esgotada: o lead volta para o próximo dia útil. */
export class CotaEsgotada extends Error {
	constructor(mensagem: string) {
		super(mensagem);
		this.name = "CotaEsgotada";
	}
}

export interface ImportLimits {
	/** Teto operacional de novos contatos/dia (R-023/D-04). */
	readonly dailyLeadLimit: number;
	/** Fuso para derivar o dia de `daily_counters` (D-05). */
	readonly tz: string;
	/** Instante de referência; injetável em teste. */
	readonly agora?: Date;
	/** Cap do servidor; ausente = "não sei" → só o limite de config governa (D-05). */
	readonly cap?: number;
}

export interface LeadDuplicado {
	readonly e164: string;
	readonly duplicateOf: string;
}

export interface ImportResultado {
	readonly importados: number;
	readonly duplicados: readonly LeadDuplicado[];
	readonly rejeitados: number;
	readonly semCota: boolean;
}

/** `YYYY-MM-DD` no fuso do negócio — a chave de `daily_counters`. */
const diaLocal = (agora: Date, tz: string): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(agora);

/** Grava o evento de opt-out na trilha append-only (R-024) — só quando houve mudança real. */
const gravarLedgerOptOut = async (
	db: Db,
	lead: Lead,
	leadId: string,
	agora: Date,
): Promise<void> => {
	await db.insert(optoutLedger).values({
		leadId,
		eventType: "opt_out",
		source: "manual",
		rawContent: JSON.stringify(lead.rawContent ?? { motivo: "provider" }),
		legalBasis: lead.legalBasis,
		purpose: lead.purpose,
		occurredAt: agora,
	});
};

/**
 * Importa os leads da fonte, um por transação.
 *
 * Devolve o resumo — não lança por lead problemático (rejeitado/duplicado/cota).
 * Só propaga erro REAL de infraestrutura (banco fora, por exemplo), porque esse
 * deve parar o lote em vez de retornar um resumo parcial que mente.
 */
export const importLeads = async (
	db: Db,
	source: LeadSourcePort,
	limits: ImportLimits,
): Promise<ImportResultado> => {
	const agora = limits.agora ?? new Date();
	// Cap ausente = sem teto de servidor; o limite de config governa (D-05).
	const cap = limits.cap ?? Number.MAX_SAFE_INTEGER;

	const entrantes = await source.fetchNewLeads();

	let importados = 0;
	let rejeitados = 0;
	let semCota = false;
	const duplicados: LeadDuplicado[] = [];

	for (const lead of entrantes) {
		// (a) E.164 — fora do formato é rejeitado ANTES de tocar o banco.
		if (!E164_REGEX.test(lead.e164)) {
			rejeitados += 1;
			log.warn(
				{ event: "lead_rejeitado", motivo: "e164_invalido" },
				"lead fora do formato E.164 — rejeitado",
			);
			continue;
		}

		try {
			await db.transaction(async (tx) => {
				// (b) LGPD: sem origem, base legal e finalidade não há lastro (R-064).
				if (!lead.originSource || !lead.legalBasis || !lead.purpose) {
					throw new DadosIncompletos(
						"lead sem originSource/legalBasis/purpose — R-064 exige registro de procedencia, base legal e finalidade",
					);
				}

				// (d) Dedup por telefone com `wa_jid` preenchido (LEAD-02).
				const existente = await tx.query.leads.findFirst({
					where: eq(leads.phoneNumber, lead.e164),
					columns: { id: true, waJid: true },
				});
				if (existente?.waJid) {
					duplicados.push({
						e164: lead.e164,
						duplicateOf: existente.id,
					});
					return;
				}

				// (c) INSERT ... ON CONFLICT DO UPDATE — o `opt_out` nunca é copiado do EXCLUDED.
				const upsert = await tx
					.insert(leads)
					.values({
						phoneNumber: lead.e164,
						name: lead.name ?? null,
						addressLine: lead.addressLine ?? null,
						originSource: lead.originSource,
						legalBasis: lead.legalBasis,
						purpose: lead.purpose,
						legalRegisteredAt: agora,
						optOut: lead.optOut === true,
					})
					.onConflictDoUpdate({
						target: leads.phoneNumber,
						set: {
							name: sql`excluded.name`,
							addressLine: sql`excluded.address_line`,
						},
					})
					.returning({ id: leads.id });
				const leadId = upsert[0]?.id;
				if (!leadId) {
					throw new Error("lead-importer: upsert de leads nao devolveu id");
				}

				// Opt-out da fonte: só ATIVA o banco (false→true) e só então registra o evento.
				if (lead.optOut === true) {
					const mudou = await tx.execute(sql`
						update leads set opt_out = true
						where phone_number = ${lead.e164} and opt_out = false
					`);
					const linhasAfetadas =
						(mudou as { rowCount?: number | null }).rowCount ?? 0;
					const novoComOptOut = existente === undefined;
					if (novoComOptOut || linhasAfetadas === 1) {
						await gravarLedgerOptOut(tx as unknown as Db, lead, leadId, agora);
					}
				}

				// (e) Cota de novos contatos — atômica e fail-closed.
				const reserva = await reserveNewContactQuota(
					tx as unknown as Db,
					diaLocal(agora, limits.tz),
					limits.dailyLeadLimit,
					cap,
				);
				if (!reserva.allowed) {
					semCota = true;
					// O lead não é persistido hoje; conta como rejeição desta execução.
					rejeitados += 1;
					throw new CotaEsgotada(
						`cota de novos contatos esgotada (limite ${reserva.limit}) — lead devolvido para o proximo dia util`,
					);
				}

				// (f) Conversa + status_history `novo` na primeira importação do lead.
				const canal = await tx.query.channelAccounts.findFirst({
					where: eq(channelAccounts.phoneE164, env.CHANNEL_PHONE_E164),
					columns: { id: true },
				});
				if (!canal) {
					throw new Error(
						"lead-importer: channel_accounts ausente para o numero dedicado — o boot nao rodou",
					);
				}
				const conversaExistente = await tx.query.conversations.findFirst({
					where: eq(conversations.leadId, leadId),
					columns: { id: true },
				});
				if (!conversaExistente) {
					const novaConversa = await tx
						.insert(conversations)
						.values({ leadId, channelAccountId: canal.id })
						.returning({ id: conversations.id });
					const conversaId = novaConversa[0]?.id;
					if (conversaId) {
						await tx.insert(statusHistory).values({
							conversationId: conversaId,
							fromState: "novo",
							toState: "novo",
							changedBy: "system",
							reason: "importacao",
						});
					}
				}

				importados += 1;
			});
		} catch (erro) {
			if (erro instanceof CotaEsgotada) {
				// Cota esgotada: para o lote; o que sobrou volta para o próximo dia útil.
				log.warn(
					{ event: "lead_import_sem_cota", motivo: erro.message },
					"cota de novos contatos esgotada — lote interrompido",
				);
				break;
			}
			if (erro instanceof DadosIncompletos) {
				rejeitados += 1;
				log.warn(
					{ event: "lead_rejeitado", motivo: "dados_incompletos" },
					"lead sem lastro LGPD — rejeitado e transacao revertida",
				);
				continue;
			}
			throw erro;
		}
	}

	return { importados, duplicados, rejeitados, semCota };
};
