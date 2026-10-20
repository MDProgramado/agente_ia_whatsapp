/**
 * FSM da conversa — função pura, determinística, sem I/O (D-07).
 *
 * O modelo NUNCA decide o estado: ele só pode SUGERIR uma `hint`. Quem decide é
 * este módulo, que recebe a hint e os sinais locais (guardas) e devolve o estado
 * final. As guardas vencem a hint; a hint só é aceita se constar em
 * `ALLOWED[prev]`. Isso é o que impede o modelo de "pular" para `human` ou
 * `encerrado` por conta própria (AR-001/AR-005/AR-010 são invariantes).
 *
 * Estado é o `engagement_mode` da conversa (`conversations_state_check`).
 */

/** Os 9 estados do `conversations_state_check` (migrations 0000/0003). */
export type Estado =
	| "novo"
	| "aquecimento"
	| "qualificando"
	| "aquecido"
	| "awaiting_human"
	| "human"
	| "copilot"
	| "pausado"
	| "encerrado";

/** Transições permitidas. `encerrado` é sumidouro (nenhuma saída). */
export const ALLOWED = {
	novo: ["aquecimento", "qualificando", "awaiting_human", "encerrado"],
	aquecimento: ["qualificando", "awaiting_human", "encerrado"],
	qualificando: ["aquecimento", "aquecido", "awaiting_human", "encerrado"],
	aquecido: ["qualificando", "awaiting_human", "encerrado"],
	awaiting_human: ["human", "copilot", "pausado", "encerrado"],
	human: ["copilot", "pausado", "encerrado"],
	copilot: ["human", "pausado", "encerrado"],
	pausado: ["human", "copilot", "encerrado"],
	encerrado: [],
} as const satisfies Record<Estado, readonly Estado[]>;

/**
 * Sinais LOCAIS que vencem a hint do modelo. Todos são derivados de fatos
 * persistidos (opt-out, handoff, quota, qualificação), nunca do texto do modelo.
 */
export interface SinaisLocais {
	/** R-024/AR-005: opt-out registrado é terminal. */
	readonly optOutAtivo?: boolean;
	/** R-012/R-065/AR-010: handoff disparado congela a automação. */
	readonly handoffDisparado?: boolean;
	/** `bot_active` ou `shadow` = automação pode avançar (D-18). */
	readonly engagementMode?: string;
	/** R-007/R-026: cadência de follow-up esgotada. */
	readonly sequenciaEsgotada?: boolean;
	/** CONV-01/R-002: o Admin abriu a conversa, sem o lead ter respondido ainda. */
	readonly adminPrimeiraMensagem?: boolean;
	/** R-051: verba (0..2) e decisão (0..2) confirmadas = lead qualificado. */
	readonly qualification?: {
		readonly verba: number | null;
		readonly decisao: number | null;
	};
}

/**
 * Resolve o próximo estado da conversa. Total: sempre devolve um `Estado`.
 *
 * Ordem das guardas (a primeira que casa vence):
 *  1. opt-out ativo → `encerrado` (AR-005)
 *  2. handoff disparado → `awaiting_human` (AR-010)
 *  3. Admin mandou a 1ª mensagem em `novo` → `aquecimento` (CONV-01/R-002)
 *  4. `engagementMode` fora de `bot_active`/`shadow` → congela em `prev`
 *  5. sequência esgotada → `encerrado`
 *  6. verba e decisão confirmadas → `aquecido` (R-051)
 *  7. hint só é aceita se constar em `ALLOWED[prev]`; senão, `prev`
 */
export const resolveNextState = (
	prev: Estado,
	hint: string | undefined,
	ctx: SinaisLocais,
): Estado => {
	if (prev === "encerrado") return "encerrado";
	if (ctx.optOutAtivo) return "encerrado";
	if (ctx.handoffDisparado) return "awaiting_human";
	if (ctx.adminPrimeiraMensagem === true && prev === "novo")
		return "aquecimento";
	if (ctx.engagementMode !== "bot_active" && ctx.engagementMode !== "shadow") {
		return prev;
	}
	if (ctx.sequenciaEsgotada) return "encerrado";
	const q = ctx.qualification;
	if (q?.verba && q?.decisao) return "aquecido";

	const permitidas: readonly string[] = ALLOWED[prev];
	return hint !== undefined && permitidas.includes(hint)
		? (hint as Estado)
		: prev;
};
