/**
 * Ingestão de leads a partir de arquivos de planilhas/tabelas (CSV / TSV).
 *
 * Mapeia colunas comuns em português ou inglês:
 *   - Telefone: telefone, celular, phone, whatsapp, tel, contato
 *   - Nome: nome, contato, cliente, lead, name
 *   - Nicho / Categoria: nicho, segmento, categoria, setor, ramo
 *   - Cidade: cidade, municipio, city
 *   - Estado: estado, uf, state
 *
 * Normaliza automaticamente o telefone para E.164 (+55...).
 */
import Papa from "papaparse";
import type { Lead } from "../domain/ports/LeadSourcePort.js";

/** Normaliza string de telefone brasileiro para formato E.164 (+55XXXXXXXXXXX). */
export const normalizarParaE164 = (raw: string): string | null => {
	const digitos = raw.replace(/\D/g, "");
	if (!digitos) return null;

	// Se já tem 55 no início e tamanho compatível (12 ou 13 dígitos: 55 + DDD + 8 ou 9 dígitos)
	if (
		digitos.startsWith("55") &&
		(digitos.length === 12 || digitos.length === 13)
	) {
		return `+${digitos}`;
	}

	// Se não tem 55, mas tem DDD + número (10 ou 11 dígitos)
	if (digitos.length === 10 || digitos.length === 11) {
		return `+55${digitos}`;
	}

	// Caso de formato já com DDI internacional diferente de 55 (ex: +1..., +351...)
	if (
		raw.trim().startsWith("+") &&
		digitos.length >= 8 &&
		digitos.length <= 15
	) {
		return `+${digitos}`;
	}

	return null;
};

export interface ResultadoParsePlanilha {
	readonly leads: Lead[];
	readonly ignorados: Array<{ linha: number; motivo: string; dado: unknown }>;
	readonly totalLinhas: number;
}

export const processarPlanilhaCsv = (
	conteudoCsv: string,
	origem = "planilha_excel",
): ResultadoParsePlanilha => {
	const parsed = Papa.parse<Record<string, string>>(conteudoCsv, {
		header: true,
		skipEmptyLines: true,
		transformHeader: (h) => h.trim().toLowerCase(),
	});

	const leadsValidos: Lead[] = [];
	const ignorados: Array<{ linha: number; motivo: string; dado: unknown }> = [];

	parsed.data.forEach((linha, idx) => {
		const numLinha = idx + 2; // +1 pelo 0-index e +1 pelo cabeçalho

		// Busca a chave do telefone
		const telRaw =
			linha.telefone ||
			linha.celular ||
			linha.phone ||
			linha.whatsapp ||
			linha.tel ||
			linha.contato_telefone ||
			linha.numero ||
			"";

		const e164 = normalizarParaE164(telRaw);
		if (!e164) {
			ignorados.push({
				linha: numLinha,
				motivo: `Telefone inválido ou ausente: "${telRaw}"`,
				dado: linha,
			});
			return;
		}

		const nome = (
			linha.nome ||
			linha.cliente ||
			linha.lead ||
			linha.name ||
			linha.contato ||
			""
		).trim();

		const _nicho = (
			linha.nicho ||
			linha.segmento ||
			linha.categoria ||
			linha.setor ||
			linha.ramo ||
			""
		).trim();

		const cidade = (linha.cidade || linha.municipio || linha.city || "").trim();
		const estado = (linha.estado || linha.uf || linha.state || "").trim();

		const lead: Lead = {
			e164,
			name: nome.length > 0 ? nome : undefined,
			originSource: origem,
			legalBasis: "legitimo_interesse",
			purpose: "contato_comercial_b2b",
			addressLine: cidade.length > 0 ? `${cidade} - ${estado}` : undefined,
		};

		leadsValidos.push(lead);
	});

	return {
		leads: leadsValidos,
		ignorados,
		totalLinhas: parsed.data.length,
	};
};
