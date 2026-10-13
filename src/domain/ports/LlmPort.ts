/**
 * Porta de LLM (R-009, CONV-03, D-08).
 *
 * A fronteira existe porque o que o projeto precisa da IA é uma **decisão
 * estruturada**, não texto livre: a Camada 1 extrai o sinal da última mensagem e
 * a Camada 3 gera a resposta sob o estado que o CÓDIGO resolveu. Dois tiers,
 * dois métodos, um contrato.
 *
 * ## Por que a porta é GENÉRICA sobre os envelopes
 *
 * O schema concreto (o enum de intenção, o campo-canário) vive em
 * `src/domain/llm/envelope.ts`. Um contrato de porta que importasse aquele
 * arquivo acoplaria a FRONTEIRA ao PAYLOAD: trocar o envelope passaria a mexer
 * na interface. Os parâmetros de tipo (`TExtract`, `TGenerate`) deixam o
 * adaptador escolher o envelope, e a porta ficar independente dele.
 *
 * ## Por que a porta NÃO importa `ai` nem SDK de provider
 *
 * Isso é responsabilidade do adaptador em `src/infra/llm/`. Um `import` de
 * `generateText` aqui seria o Coupled Change que a porta existe para evitar — e
 * é o que a mantém testável com o adapter scripted, sem rede e sem chave de API.
 */

/** Metadados de UMA chamada — o que `llm_runs` guarda (R-045/D-05). Nunca o corpo. */
export interface LlmUsage {
	readonly model: string;
	readonly promptTokens: number | null;
	readonly completionTokens: number | null;
	readonly latencyMs: number;
}

/** Custo em dólar da chamada quando o provider o informa; `null` quando não. */
export type LlmCostUsd = number | null;

/**
 * Por que a chamada falhou. União FECHADA de propósito: o caminho de falha
 * termina em silêncio + notificação (D-10), nunca em texto livre, então o que
 * importa registrar é a CLASSE da falha, não uma mensagem arbitrária.
 */
export type LlmFailureKind =
	| "schema_invalido"
	| "canario_divergente"
	| "timeout"
	| "provider_indisponivel";

export interface LlmFailure {
	readonly kind: LlmFailureKind;
	/** Detalhe técnico para log. NUNCA texto a enviar a um lead. */
	readonly detail: string;
}

/**
 * Resultado de uma chamada, discriminado por `ok`.
 *
 * O sucesso carrega o `output` JÁ VALIDADO (o envelope), a `usage` e o custo; a
 * falha carrega um `error` TIPADO. Os dois casos são valores devolvidos, não
 * exceções: quem chama trata a falha como **silêncio**, e uma exceção perdida
 * arrancaria o handoff.
 */
export type LlmResult<T> =
	| {
			readonly ok: true;
			readonly output: T;
			readonly usage: LlmUsage;
			readonly costUsd: LlmCostUsd;
	  }
	| {
			readonly ok: false;
			readonly error: LlmFailure;
			readonly usage: LlmUsage | null;
	  };

/** Resultado da Camada 1 (extração). `T` é o envelope de extração de `envelope.ts`. */
export type ExtractResult<T> = LlmResult<T>;

/** Resultado da Camada 3 (geração). `T` é o envelope de geração de `envelope.ts`. */
export type GenerateResult<T> = LlmResult<T>;

/**
 * Entrada da Camada 1 (extração, modelo barato).
 *
 * `prompt` já vem MASCARADO pelo choke-point (`src/domain/llm/prompt-builder.ts`)
 * — esta porta não mascara nada, e nenhum chamador pode montar prompt fora dele
 * (D-16/Pitfall 4).
 */
export interface ExtractInput {
	/** Prompt já mascarado pelo choke-point. Nunca payload cru. */
	readonly prompt: string;
	/**
	 * Valor que o código injeta e o modelo deve ECOAR. Divergência vira
	 * `canario_divergente` — é aderência de schema, não defesa contra injection
	 * (Pitfall 7).
	 */
	readonly canary: string;
}

/** Entrada da Camada 3 (geração, modelo forte): a da Camada 1 mais o estado resolvido. */
export interface GenerateInput {
	/** Prompt já mascarado pelo choke-point. Nunca payload cru. */
	readonly prompt: string;
	/** Valor que o modelo deve ecoar; divergência é falha-fechada. */
	readonly canary: string;
	/**
	 * Estado AUTORITATIVO resolvido por `resolveNextState` em código (Camada 2,
	 * D-07). O modelo gera texto SOB ele; nunca escolhe o estado.
	 */
	readonly resolvedState: string;
}

/**
 * Porta de dois tiers (D-08). Ambos os métodos devolvem resultado discriminado e
 * **não lançam** para o caminho de texto livre — a falha é um valor, e quem
 * chama decide calar e notificar.
 */
export interface LlmPort<TExtract, TGenerate> {
	/** Camada 1 — modelo barato, `Output.object`. Roda em todo inbound. */
	extract(input: ExtractInput): Promise<ExtractResult<TExtract>>;

	/** Camada 3 — modelo forte, chamado só quando o estado resolvido pede geração. */
	generate(input: GenerateInput): Promise<GenerateResult<TGenerate>>;
}
