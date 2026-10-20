/**
 * Copiloto + nota automática (03-05 Task 2, FLUP-06/CRM-03).
 *
 * Prova o contrato de `application/copilot.ts` sobre a porta roteirizada:
 *   - sugestão vira RASCUNHO (`ai_suggestion`/`suggested`) com `llm_runs`,
 *     NUNCA envio (`direction='out' AND status='sent'` = 0);
 *   - canário divergente / falha de provider / texto vazio → fail-closed:
 *     nenhum rascunho, evento de falha em `event_log`, geração não insiste;
 *   - texto que viola anti-requisito → gate bloqueia ANTES do rascunho
 *     (`blocked_attempts` com o mesmo marcador de um envio real);
 *   - nota automática grava `lead_notes(author_type='ia')` com as três seções,
 *     `llm_runs` sem `message_id`, e NÃO grava nada se faltar seção;
 *   - idempotência ancorada no instante: repetir no mesmo instante → 1 rascunho.
 *
 * Transação revertida por sentinela (mesmo padrão de `shadow.test.ts`):
 * `messages`/`llm_runs`/`event_log`/`lead_notes` são append-only.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	gerarNotaAutomatica,
	gerarSugestao,
} from "../../src/application/copilot.js";
import { env } from "../../src/config/env.js";
import {
	closeDb,
	type Db,
	type OpenDb,
	openDb,
} from "../../src/infra/db/client.js";
import {
	type RoteiroScripted,
	scriptedLlmAdapter,
} from "../../src/infra/llm/scripted-adapter.js";

/** Terça 29/09/2026 13h SP → dia útil dentro da janela (fixtures do gate). */
const AGORA = new Date("2026-09-29T16:00:00.000Z");

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
	readonly leadId: string;
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

	const phone = telefone();
	const lead = primeiro(
		rows<{ id: string }>(
			await tx.execute(sql`
				insert into leads (
					phone_number, origin_source, legal_basis, purpose,
					legal_registered_at, first_contact_by_human
				)
				values (
					${phone}, 'teste', 'legitimate_interest', 'prospeccao',
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
				values (${lead.id}, ${conta.id}, 'qualificando', 'bot_active')
				returning id
			`),
		),
	);

	return { leadId: lead.id, conversationId: conversa.id };
};

const deps = (tx: Db, roteiro: RoteiroScripted = {}) => ({
	db: tx,
	llm: scriptedLlmAdapter(roteiro),
	agora: () => AGORA,
});

const contarAiSuggestion = async (
	tx: Db,
	conversationId: string,
): Promise<number> => {
	const r = await tx.execute(sql`
		select count(*)::int as n from messages
		where conversation_id = ${conversationId}
			and origin = 'ai_suggestion'
			and status = 'suggested'
	`);
	return primeiro(rows<{ n: number }>(r)).n;
};

const contarEnviadas = async (
	tx: Db,
	conversationId: string,
): Promise<number> => {
	const r = await tx.execute(sql`
		select count(*)::int as n from messages
		where conversation_id = ${conversationId}
			and direction = 'out'
			and status = 'sent'
	`);
	return primeiro(rows<{ n: number }>(r)).n;
};

const contarEventos = async (tx: Db, tipo: string): Promise<number> => {
	const r = await tx.execute(sql`
		select count(*)::int as n from event_log where event_type = ${tipo}
	`);
	return primeiro(rows<{ n: number }>(r)).n;
};

const TEXTO_COM_SECOES =
	"Resumo\nLead demonstrou interesse em presença digital.\nObjeções\nNenhuma por enquanto.\nPróximos passos\nEnviar um exemplo de site amanhã.";

describe("gerarSugestao — copiloto (FLUP-06/R-014)", () => {
	it("caminho feliz: 1 rascunho ai_suggestion/suggested, =1 llm_runs, 0 enviadas", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const resultado = await gerarSugestao(fx.conversationId, deps(tx));

			expect(resultado.ok).toBe(true);
			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(1);
			expect(await contarEnviadas(tx, fx.conversationId)).toBe(0);
			expect(await contarEventos(tx, "copilot_sugestao_gerada")).toBe(1);

			const runs = rows<{ n: number }>(
				await tx.execute(sql`
					select count(*)::int as n from llm_runs r
					join messages m on m.id = r.message_id
					where m.conversation_id = ${fx.conversationId}
				`),
			);
			expect(primeiro(runs).n).toBeGreaterThanOrEqual(1);
		});
	});

	it("canário divergente → fail-closed: 0 rascunho, evento de falha", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const resultado = await gerarSugestao(
				fx.conversationId,
				deps(tx, { canarioRecebido: () => "CANARIO-divergente" }),
			);

			expect(resultado.ok).toBe(false);
			if (!resultado.ok) expect(resultado.motivo).toBe("canario_divergente");
			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
			expect(await contarEventos(tx, "copilot_sugestao_falhou")).toBe(1);
		});
	});

	it("falha de provider → fail-closed: 0 rascunho, motivo llm_falhou", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const resultado = await gerarSugestao(
				fx.conversationId,
				deps(tx, { falhaGeracao: { kind: "timeout", detail: "estourou" } }),
			);

			expect(resultado.ok).toBe(false);
			if (!resultado.ok) expect(resultado.motivo).toBe("llm_falhou");
			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
		});
	});

	it("texto gerado com preço → gate bloqueia ANTES do rascunho (blocked_attempts)", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const resultado = await gerarSugestao(
				fx.conversationId,
				deps(tx, { geracao: { replyText: "Fica R$ 3.500 e te mando o PDF" } }),
			);

			expect(resultado.ok).toBe(false);
			if (!resultado.ok) {
				expect(resultado.motivo).toBe("gate_bloqueou");
				expect(resultado.blockedReason).toBe("ar001_preco");
			}
			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(0);
			const blocked = rows<{ n: number }>(
				await tx.execute(sql`
					select count(*)::int as n from blocked_attempts
					where conversation_id = ${fx.conversationId}
				`),
			);
			expect(primeiro(blocked).n).toBe(1);
		});
	});

	it("conversa inexistente → conversa_nao_encontrada, LLM nem é chamada", async () => {
		await emTransacaoRevertida(async (tx) => {
			const llm = scriptedLlmAdapter({});
			const resultado = await gerarSugestao(
				"00000000-0000-4000-8000-000000000000",
				{ db: tx, llm, agora: () => AGORA },
			);
			expect(resultado.ok).toBe(false);
			if (!resultado.ok)
				expect(resultado.motivo).toBe("conversa_nao_encontrada");
			expect(llm.chamadas).toEqual([]);
		});
	});

	it("idempotência: duas gerações no mesmo instante → 1 rascunho", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			await gerarSugestao(fx.conversationId, deps(tx));
			await gerarSugestao(fx.conversationId, deps(tx));
			expect(await contarAiSuggestion(tx, fx.conversationId)).toBe(1);
		});
	});
});

describe("gerarNotaAutomatica — nota da IA (CRM-03/R-043)", () => {
	it("caminho feliz: nota em lead_notes(author_type='ia'), llm_runs sem message_id", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const resultado = await gerarNotaAutomatica(
				fx.conversationId,
				deps(tx, { geracao: { replyText: TEXTO_COM_SECOES } }),
			);

			expect(resultado.ok).toBe(true);

			const notas = rows<{ body: string; author_type: string }>(
				await tx.execute(sql`
					select body, author_type from lead_notes
					where lead_id = ${fx.leadId}
				`),
			);
			const nota = primeiro(notas);
			expect(nota.author_type).toBe("ia");
			expect(nota.body).toContain("Resumo");
			expect(nota.body).toContain("Objeções");
			expect(nota.body).toContain("Próximos passos");

			const runs = rows<{ n: number }>(
				await tx.execute(sql`
					select count(*)::int as n from llm_runs
					where message_id is null and prompt_version = '03-05'
				`),
			);
			expect(primeiro(runs).n).toBe(1);
		});
	});

	it("nota sem as três seções → fail-closed: nenhuma nota, evento nota_ia_invalida", async () => {
		await emTransacaoRevertida(async (tx) => {
			const fx = await semear(tx);
			const resultado = await gerarNotaAutomatica(
				fx.conversationId,
				deps(tx, {
					geracao: { replyText: "Conversa tranquila, sem detalhes." },
				}),
			);

			expect(resultado.ok).toBe(false);
			if (!resultado.ok) expect(resultado.motivo).toBe("nota_invalida");
			const notas = rows<{ n: number }>(
				await tx.execute(sql`
					select count(*)::int as n from lead_notes where lead_id = ${fx.leadId}
				`),
			);
			expect(primeiro(notas).n).toBe(0);
			expect(await contarEventos(tx, "nota_ia_invalida")).toBe(1);
		});
	});

	it("conversa inexistente → conversa_nao_encontrada, nada gravado", async () => {
		await emTransacaoRevertida(async (tx) => {
			const resultado = await gerarNotaAutomatica(
				"00000000-0000-4000-8000-000000000001",
				deps(tx),
			);
			expect(resultado.ok).toBe(false);
			if (!resultado.ok)
				expect(resultado.motivo).toBe("conversa_nao_encontrada");
		});
	});
});
