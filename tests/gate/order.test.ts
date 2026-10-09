/**
 * Ordem canônica do gate — `docs/10-anti-requisitos.md` §"Ordem de Avaliação no
 * Gate".
 *
 * O motivo gravado em `blocked_attempts.rule_reference` é o **primeiro** que
 * disparou. Este arquivo prova duas coisas que não podem divergir:
 *
 * 1. `GUARD_ORDER` (o contrato plano, em `evaluate-policy.ts`) bate com
 *    `GUARD_SLOTS` (a execução, em `guard-order.ts`). Se alguém reordenar um e
 *    esquecer o outro, falha aqui.
 * 2. Quando duas guardas disparam juntas, vence a de índice menor. O teste
 *    constrói um input que viola **as duas** e verifica qual `reason` sai,
 *    par a par, mais alguns pares não-adjacentes que a doc cita.
 *
 * O `patch` funde as duas violações: `lead`/`conversation`/`context` por merge
 * raso e `outbound.text` por concatenação — o texto do input tem de conter os
 * dois gatilhos, não só o do último.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	evaluatePolicy,
	GUARD_ORDER,
	REASONS_PENDENTES_01_04,
} from "../../src/domain/gate/evaluate-policy.js";
import { GUARD_SLOTS } from "../../src/domain/gate/guard-order.js";
import type { GateInput, GateReason } from "../../src/domain/gate/types.js";
import { instanteEmZona, TZ, validInbound } from "./fixtures.js";

type Violacao = {
	lead?: Partial<GateInput["lead"]>;
	conversation?: Partial<GateInput["conversation"]>;
	outbound?: Partial<GateInput["outbound"]>;
	context?: Partial<GateInput["context"]>;
};

/** Fora da janela: terça 29/09/2026 às 18h em São Paulo (fecha às 17h). */
const FORA_DA_JANELA = instanteEmZona(TZ, 2026, 9, 29, 18, 0);

/**
 * Uma violação por motivo, com o termo de conteúdo escolhido para casar **só**
 * aquele guard (evita que o teste de ordem passe pelo motivo errado).
 */
const VIOL: Partial<Record<GateReason, Violacao>> = {
	kill_switch_ativo: { context: { killSwitch: true } },
	r001_primeiro_contato_nao_humano: { lead: { firstContactByHuman: false } },
	lead_numero_invalido: { lead: { waValidationState: "invalido" } },
	ar011_base_legal: { lead: { legalRegisteredAt: null } },
	ar005_opt_out: { lead: { optOut: true } },
	ar010_handoff_ativo: { conversation: { handoffActive: true } },
	ar009_midia_recebida: { conversation: { pendingMediaBlock: true } },
	ar001_preco: { outbound: { text: "o valor é R$ 3.500" } },
	ar002_proposta: { outbound: { text: "segue a proposta" } },
	ar012_preco_como_objecao: { outbound: { text: "depois a gente negocia" } },
	ar003_agendamento: { outbound: { text: "vamos agendar a reunião" } },
	ar004_midia_saida: { outbound: { text: "te mando o pdf" } },
	ar006_revelacao_automacao: {
		outbound: { text: "sou um bot de atendimento" },
	},
	ar007_fora_da_janela: { context: { now: FORA_DA_JANELA } },
	ar008_limite_diario: {
		context: { dailyMessageLimit: 1, dailyMessageCap: 1, sentToday: 1 },
	},
};

const violacao = (reason: GateReason): Violacao => {
	const v = VIOL[reason];
	if (!v) throw new Error(`sem violação de teste para ${reason}`);
	return v;
};

/** Acesso a `GUARD_ORDER[i]` com `noUncheckedIndexedAccess`, sem `!` cego. */
const motivoEm = (i: number): GateReason => {
	const reason = GUARD_ORDER[i];
	if (reason === undefined) throw new Error(`sem motivo no índice ${i}`);
	return reason;
};

const patch = (inicio: Violacao, fim: Violacao): Violacao => ({
	lead: { ...inicio.lead, ...fim.lead },
	conversation: { ...inicio.conversation, ...fim.conversation },
	outbound: {
		...inicio.outbound,
		...fim.outbound,
		text: `${inicio.outbound?.text ?? ""} ${fim.outbound?.text ?? ""}`.trim(),
		parts: [...(inicio.outbound?.parts ?? []), ...(fim.outbound?.parts ?? [])],
	},
	context: { ...inicio.context, ...fim.context },
});

const avaliar = (v: Violacao) =>
	evaluatePolicy(
		validInbound({
			lead: v.lead,
			conversation: v.conversation,
			outbound: v.outbound,
			context: v.context,
		}),
	);

describe("ordem canônica do gate", () => {
	it("GUARD_ORDER bate com GUARD_SLOTS, posição a posição", () => {
		expect(GUARD_ORDER).toEqual(GUARD_SLOTS.map((s) => s.reason));
	});

	it("não há slot de guarda nulo depois do 01-04", () => {
		expect(REASONS_PENDENTES_01_04).toEqual([]);
	});

	it("cada par adjacente: o índice menor vence quando os dois disparam", () => {
		for (let i = 0; i < GUARD_ORDER.length - 1; i++) {
			const anterior = violacao(motivoEm(i));
			const seguinte = violacao(motivoEm(i + 1));
			const decisao = avaliar(patch(anterior, seguinte));
			expect(decisao).toMatchObject({
				action: "block",
				reason: motivoEm(i),
			});
		}
	});

	it("pares não-adjacentes citados na doc seguem o índice", () => {
		// AR-001 (índice 7) vence AR-007 (13): citar preço é mais grave que a janela.
		expect(
			avaliar(patch(violacao("ar001_preco"), violacao("ar007_fora_da_janela"))),
		).toMatchObject({ action: "block", reason: "ar001_preco" });

		// AR-010 (índice 5) vence AR-001 (7): silêncio pós-handoff é anterior.
		expect(
			avaliar(patch(violacao("ar010_handoff_ativo"), violacao("ar001_preco"))),
		).toMatchObject({ action: "block", reason: "ar010_handoff_ativo" });
	});

	it("property: para qualquer par (i, i+1) gerado, o menor índice vence", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: GUARD_ORDER.length - 2 }), (i) => {
				const decisao = avaliar(
					patch(violacao(motivoEm(i)), violacao(motivoEm(i + 1))),
				);
				expect(decisao).toMatchObject({
					action: "block",
					reason: motivoEm(i),
				});
			}),
			{ seed: 20260928, numRuns: 500 },
		);
	});
});
