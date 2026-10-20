/**
 * Pipeline de 9 status do CRM (RN-078..RN-085, D-14, D-15, D-16 — CRM-01).
 *
 * O que este teste protege, em uma frase: o FUNIL é regra pura e testável sem
 * banco, e as duas invariantes mais caras do D-16 não dependem de ninguém se
 * lembrar delas — (1) `opt_out` nunca reativa, nem com correção manual;
 * (2) estado terminal só sai por `manual: true` (reativação auditada).
 *
 * Espelha o estilo de `tests/domain/transitions.test.ts`: varre o domínio inteiro
 * em loops em vez de afirmar caso a caso — um status novo em `PIPELINE_STATUS`
 * cai nos mesmos laços sem precisar de teste novo.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	exigeJustificativa,
	isMotivo,
	isPipelineStatus,
	MOTIVOS,
	PIPELINE_STATUS,
	type PipelineStatus,
	rotulo,
	rotuloMotivo,
	transicaoValida,
} from "../../src/domain/pipeline.js";

/** Semente fixa: falha de propriedade reproduzível. */
const SEMENTE = 20261020;

/** Para o laço de pares: o domínio como `readonly string[]`. */
const STATUS: readonly string[] = PIPELINE_STATUS;

const TERMINAIS: readonly PipelineStatus[] = ["fechado", "perdido"];

/** Pares (de, para) em que o AVANÇO automático é obrigatoriamente válido. */
const AVANCOS: ReadonlyArray<readonly [PipelineStatus, PipelineStatus]> = [
	["novo", "contatado"],
	["contatado", "respondeu"],
	["respondeu", "qualificado"],
	["qualificado", "aquecido"],
	["aquecido", "reuniao_agendada"],
	["reuniao_agendada", "proposta"],
	["proposta", "fechado"],
	["novo", "perdido"],
	["proposta", "perdido"],
	["aquecido", "fechado"],
];

describe("domínio do pipeline (D-14/D-15)", () => {
	it("PIPELINE_STATUS tem os 9 valores EXATOS de RN-078, na ordem do funil", () => {
		expect(PIPELINE_STATUS).toEqual([
			"novo",
			"contatado",
			"respondeu",
			"qualificado",
			"aquecido",
			"reuniao_agendada",
			"proposta",
			"fechado",
			"perdido",
		]);
	});

	it("MOTIVOS tem os 9 motivos EXATOS de D-15 — nunca vazio para status terminal", () => {
		// O CHECK de `conversations.closed_reason` (migration 0008) usa esta mesma
		// lista; divergir aqui é divergir do banco.
		expect(MOTIVOS).toEqual([
			"sem_resposta",
			"sem_interesse",
			"sem_verba",
			"sem_decisao",
			"concorrente",
			"fora_do_perfil",
			"opt_out",
			"bad_timing",
			"outro",
		]);
		expect(MOTIVOS.length).toBeGreaterThan(0);
		for (const terminal of TERMINAIS) {
			// "status terminal exige motivo" é meaningless sem motivo disponível:
			// cada terminal precisa de ao menos um motivo válido E de exigi-lo.
			expect(isPipelineStatus(terminal)).toBe(true);
			expect(exigeJustificativa(terminal)).toBe(true);
			for (const motivo of MOTIVOS) {
				expect(isMotivo(motivo)).toBe(true);
			}
		}
	});

	it("isPipelineStatus/isMotivo rejeitam valor fora do domínio (borda)", () => {
		expect(isPipelineStatus("novo")).toBe(true);
		expect(isPipelineStatus("NOVO")).toBe(false);
		expect(isPipelineStatus("qualificando")).toBe(false); // é state, não pipeline
		expect(isPipelineStatus(undefined)).toBe(false);
		expect(isMotivo("sem_resposta")).toBe(true);
		expect(isMotivo("desistiu")).toBe(false);
		expect(isMotivo(null)).toBe(false);
	});

	it("exigeJustificativa cobre exatamente os 4 status críticos de RN-082", () => {
		const criticos = STATUS.filter(exigeJustificativa);
		expect(criticos.sort()).toEqual(
			["fechado", "perdido", "proposta", "reuniao_agendada"].sort(),
		);
	});

	it("rotulo devolve pt-BR para os 9 status; rotuloMotivo para os 9 motivos", () => {
		expect(rotulo("reuniao_agendada")).toBe("Reunião agendada");
		expect(rotulo("novo")).toBe("Novo");
		expect(rotulo("perdido")).toBe("Perdido");
		for (const status of PIPELINE_STATUS) {
			expect(rotulo(status)).not.toBe(status);
			expect(rotulo(status).length).toBeGreaterThan(0);
		}
		for (const motivo of MOTIVOS) {
			expect(rotuloMotivo(motivo).length).toBeGreaterThan(0);
		}
	});
});

describe("transicaoValida — caminho automático (D-14/D-15)", () => {
	it("todos os avanços do funil são válidos sem manual (RN-080 avança sozinho)", () => {
		for (const [de, para] of AVANCOS) {
			expect(transicaoValida(de, para)).toBe(true);
		}
	});

	it("avanço automático NUNCA rebaixa o funil (retrocesso é manual)", () => {
		const rebaixos: ReadonlyArray<readonly [PipelineStatus, PipelineStatus]> = [
			["proposta", "aquecido"],
			["aquecido", "qualificado"],
			["qualificado", "respondeu"],
			["respondeu", "contatado"],
			["contatado", "novo"],
		];
		for (const [de, para] of rebaixos) {
			expect(transicaoValida(de, para)).toBe(false);
			// ...mas a correção manual do Admin passa (RN-083).
			expect(transicaoValida(de, para, { manual: true })).toBe(true);
		}
	});

	it("mesmo status não é transição (nem manual — status_history registra troca, não edição)", () => {
		for (const status of STATUS) {
			expect(transicaoValida(status, status)).toBe(false);
			expect(transicaoValida(status, status, { manual: true })).toBe(false);
		}
	});

	it("valor fora dos 9 status é recusado mesmo com manual (domínio primeiro)", () => {
		expect(transicaoValida("qualificando", "aquecido")).toBe(false); // state, não pipeline
		expect(transicaoValida("NOVO", "contatado")).toBe(false);
		expect(transicaoValida("novo", "encerrado")).toBe(false);
		expect(transicaoValida("novo", "contratado")).toBe(false); // typo
		// 'qualificando'/'encerrado' são valores de `state` (FSM), não de funil —
		// manual não encolhe o domínio.
		expect(transicaoValida("novo", "qualificando", { manual: true })).toBe(
			false,
		);
		expect(transicaoValida("encerrado", "novo", { manual: true })).toBe(false);
		expect(transicaoValida(undefined as never, "novo")).toBe(false);
	});
});

describe("transicaoValida — D-16: terminal e opt_out", () => {
	it("SAÍDA de terminal sem manual: SEMPRE rejeitada (fechado e perdido)", () => {
		for (const de of TERMINAIS) {
			for (const para of STATUS) {
				// Inclui perdido → novo e fechado → proposta: sem manual, nunca.
				expect(transicaoValida(de, para)).toBe(false);
				expect(transicaoValida(de, para, {})).toBe(false);
			}
		}
	});

	it("perdido → novo COM manual: true é aceita como reativação auditada (RN-085)", () => {
		expect(transicaoValida("perdido", "novo", { manual: true })).toBe(true);
		// E a auditoria é obrigação de quem grava (queries/crm.ts) — aqui só a regra.
	});

	it("saída de terminal com manual é liberada (RN-083: correção a qualquer momento)", () => {
		expect(transicaoValida("fechado", "proposta", { manual: true })).toBe(true);
		expect(transicaoValida("fechado", "novo", { manual: true })).toBe(true);
	});

	it("opt_out: QUALQUER transição é rejeitada — inclusive manual (D-16/AR-005)", () => {
		// O pior caso primeiro: a única porta que uma correção manual abriria.
		expect(
			transicaoValida("perdido", "novo", { manual: true, optOut: true }),
		).toBe(false);
		expect(
			transicaoValida("novo", "contatado", { manual: true, optOut: true }),
		).toBe(false);
		expect(transicaoValida("novo", "contatado", { optOut: true })).toBe(false);
		// Varre o domínio inteiro: nenhum (de, para) sobrevive a opt_out.
		for (const de of STATUS) {
			for (const para of STATUS) {
				expect(transicaoValida(de, para, { manual: true, optOut: true })).toBe(
					false,
				);
				expect(transicaoValida(de, para, { optOut: true })).toBe(false);
			}
		}
	});
});

describe("property tests (seed 20261020)", () => {
	it("sem manual, (de,para) fora da ordem crescente NUNCA é válida (numRuns 300)", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...STATUS),
				fc.constantFrom(...STATUS),
				(de, para) => {
					const indice = (s: string) => STATUS.indexOf(s);
					fc.pre(indice(para) <= indice(de)); // não é avanço
					fc.pre(de !== para);
					expect(transicaoValida(de, para)).toBe(false);
				},
			),
			{ numRuns: 300, seed: SEMENTE },
		);
	});

	it("com manual e sem opt_out, qualquer par de domínio distinto é válido (numRuns 300)", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...STATUS),
				fc.constantFrom(...STATUS),
				(de, para) => {
					fc.pre(de !== para);
					expect(transicaoValida(de, para, { manual: true })).toBe(true);
				},
			),
			{ numRuns: 300, seed: SEMENTE },
		);
	});
});
