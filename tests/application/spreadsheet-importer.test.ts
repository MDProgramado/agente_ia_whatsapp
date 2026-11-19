import { describe, expect, it } from "vitest";
import {
	normalizarParaE164,
	processarPlanilhaCsv,
} from "../../src/application/spreadsheet-importer.js";

describe("normalizarParaE164", () => {
	it("normaliza celular BR com DDD de 11 dígitos", () => {
		expect(normalizarParaE164("(11) 98765-4321")).toBe("+5511987654321");
	});

	it("normaliza fixo BR com DDD de 10 dígitos", () => {
		expect(normalizarParaE164("11 3456-7890")).toBe("+551134567890");
	});

	it("preserva quando já tem 55 e DDD", () => {
		expect(normalizarParaE164("5511987654321")).toBe("+5511987654321");
		expect(normalizarParaE164("+5511987654321")).toBe("+5511987654321");
	});

	it("retorna null para formatos inválidos", () => {
		expect(normalizarParaE164("123")).toBeNull();
		expect(normalizarParaE164("sem numero")).toBeNull();
	});
});

describe("processarPlanilhaCsv", () => {
	it("processa CSV com colunas em português e normaliza leads", () => {
		const csv = `Nome,Telefone,Nicho,Cidade
Dr. Carlos,11 98888-7777,Odontologia,São Paulo
Dra. Ana,5521999998888,Dermatologia,Rio de Janeiro
Invalido,123,Teste,Curitiba`;

		const res = processarPlanilhaCsv(csv, "planilha_medicos");
		expect(res.totalLinhas).toBe(3);
		expect(res.leads.length).toBe(2);
		expect(res.ignorados.length).toBe(1);

		expect(res.leads[0]?.name).toBe("Dr. Carlos");
		expect(res.leads[0]?.e164).toBe("+5511988887777");
		expect(res.leads[0]?.originSource).toBe("planilha_medicos");
		expect(res.leads[0]?.legalBasis).toBe("legitimo_interesse");
	});
});

