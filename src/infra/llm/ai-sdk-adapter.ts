/**
 * Adaptador real de LLM sobre o Vercel AI SDK (R-009, D-08/D-10).
 *
 * É a implementação de PRODUÇÃO da `LlmPort`. O adaptador roteirizado cobre os
 * testes; este cobre a rede. A fronteira foi desenhada para que trocar de
 * provider seja trocar o `model` — o resto do sistema fala com a porta, não com
 * `generateText`.
 *
 * ## Fail-closed, sempre (D-10)
 *
 * Nenhum caminho daqui devolve texto livre. Schema que não parseia, canário que
 * não ecoa, timeout ou provider fora do ar: tudo vira `LlmResult` com `ok:false`
 * e uma `LlmFailure` tipada. Quem chama (o handler) trata a falha como silêncio +
 * notificação — nunca como um fallback de texto. Uma exceção crua escapando daqui
 * arrancaria o handoff.
 *
 * ## O `Output.object` é a guarda de forma
 *
 * `generateText({ output: Output.object({ schema }) })` faz o modelo responder em
 * JSON aderente ao envelope Zod. Quando o texto não vira objeto válido, o SDK
 * lança `NoObjectGeneratedError` — que mapeamos para `schema_invalido`. O eco do
 * canário é conferido AQUI também (além da checagem do handler): as duas camadas
 * existem porque o canário não é defesa contra injection (Pitfall 7), é garantia
 * de que o modelo está respondendo na estrutura pedida.
 */
import {
	generateText,
	type LanguageModel,
	NoObjectGeneratedError,
	NoOutputGeneratedError,
	Output,
} from "ai";
import {
	type ExtractionEnvelope,
	envelopeExtracao,
	envelopeGeracao,
	type GenerationEnvelope,
	validaEcoCanario,
} from "../../domain/llm/envelope.js";
import type {
	ExtractInput,
	ExtractResult,
	GenerateInput,
	GenerateResult,
	LlmFailure,
	LlmFailureKind,
	LlmPort,
	LlmUsage,
} from "../../domain/ports/LlmPort.js";

export interface AiSdkAdapterConfig {
	/** O modelo já instanciado pelo provider (`openai("gpt-4o-mini")`, etc.). */
	readonly model: LanguageModel;
	/** Orçamento de tempo da chamada; estourado, vira `timeout`. */
	readonly timeoutMs?: number;
	/** Versão do template de prompt — vai para `llm_runs.prompt_version`. */
	readonly promptVersion: string;
	/** Versão da política de guardas — vai para `llm_runs.policy_version`. */
	readonly policyVersion: string;
}

const TIMEOUT_PADRAO_MS = 20_000;

/** Mapeia uma exceção do SDK para a classe fechada de falha (nunca vaza texto cru). */
const classificaErro = (e: unknown): LlmFailure => {
	if (NoObjectGeneratedError.isInstance(e)) {
		return {
			kind: "schema_invalido",
			detail: "Output.object nao parseou o envelope",
		};
	}
	if (NoOutputGeneratedError.isInstance(e)) {
		return { kind: "schema_invalido", detail: "o modelo nao devolveu output" };
	}
	if (e instanceof Error) {
		if (e.name === "AbortError" || e.name === "TimeoutError") {
			return { kind: "timeout", detail: "timeout da chamada a LLM" };
		}
		if (e.name === "APICallError" || e.name === "LoadAPIKeyError") {
			return { kind: "provider_indisponivel", detail: e.message };
		}
		return { kind: "provider_indisponivel", detail: e.message };
	}
	return { kind: "provider_indisponivel", detail: String(e) };
};

/** Traduz a usage do AI SDK (`inputTokens`/`outputTokens`) para a da porta. */
const paraUsage = (
	usage: {
		readonly inputTokens?: number | undefined;
		readonly outputTokens?: number | undefined;
	},
	model: string,
	latencyMs: number,
): LlmUsage => ({
	model,
	promptTokens: usage.inputTokens ?? null,
	completionTokens: usage.outputTokens ?? null,
	latencyMs,
});

const falha = (
	error: LlmFailure,
): { ok: false; error: LlmFailure; usage: null } => ({
	ok: false,
	error,
	usage: null,
});

/**
 * Cria a implementação de produção da porta. O `model` é injetado (nunca lido de
 * `env` aqui): o provider é decisão de boot/bake-off, não uma dependência
 * escondida do adaptador.
 */
export const criarAiSdkAdapter = (
	config: AiSdkAdapterConfig,
): LlmPort<ExtractionEnvelope, GenerationEnvelope> => {
	const timeoutMs = config.timeoutMs ?? TIMEOUT_PADRAO_MS;
	const nomeModelo =
		typeof config.model === "string"
			? config.model
			: (config.model.modelId ?? "ai-sdk");

	const chamar = async <T>(
		schema: Parameters<typeof Output.object>[0]["schema"],
		prompt: string,
		canary: string,
	): Promise<
		| { ok: true; output: T; usage: LlmUsage; costUsd: number | null }
		| { ok: false; error: LlmFailure; usage: null }
	> => {
		const executar = async (
			promptFinal: string,
		): Promise<
			| { ok: true; output: T; usage: LlmUsage; costUsd: number | null }
			| { ok: false; error: LlmFailure; usage: null }
		> => {
			const inicio = Date.now();
			try {
				const resultado = await generateText({
					model: config.model,
					output: Output.object({ schema }),
					prompt: promptFinal,
					abortSignal: AbortSignal.timeout(timeoutMs),
				});
				const latencia = Date.now() - inicio;
				const output = resultado.output as T & { canary: string };
				const eco = validaEcoCanario(canary, output.canary);
				if (!eco.ok) {
					return falha({
						kind: "canario_divergente",
						detail: "o modelo nao ecoou o canario injetado",
					});
				}
				return {
					ok: true,
					output: output as T,
					usage: paraUsage(resultado.usage, nomeModelo, latencia),
					costUsd: null,
				};
			} catch (e) {
				return falha(classificaErro(e));
			}
		};

		const primeira = await executar(prompt);
		// D-10: exatamente UM reprompt, e só para falha de FORMA (schema). Um
		// timeout ou provider fora do ar não melhora com nova tentativa imediata;
		// um canário divergente é decisão de calar, não de insistir.
		if (primeira.ok || primeira.error.kind !== "schema_invalido") {
			return primeira;
		}
		return executar(
			`${prompt}\n\nATENÇÃO: a resposta anterior não foi um JSON válido no schema pedido. Responda SOMENTE com JSON aderente.`,
		);
	};

	return {
		extract: (
			input: ExtractInput,
		): Promise<ExtractResult<ExtractionEnvelope>> =>
			chamar<ExtractionEnvelope>(envelopeExtracao, input.prompt, input.canary),
		generate: (
			input: GenerateInput,
		): Promise<GenerateResult<GenerationEnvelope>> =>
			chamar<GenerationEnvelope>(envelopeGeracao, input.prompt, input.canary),
	};
};

/** Reexportado para que o boot construa adaptadores sem importar `ai` diretamente. */
/** Kind de falha exposto para log/boot. */
export type { LanguageModel, LlmFailureKind };
