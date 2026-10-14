/**
 * Adaptador de LLM roteirizado — determinístico, sem rede, sem chave (D-08).
 *
 * Existe para que a lógica de orquestração (o sanduíche de camadas) seja
 * testável: os testes precisam provocar, de forma reprodutível, cada caminho do
 * contrato — sucesso, canário divergente, schema inválido, timeout — sem tocar
 * um provider real. Um teste que dependesse da rede seria lento, caro e instável
 * justamente no caminho que MAIS importa (falha-fechada, D-10).
 *
 * ## O que ele NÃO faz
 *
 * Ele não valida o canário nem o schema de forma independente: devolve
 * exatamente o que o cenário mandar. Isso é deliberado — assim o teste do
 * HANDLER verifica a guarda do PRÓPRIO handler (ele gera o canário esperado e
 * confere o eco). Se o adaptador corrigisse a divergência por conta própria, o
 * teste passaria mesmo com o handler sem guarda.
 *
 * O padrão (sem opções) é o caminho feliz: eco correto do canário, extração
 * neutra e um texto de geração que respeita os anti-requisitos (sem preço, sem
 * mídia, sem agendamento, sem revelar automação).
 */

import type {
	ExtractionEnvelope,
	GenerationEnvelope,
} from "../../domain/llm/envelope.js";
import type {
	ExtractInput,
	ExtractResult,
	GenerateInput,
	GenerateResult,
	LlmFailure,
	LlmPort,
	LlmUsage,
} from "../../domain/ports/LlmPort.js";

/** Texto neutro que passa os detectores de conteúdo (AR-001/AR-003/AR-004/AR-006). */
export const TEXTO_GERACAO_NEUTRO =
	"Olá! Tudo bem? Posso te contar rapidinho como a gente ajuda empresas a terem presença digital de verdade?";

/** Extração neutra: nenhuma intenção de handoff, nenhum sinal, sem qualificação. */
export const EXTRACAO_NEUTRA: Omit<ExtractionEnvelope, "canary"> = {
	intent: "saudacao",
	signals: {
		pricingAsked: false,
		schedulingIntent: false,
		botSuspicion: false,
		irritation: false,
		optOutIntent: false,
		mediaReceived: false,
	},
	qualification: { verba: null, decisao: null },
	nextStateHint: "aquecimento",
};

/**
 * Roteiro do adaptador. Cada campo sobrescreve o comportamento padrão:
 *
 *  - `canarioRecebido` transforma o canário esperado ANTES de devolvê-lo. O
 *    padrão é a identidade (eco correto). Um teste de falha-fechada devolve algo
 *    diferente para provar que o handler detecta.
 *  - `extracao`/`geracao` mesclam campos por cima das saídas neutras.
 *  - `falhaExtracao`/`falhaGeracao` curto-circuitam o resultado com uma falha
 *    tipada (sem tocar o envelope).
 *  - `custoUsd`/`usage` alimentam o metadado que vai para `llm_runs`.
 */
export interface RoteiroScripted {
	readonly canarioRecebido?: (esperado: string) => string;
	readonly extracao?: Partial<ExtractionEnvelope>;
	readonly geracao?: Partial<GenerationEnvelope>;
	readonly falhaExtracao?: LlmFailure;
	readonly falhaGeracao?: LlmFailure;
	readonly custoUsd?: number | null;
	readonly usage?: Partial<LlmUsage>;
}

const USAGE_PADRAO: LlmUsage = {
	model: "scripted",
	promptTokens: 12,
	completionTokens: 8,
	latencyMs: 1,
};

/**
 * Cria um `LlmPort<ExtractionEnvelope, GenerationEnvelope>` determinístico.
 *
 * Devolve também `chamadas`, o registro do que foi pedido — o teste usa para
 * afirmar que uma camada NÃO foi chamada (ex.: handoff não gera).
 */
export const scriptedLlmAdapter = (
	roteiro: RoteiroScripted = {},
): LlmPort<ExtractionEnvelope, GenerationEnvelope> & {
	readonly chamadas: readonly ("extract" | "generate")[];
} => {
	const chamadas: ("extract" | "generate")[] = [];
	const eco = roteiro.canarioRecebido ?? ((esperado: string) => esperado);
	const usage = { ...USAGE_PADRAO, ...roteiro.usage };
	const custo = roteiro.custoUsd ?? null;

	const extract = (
		input: ExtractInput,
	): Promise<ExtractResult<ExtractionEnvelope>> => {
		chamadas.push("extract");
		if (roteiro.falhaExtracao) {
			return Promise.resolve({
				ok: false,
				error: roteiro.falhaExtracao,
				usage: null,
			});
		}
		return Promise.resolve({
			ok: true,
			output: {
				...EXTRACAO_NEUTRA,
				...roteiro.extracao,
				canary: eco(input.canary),
			},
			usage,
			costUsd: custo,
		});
	};

	const generate = (
		input: GenerateInput,
	): Promise<GenerateResult<GenerationEnvelope>> => {
		chamadas.push("generate");
		if (roteiro.falhaGeracao) {
			return Promise.resolve({
				ok: false,
				error: roteiro.falhaGeracao,
				usage: null,
			});
		}
		return Promise.resolve({
			ok: true,
			output: {
				replyText: TEXTO_GERACAO_NEUTRO,
				...roteiro.geracao,
				canary: eco(input.canary),
			},
			usage,
			costUsd: custo,
		});
	};

	return { extract, generate, chamadas };
};
