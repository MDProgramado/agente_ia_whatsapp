/**
 * Choke-point de mascaramento de PII (D-16, Pitfall 4, T-02-01).
 *
 * A regra que este teste sustenta: `prompt-builder.ts` é o ÚNICO módulo que
 * formata entrada para a LLM, e ele mascara TODO o payload de egresso — contexto
 * do lead, histórico, última mensagem e 1ª mensagem do Admin. Mascarar só o
 * `leadContext` vazaria PII que o próprio lead escreveu na conversa.
 *
 * O nome do lead é MANTIDO (a persona precisa dele); telefone e endereço viram
 * placeholder.
 */
import { describe, expect, it } from "vitest";
import {
	buildExtractPrompt,
	buildGeneratePrompt,
	maskPii,
	type PayloadLlm,
} from "../../src/domain/llm/prompt-builder.js";

const TELEFONE_LEAD = "+5511900000001";
const ENDERECO_LEAD = "Rua das Flores, 123";

const payloadCru = (): PayloadLlm => ({
	lead: {
		name: "João Silva",
		phoneNumber: TELEFONE_LEAD,
		addressLine: ENDERECO_LEAD,
	},
	// A 1ª mensagem do Admin também carrega o telefone — todo egresso é mascarado.
	adminPrimeiraMensagem:
		"Olá João, sou consultor. Pode me chamar em +5511900000001",
	historico: [
		{ autor: "lead", texto: "Oi, moro na Rua das Flores, 123" },
		{ autor: "admin", texto: "Perfeito, obrigado" },
	],
	// Telefone escrito PELO LEAD na conversa — também tem de sumir (Pitfall 4).
	ultimaMensagem: "Meu telefone é (71) 98921-1292, pode me ligar",
});

/** Sem nenhum sequência de 8+ dígitos, nem prefixo `+55`. */
const SEM_TELEFONE = /\d{4,5}[\s.-]?\d{4}|\+55/;

describe("maskPii", () => {
	it("mascara telefone e endereço do contexto do lead, MANTENDO o nome", () => {
		const m = maskPii(payloadCru());
		expect(m.lead.name).toBe("João Silva");
		expect(m.lead.phoneNumber).not.toContain("98921");
		expect(m.lead.addressLine).not.toContain("Flores");
	});

	it("mascara a 1ª mensagem do Admin", () => {
		expect(maskPii(payloadCru()).adminPrimeiraMensagem).not.toMatch(
			SEM_TELEFONE,
		);
	});

	it("mascara o histórico de conversa", () => {
		const m = maskPii(payloadCru());
		expect(m.historico[0]?.texto).not.toContain("Flores");
		expect(m.historico[0]?.texto).not.toMatch(SEM_TELEFONE);
	});

	it("mascara a última mensagem, inclusive telefone escrito pelo lead (Pitfall 4)", () => {
		expect(maskPii(payloadCru()).ultimaMensagem).not.toMatch(SEM_TELEFONE);
	});

	it("não sobra PII crua em NENHUM campo de texto do payload mascarado", () => {
		const m = maskPii(payloadCru());
		const todoTexto = [
			m.lead.phoneNumber,
			m.lead.addressLine,
			m.adminPrimeiraMensagem,
			m.ultimaMensagem,
			...m.historico.map((h) => h.texto),
		]
			.filter((t): t is string => typeof t === "string")
			.join(" ");
		expect(todoTexto).not.toMatch(SEM_TELEFONE);
		expect(todoTexto).not.toContain("Flores");
	});

	it("é idempotente: mascarar o já mascarado não muda nada", () => {
		const uma = maskPii(payloadCru());
		expect(maskPii(uma)).toEqual(uma);
	});
});

describe("buildExtractPrompt / buildGeneratePrompt mascaram SEMPRE", () => {
	it("o prompt de extração não contém PII crua e carrega o canário", () => {
		const p = buildExtractPrompt(payloadCru(), "CANARIO-extra");
		expect(p).not.toMatch(SEM_TELEFONE);
		expect(p).not.toContain("Flores");
		expect(p).toContain("CANARIO-extra");
	});

	it("o prompt de geração não contém PII crua, cita o estado resolvido e o canário", () => {
		const p = buildGeneratePrompt(payloadCru(), "qualificando", "CANARIO-ger");
		expect(p).not.toMatch(SEM_TELEFONE);
		expect(p).not.toContain("Flores");
		expect(p).toContain("qualificando");
		expect(p).toContain("CANARIO-ger");
	});
});
