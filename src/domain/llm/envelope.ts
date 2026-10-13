/**
 * Envelope Zod de I/O da LLM (D-09/D-10) — o "sanduíche" de camadas.
 *
 * A LLM não devolve texto livre. Ela devolve um objeto que precisa passar por
 * este schema. O que não parseia NÃO vira mensagem: vira falha-fechada
 * (silêncio + notificação), tratada pelo adaptador.
 *
 *  - Camada 1 (`envelopeExtracao`): classificação de intenção + sinais +
 *    qualificação + hint de estado.
 *  - Camada 3 (`envelopeGeracao`): só o rascunho de texto.
 *
 * O campo `canary` é OBRIGATÓRIO: é o sinal de adesão ao formato (Pitfall 7 —
 * NÃO é defesa contra prompt-injection, é verificação de que o modelo está
 * respondendo na estrutura pedida).
 */
import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Enum FECHADO de intenções (pt-BR). `pedido_preco` e `objecao_preco` são
 * deliberadamente separados (D-09): o primeiro é handoff (AR-001), o segundo é
 * contorno (R-042). Colapsá-los mandaria um pedido de preço pelo caminho errado.
 */
export const INTENCOES = [
	"saudacao",
	"duvida_simples",
	"duvida_complexa",
	"pedido_preco",
	"objecao_preco",
	"objecao_tempo",
	"objecao_fornecedor",
	"vou_pensar",
	"intencao_agendar",
	"bot_suspicion",
	"irritacao",
	"ameaca",
	"pedido_optout",
	"midia_recebida",
	"outro",
] as const;

export type Intencao = (typeof INTENCOES)[number];

/** Sinais booleanos que a Camada 3 do funil (gate) consome para decidir handoff. */
export const sinaisEnvelope = z.object({
	pricingAsked: z.boolean(),
	schedulingIntent: z.boolean(),
	botSuspicion: z.boolean(),
	irritation: z.boolean(),
	optOutIntent: z.boolean(),
	mediaReceived: z.boolean(),
});

/** Qualificação dinâmica (R-051): verba e decisão em 0..2, ou desconhecido. */
export const qualificacaoEnvelope = z.object({
	verba: z.number().int().min(0).max(2).nullable(),
	decisao: z.number().int().min(0).max(2).nullable(),
});

/** Camada 1: envelope de EXTRAÇÃO. */
export const envelopeExtracao = z.object({
	intent: z.enum(INTENCOES),
	signals: sinaisEnvelope,
	qualification: qualificacaoEnvelope,
	/** Sugestão de próximo estado — nunca soberana (`resolveNextState` decide). */
	nextStateHint: z.string(),
	/** Eco obrigatório do canário injetado no prompt. */
	canary: z.string(),
});

/** Camada 3: envelope de GERAÇÃO. Só o rascunho; nada além. */
export const envelopeGeracao = z.object({
	replyText: z.string(),
	canary: z.string(),
});

export type ExtractionEnvelope = z.infer<typeof envelopeExtracao>;
export type GenerationEnvelope = z.infer<typeof envelopeGeracao>;

/**
 * Factory determinística do canário injetado no prompt. Derivada por hash da
 * semente para não ser adivinhável por leitura do payload, mas reproduzível em
 * teste (mesma semente → mesmo valor).
 */
export const canarioEsperado = (semente: string): string =>
	`CANARIO-${createHash("sha256").update(semente).digest("hex").slice(0, 16)}`;

/** Resultado TIPADO da validação de eco. `ok:false` é falha-fechada no adaptador. */
export type EcoCanario =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly esperado: string;
			readonly recebido: string;
	  };

/** Verifica que o modelo ecoou exatamente o canário injetado. */
export const validaEcoCanario = (
	esperado: string,
	recebido: string,
): EcoCanario =>
	esperado === recebido ? { ok: true } : { ok: false, esperado, recebido };
