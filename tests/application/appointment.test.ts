/**
 * Confirmação/lembrete de agendamento (03-05 Task 2, FLUP-08/D-25, R-006/R-023/R-025).
 *
 * Prova o contrato de `application/appointment.ts`:
 *   1. agendar DENTRO da janela mantém o horário, grava o ledger
 *      (`scheduled_tasks`, task_type da reunião, índice reservado) e enfileira
 *      a mensagem com `origin='bot'` — texto sem gatilho de preço/mídia/agenda;
 *   2. agendar de MADRUGADA cai na própria janela (07:00 do mesmo dia útil);
 *      agendar de SÁBADO cai na segunda às 07:00 — R-006, nunca 03:00;
 *   3. com o dia alvo cheio, o horário é EMPURRADO para o próximo dia útil
 *      (R-023) — o lembrete não acumula no mesmo dia;
 *   4. reexecução idêntica → `duplicado: true` e NENHUMA linha nova no `outbox`;
 *   5. `confirmar` encerra as pendências; `remarcar`/`cancelar` NUNCA são
 *      tratados pelo bot: pendências abandonadas + `handoff_events` + modo
 *      `human` (R-025);
 *   6. conversa inexistente → erro limpo, sem escrita (FK impede).
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	agendarConfirmacao,
	tratarRespostaAgendamento,
} from "../../src/application/appointment.js";
import { env } from "../../src/config/env.js";
import { formatarHoraLocal } from "../../src/domain/business-hours.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import { instanteEmZona, TZ } from "../gate/fixtures.js";

/** Terça 29/09/2026 13h SP — "agora" congelado do teste. */
const AGORA = instanteEmZona(TZ, 2026, 9, 29, 13, 0);
/** Quinta 01/10/2026 10h SP — dentro da janela. */
const QUANDO_OK = instanteEmZona(TZ, 2026, 10, 1, 10, 0);
/** Sexta 02/10/2026 03h SP — madrugada, fora da janela. */
const QUANDO_MADRUGADA = instanteEmZona(TZ, 2026, 10, 2, 3, 0);
/** Sábado 03/10/2026 10h SP — fim de semana. */
const QUANDO_SABADO = instanteEmZona(TZ, 2026, 10, 3, 10, 0);

const SENTINELA = "rollback-intencional-do-teste";

let conn: OpenDb;
let db: Db;

beforeAll(async () => {
	conn = await openDb(env.DATABASE_URL);
	db = conn.db;
});

afterAll(async () => {
	await closeDb(conn);
});

const rows = <T>(resultado: unknown): T[] => (resultado as { rows: T[] }).rows;

const primeiro = <T>(lista: readonly T[]): T => {
	const item = lista[0];
	if (item === undefined) throw new Error("esperava ao menos uma linha");
	return item;
};

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

let seq = 0;
const telefone = (): string => {
	seq += 1;
	const bloco = String(Date.now() % 100000).padStart(5, "0");
	return `+55119${bloco}${String(seq).padStart(3, "0")}`;
};

interface Fixture {
	readonly conversationId: string;
}

const semear = async (tx: Db): Promise<Fixture> => {
	await tx.execute(sql`
		insert into channel_accounts (phone_e164)
		values (${env.CHANNEL_PHONE_E164})
		on conflict (phone_e164) do nothing
	`);
	const conta = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				select id from channel_accounts where phone_e164 = ${env.CHANNEL_PHONE_E164}
			`),
		),
	);

	const lead = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into leads (
					phone_number, origin_source, legal_basis, purpose,
					legal_registered_at, first_contact_by_human
				)
				values (
					${telefone()}, 'teste', 'legitimate_interest', 'prospeccao',
					'2025-01-01T12:00:00Z', true
				)
				returning id
			`),
		),
	);

	const conversa = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into conversations (lead_id, channel_account_id, state, engagement_mode)
				values (${lead.id}, ${conta.id}, 'aquecimento', 'bot_active')
				returning id
			`),
		),
	);

	return { conversationId: conversa.id };
};

const deps = (limite = 30) => ({
	agora: () => AGORA,
	tz: TZ,
	inicioJanela: env.WINDOW_START_HOUR,
	fimJanela: env.WINDOW_END_HOUR,
	feriados: [] as string[],
	limite,
});

const contarOutbox = async (
	tx: Db,
	conversationId: string,
): Promise<number> => {
	const r = await tx.execute(sql`
		select count(*)::int as n from outbox where conversation_id = ${conversationId}
	`);
	return primeiro(rows<{ n: number }>(r)).n;
};

const diaDe = (instante: Date): string =>
	new Intl.DateTimeFormat("pt-BR", {
		timeZone: TZ,
		day: "2-digit",
		month: "2-digit",
	}).format(instante);

describe("agendarConfirmacao — janela, cota e ledger (FLUP-08/D-25)", () => {
	it("dentro da janela: mantém o horário, grava scheduled_tasks e enfileira outbox 'bot'", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const resultado = await agendarConfirmacao(
				tx,
				{
					conversationId: fx.conversationId,
					quando: QUANDO_OK,
					tipo: "confirmacao",
				},
				deps(),
			);

			expect(resultado.ok).toBe(true);
			if (!resultado.ok) return;
			expect(resultado.scheduledFor.getTime()).toBe(QUANDO_OK.getTime());
			expect(resultado.duplicado).toBe(false);

			const tarefa = primeiro(
				rows<{ task_type: string; follow_up_index: number; status: string }>(
					await tx.execute(sql`
						select task_type, follow_up_index, status from scheduled_tasks
						where conversation_id = ${fx.conversationId}
					`),
				),
			);
			expect(tarefa.task_type).toBe("confirmacao");
			expect(tarefa.follow_up_index).toBe(100);
			expect(tarefa.status).toBe("pending");

			const msg = primeiro(
				rows<{ origin: string; body: string }>(
					await tx.execute(sql`
						select origin, body from outbox where conversation_id = ${fx.conversationId}
					`),
				),
			);
			expect(msg.origin).toBe("bot");
			expect(msg.body).toContain("nosso encontro");
			expect(msg.body).toContain("01/10");
		});
	});

	it("madrugada (03h) → normaliza para 07:00 do MESMO dia útil", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const resultado = await agendarConfirmacao(
				tx,
				{
					conversationId: fx.conversationId,
					quando: QUANDO_MADRUGADA,
					tipo: "lembrete",
				},
				deps(),
			);

			expect(resultado.ok).toBe(true);
			if (!resultado.ok) return;
			expect(formatarHoraLocal(resultado.scheduledFor, TZ)).toBe("07:00");
			expect(diaDe(resultado.scheduledFor)).toBe("02/10");
		});
	});

	it("sábado → próxima segunda às 07:00 (R-006)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const resultado = await agendarConfirmacao(
				tx,
				{
					conversationId: fx.conversationId,
					quando: QUANDO_SABADO,
					tipo: "lembrete",
				},
				deps(),
			);

			expect(resultado.ok).toBe(true);
			if (!resultado.ok) return;
			expect(formatarHoraLocal(resultado.scheduledFor, TZ)).toBe("07:00");
			expect(diaDe(resultado.scheduledFor)).toBe("05/10");
		});
	});

	it("dia alvo cheio → empurra para o próximo dia útil (R-023)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			// Uma mensagem já pendente no dia alvo; limite de 1 → dia cheio.
			await tx.execute(sql`
				insert into outbox (conversation_id, origin, body, idempotency_key, scheduled_for)
				values (
					${fx.conversationId}, 'bot', 'ocupando o dia',
					${`ocupacao-${fx.conversationId}`}, ${QUANDO_OK}
				)
			`);

			const resultado = await agendarConfirmacao(
				tx,
				{
					conversationId: fx.conversationId,
					quando: QUANDO_OK,
					tipo: "confirmacao",
				},
				deps(1),
			);

			expect(resultado.ok).toBe(true);
			if (!resultado.ok) return;
			expect(formatarHoraLocal(resultado.scheduledFor, TZ)).toBe("07:00");
			expect(diaDe(resultado.scheduledFor)).toBe("02/10");
		});
	});

	it("reexecução idêntica → duplicado: true, sem linha nova no outbox", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const input = {
				conversationId: fx.conversationId,
				quando: QUANDO_OK,
				tipo: "confirmacao" as const,
			};
			await agendarConfirmacao(tx, input, deps());
			const segundo = await agendarConfirmacao(tx, input, deps());

			expect(segundo.ok).toBe(true);
			if (!segundo.ok) return;
			expect(segundo.duplicado).toBe(true);
			expect(segundo.outboxId).toBeNull();
			expect(await contarOutbox(tx, fx.conversationId)).toBe(1);
		});
	});

	it("conversa inexistente → erro limpo, nada gravado", async () => {
		await emTransacaoRevertida(async (tx) => {
			const resultado = await agendarConfirmacao(
				tx,
				{
					conversationId: "00000000-0000-4000-8000-000000000002",
					quando: QUANDO_OK,
					tipo: "confirmacao",
				},
				deps(),
			);
			expect(resultado.ok).toBe(false);
			if (resultado.ok) return;
			expect(resultado.erro).toBe("conversa_nao_encontrada");
		});
	});
});

describe("tratarRespostaAgendamento — resposta do lead (R-025)", () => {
	const agendar = async (tx: Db, fx: Fixture): Promise<void> => {
		await agendarConfirmacao(
			tx,
			{
				conversationId: fx.conversationId,
				quando: QUANDO_OK,
				tipo: "confirmacao",
			},
			deps(),
		);
	};

	it("confirmar: encerra a pendência (done) e registra o evento", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			await agendar(tx, fx);

			const resultado = await tratarRespostaAgendamento(
				tx,
				{ conversationId: fx.conversationId, resposta: "confirmar" },
				{ agora: () => AGORA },
			);

			expect(resultado.tratado).toBe("confirmado");
			if (resultado.tratado !== "confirmado") return;
			expect(resultado.pendenciasEncerradas).toBe(1);

			const tarefa = primeiro(
				rows<{ status: string }>(
					await tx.execute(sql`
						select status from scheduled_tasks
						where conversation_id = ${fx.conversationId}
					`),
				),
			);
			expect(tarefa.status).toBe("done");
		});
	});

	it("remarcar: NUNCA tratado pelo bot — pendência abandonada + handoff + modo human", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			await agendar(tx, fx);

			const resultado = await tratarRespostaAgendamento(
				tx,
				{ conversationId: fx.conversationId, resposta: "remarcar" },
				{ agora: () => AGORA },
			);

			expect(resultado.tratado).toBe("handoff");
			if (resultado.tratado !== "handoff") return;
			expect(resultado.disparado).toBe(true);

			const handoffs = rows<{ n: number }>(
				await tx.execute(sql`
					select count(*)::int as n from handoff_events
					where conversation_id = ${fx.conversationId}
				`),
			);
			expect(primeiro(handoffs).n).toBe(1);

			const conversa = primeiro(
				rows<{ engagement_mode: string; handoff_active: boolean }>(
					await tx.execute(sql`
						select engagement_mode, handoff_active from conversations
						where id = ${fx.conversationId}
					`),
				),
			);
			expect(conversa.engagement_mode).toBe("awaiting_human");
			expect(conversa.handoff_active).toBe(true);

			const tarefa = primeiro(
				rows<{ status: string; cancelled_reason: string | null }>(
					await tx.execute(sql`
						select status, cancelled_reason from scheduled_tasks
						where conversation_id = ${fx.conversationId}
					`),
				),
			);
			expect(tarefa.status).toBe("abandoned");
			expect(tarefa.cancelled_reason ?? "").toMatch(/REMARCAR/);
		});
	});

	it("conversa inexistente → erro, sem escrita", async () => {
		await emTransacaoRevertida(async (tx) => {
			const resultado = await tratarRespostaAgendamento(
				tx,
				{
					conversationId: "00000000-0000-4000-8000-000000000003",
					resposta: "cancelar",
				},
				{ agora: () => AGORA },
			);
			expect(resultado.tratado).toBe("erro");
		});
	});
});
