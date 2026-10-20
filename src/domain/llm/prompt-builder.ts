/**
 * Choke-point único de formatação de entrada para a LLM (D-16, Pitfall 4).
 *
 * Regra-mestra da fase: NENHUM outro módulo monta prompt. Este arquivo é a única
 * porta de egresso textual para o modelo, e ele MASCARA o payload inteiro antes
 * de formatar. Mascarar só o contexto do lead seria insuficiente: um telefone ou
 * endereço que o PRÓPRIO LEAD escreveu na conversa vazaria pelo histórico
 * (Pitfall 4, T-02-01).
 *
 * `maskPii` é exposta para teste/auditoria; `buildExtractPrompt` e
 * `buildGeneratePrompt` a chamam internamente, de modo que é impossível montar
 * um prompt sem passar por ela.
 */
import type { Estado } from "../orchestrator/transitions.js";

/** Placeholders de egresso. Sem dígitos, para não virarem falso-positivo. */
export const PLACEHOLDER_TELEFONE = "[TELEFONE]";
export const PLACEHOLDER_ENDERECO = "[ENDERECO]";

export interface LeadContexto {
	readonly name: string | null;
	readonly phoneNumber: string | null;
	readonly addressLine: string | null;
}

/** Payload que entra na LLM. Todos os campos de texto são mascarados na saída. */
export interface PayloadLlm {
	readonly lead: LeadContexto;
	readonly adminPrimeiraMensagem: string | null;
	readonly historico: readonly {
		readonly autor: "lead" | "admin" | "bot";
		readonly texto: string;
	}[];
	readonly ultimaMensagem: string | null;
}

/**
 * Telefones: E.164, BR com DDD (com/sem parênteses), celular sem DDD e fixo sem
 * DDD. Deliberadamente frouxo — mascarar demais é o lado SEGURO do erro.
 * (Usados apenas com `String.replace` global, que sempre reinicia `lastIndex`.)
 */
const RE_TELEFONE =
	/\+[1-9]\d{7,14}|\(\d{2}\)[\s.-]?9?\d{4}[\s.-]?\d{4}|\b\d{2}[\s.-]9?\d{4}[\s.-]?\d{4}\b|\b9\d{4}[\s.-]?\d{4}\b|\b\d{4}-\d{4}\b/g;

/** Logradouros + número/CEP. Para no fim de linha, `;` ou `.`. */
const RE_ENDERECO =
	/\b(?:rua|avenida|av\.?|travessa|tv\.?|alameda|al\.?|estrada|est\.?|rodovia|rod\.?|praça|praca|viela|largo)\s+[^\n;.]{3,80}/gi;

/** CEP isolado (`40000-000`). */
const RE_CEP = /\b\d{5}-\d{3}\b/g;

/** Regex para e-mail */
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
/** Regex para CNPJ */
const RE_CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
/** Regex para CPF */
const RE_CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;

/** Mascara telefone, logradouro e CEP em um texto livre. Idempotente. */
const maskTexto = (texto: string): string =>
	texto
		.replace(RE_EMAIL, "[EMAIL]")
		.replace(RE_CNPJ, "[CNPJ]")
		.replace(RE_CPF, "[CPF]")
		.replace(RE_ENDERECO, PLACEHOLDER_ENDERECO)
		.replace(RE_TELEFONE, PLACEHOLDER_TELEFONE)
		.replace(RE_CEP, PLACEHOLDER_ENDERECO);

/** Mascara o payload inteiro. O nome do lead é mantido (a persona precisa dele). */
export const maskPii = (payload: PayloadLlm): PayloadLlm => ({
	lead: {
		name: payload.lead.name,
		phoneNumber:
			payload.lead.phoneNumber === null
				? null
				: maskTexto(payload.lead.phoneNumber),
		addressLine:
			payload.lead.addressLine === null
				? null
				: maskTexto(payload.lead.addressLine),
	},
	adminPrimeiraMensagem:
		payload.adminPrimeiraMensagem === null
			? null
			: maskTexto(payload.adminPrimeiraMensagem),
	historico: payload.historico.map((m) => ({
		autor: m.autor,
		texto: maskTexto(m.texto),
	})),
	ultimaMensagem:
		payload.ultimaMensagem === null ? null : maskTexto(payload.ultimaMensagem),
});

/** Renderiza o payload JÁ MASCARADO como bloco de contexto do prompt. */
const renderContexto = (p: PayloadLlm): string => {
	const linhas: string[] = [
		`Nome do lead: ${p.lead.name ?? "(desconhecido)"}`,
		`Endereço: ${p.lead.addressLine ?? "(não informado)"}`,
		`Telefone: ${p.lead.phoneNumber ?? "(não informado)"}`,
	];
	if (p.adminPrimeiraMensagem) {
		linhas.push(`1ª mensagem do consultor: ${p.adminPrimeiraMensagem}`);
	}
	if (p.historico.length > 0) {
		linhas.push("Histórico:");
		for (const m of p.historico) {
			linhas.push(`  ${m.autor}: ${m.texto}`);
		}
	}
	if (p.ultimaMensagem) {
		linhas.push(`Última mensagem do lead: ${p.ultimaMensagem}`);
	}
	return linhas.join("\n");
};

/** Prompt da Camada 1 (extração). Mascara internamente — nunca recebe PII crua. */
export const buildExtractPrompt = (
	payload: PayloadLlm,
	canario: string,
): string =>
	[
		"Você é um classificador de conversas de prospecção B2B em português do Brasil.",
		"Classifique a última mensagem do lead e devolva SOMENTE um JSON com os campos:",
		"intent, signals, qualification, nextStateHint, canary.",
		`O campo "canary" deve ecoar exatamente este valor: ${canario}`,
		"",
		"Contexto da conversa:",
		renderContexto(maskPii(payload)),
	].join("\n");

/** Prompt da Camada 3 (geração). Mascara internamente. */
export const buildGeneratePrompt = (
	payload: PayloadLlm,
	estado: Estado,
	canario: string,
): string =>
	[
		"Você é um consultor comercial humano conduzindo uma conversa de prospecção B2B em português do Brasil.",
		"Escreva a próxima mensagem em tom consultivo e humanizado. Nunca negocie preço, nunca agende reunião sozinho, nunca envie mídia.",
		`Estado resolvido da conversa (decidido pelo sistema; NÃO o altere): ${estado}`,
		"Devolva SOMENTE um JSON com os campos replyText e canary.",
		`O campo "canary" deve ecoar exatamente este valor: ${canario}`,
		"",
		"Contexto da conversa:",
		renderContexto(maskPii(payload)),
	].join("\n");

/** Versão do template de NOTA interna da IA (03-05) — comparável em `llm_runs`. */
export const NOTA_PROMPT_VERSION = "03-05";

/**
 * Prompt da nota automática (CRM-03/D-22/R-043). Mesmo choke-point dos
 * demais: `maskPii` roda aqui, então nem o telefone que o PRÓPRIO LEAD escreveu
 * na conversa sai no prompt.
 *
 * As três seções (Resumo/Objeções/Próximos passos) são exigidas no prompt e
 * verificadas no código — a nota só nasce completa.
 */
export const buildNotePrompt = (payload: PayloadLlm, canario: string): string =>
	[
		"Analise a conversa de prospecção B2B abaixo e redija uma nota interna em português do Brasil, para o consultor ler no painel.",
		"A nota deve conter exatamente estas três seções, nesta ordem, com estes títulos:",
		"Resumo — o que já foi conversado, em poucas linhas.",
		"Objeções — objeções, dúvidas e resistências explicitadas pelo lead (escreva 'Nenhuma' se não houver).",
		"Próximos passos — o que o consultor deve fazer a seguir.",
		"Não invente fatos: apoie-se apenas no contexto abaixo. Nunca negocie preço nem proponha horários.",
		'Devolva SOMENTE um JSON com os campos "replyText" (a nota completa) e "canary".',
		`O campo "canary" deve ecoar exatamente este valor: ${canario}`,
		"",
		"Contexto da conversa:",
		renderContexto(maskPii(payload)),
	].join("\n");
