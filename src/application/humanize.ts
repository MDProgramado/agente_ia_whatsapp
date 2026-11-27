/**
 * Humanização do envio (CONV-13, R-067): atraso variável, "digitando…" e divisão
 * de texto longo no limite do WhatsApp.
 *
 * ## Por que hash e não `Math.random`
 *
 * O atraso precisa parecer humano, mas o sistema precisa ser **auditável**. Um
 * `Math.random()` não permite responder "por que esta mensagem esperou 4,2s?" nem
 * reproduzir o comportamento em um teste. Derivar o atraso de `sha256(gênero +
 * texto)` dá as duas coisas: distribuição uniforme para quem observa, e um valor
 * determinístico para quem audita.
 *
 * ## Por que a humanização é uma função pura + um wrapper de espera
 *
 * `humanDelayMs`/`splitLongMessage` são puras — rodam milhares de vezes num
 * property test em milissegundos. `humanDelay`/`simulateTyping` só aguardam; a
 * espera é injetável (`sleep`) para que os testes não durmam de verdade.
 *
 * ## Por que o teto de `first` é clampado
 *
 * A primeira resposta tem de ser mais rápida que as seguintes (R-067). O
 * "thinking pause" de uma pergunta poderia empurrar o total acima de 2s; o clamp
 * garante o invariante `first ≤ 2s` mesmo nesse caso.
 */
import { createHash } from "node:crypto";

/** Gênero da mensagem: a primeira resposta é mais rápida que o follow-up. */
export type HumanKind = "first" | "followup";

/** Faixas de atraso (ms). Exportadas para o teste afirmar os limites. */
export const FIRST_MIN_MS = 800;
export const FIRST_MAX_MS = 2_000;
export const FOLLOWUP_MIN_MS = 2_500;
export const FOLLOWUP_MAX_MS = 6_000;
const THINKING_MIN_MS = 1_000;
const THINKING_MAX_MS = 3_000;

/** Intervalo entre "passos" de digitação (ms). */
const TYPING_MIN_MS = 40;
const TYPING_MAX_MS = 90;

/**
 * Limite de caracteres por mensagem. O WhatsApp aceita ~4096, mas o texto é
 * cortado bem antes: mensagens longas são o padrão de "pipeline" que a
 * humanização existe para evitar (CONV-13).
 */
export const LIMITE_WHATSAPP = 2_800;

/** Fração determinística em [0, 1) derivada de um rótulo — sem `Math.random`. */
const unitario = (rotulo: string): number => {
	const digest = createHash("sha256").update(rotulo).digest();
	// 6 bytes → inteiro em [0, 2^48) → [0, 1).
	return digest.readUIntBE(0, 6) / 0x1_0000_0000_0000;
};

/** `true` quando o texto contém uma pergunta/exclamação — pede "thinking pause". */
const temPergunta = (texto: string): boolean => /[?!](\s|$)/.test(texto);

/**
 * O "thinking pause" (ms) para um texto: 1–3s quando há pergunta/exclamação, 0
 * caso contrário. Pura e exportada para o teste isolá-la do resto do atraso.
 */
export const pausaDePensamentoMs = (texto: string): number =>
	temPergunta(texto)
		? THINKING_MIN_MS +
			unitario(`think:${texto}`) * (THINKING_MAX_MS - THINKING_MIN_MS)
		: 0;

/**
 * Atraso determinístico (ms) para um gênero e uma semente. Pura.
 *
 * `first` fica em [800, 2000]; `followup` em [2500, 6000]; um texto com pergunta
 * acrescenta o "thinking pause" — e o total é clampado no teto do gênero para
 * manter os dois invariantes de R-067.
 */
export const humanDelayMs = (kind: HumanKind, seed: string): number => {
	const base =
		kind === "first"
			? FIRST_MIN_MS + unitario(`first:${seed}`) * (FIRST_MAX_MS - FIRST_MIN_MS)
			: FOLLOWUP_MIN_MS +
				unitario(`followup:${seed}`) * (FOLLOWUP_MAX_MS - FOLLOWUP_MIN_MS);
	const total = Math.round(base + pausaDePensamentoMs(seed));
	return kind === "first"
		? Math.min(total, FIRST_MAX_MS)
		: Math.min(total, FOLLOWUP_MAX_MS);
};

const pausa = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export interface EsperaDeps {
	/** Injetável no teste: não dormir de verdade. O padrão usa `setTimeout`. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/** Espera humanizada. Aguarda `humanDelayMs(kind, seed)` e mais nada. */
export const humanDelay = async (
	kind: HumanKind,
	seed: string,
	deps: EsperaDeps = {},
): Promise<void> => {
	await (deps.sleep ?? pausa)(humanDelayMs(kind, seed));
};

export interface TypingOpts extends EsperaDeps {
	/** Progresso em caracteres "digitados". Opcional — não há canal de presença. */
	readonly onProgress?: (chars: number) => void;
}

/**
 * Simula "digitando…" com passos e pausas determinísticos.
 *
 * A presença real é sinalizada por `ChannelPort.sendPresenceUpdate` no dispatcher;
 * esta função só modela o tempo local — os `onProgress` são para a UI, se houver.
 */
export const simulateTyping = async (
	text: string,
	opts: TypingOpts = {},
): Promise<void> => {
	const sleep = opts.sleep ?? pausa;
	const total = text.length;
	let digitado = 0;
	let passo = 0;
	while (digitado < total) {
		const avanco = 1 + Math.floor(unitario(`tipo:${total}:${passo}`) * 40);
		digitado = Math.min(total, digitado + avanco);
		const espera =
			TYPING_MIN_MS +
			Math.floor(
				unitario(`espera:${digitado}`) * (TYPING_MAX_MS - TYPING_MIN_MS + 1),
			);
		opts.onProgress?.(digitado);
		await sleep(espera);
		passo += 1;
	}
};

/**
 * Divide um texto longo no limite, sem cortar no meio de uma palavra e sem
 * perder a ordem. A concatenação dos pedaços com um espaço reconstrói o original
 * (o separador consumido no corte É um único espaço).
 *
 * Corte em ordem de preferência: fim de frase (`. `/`? `/`! `/`, `) e, em último
 * caso, o último espaço da janela. Só um texto sem NENHUM espaço (uma "palavra"
 * maior que o limite) é cortado duro — caso patológico, nunca gerado na prática.
 */
export const splitLongMessage = (
	text: string,
	limit: number = LIMITE_WHATSAPP,
): string[] => {
	if (text.length <= limit) return [text];

	const partes: string[] = [];
	let resto = text;

	while (resto.length > limit) {
		const janela = resto.slice(0, limit);
		let corte = -1;

		for (const sep of [". ", "? ", "! ", ", "]) {
			const idx = janela.lastIndexOf(sep);
			if (idx >= 0 && idx + 1 > corte) corte = idx + 1;
		}
		if (corte <= 0) {
			const idx = janela.lastIndexOf(" ");
			if (idx > 0) corte = idx;
		}
		if (corte <= 0) corte = limit;

		partes.push(resto.slice(0, corte));
		resto = resto.slice(corte);
		if (resto.startsWith(" ")) resto = resto.slice(1);
	}

	if (resto.length > 0) partes.push(resto);
	return partes;
};

/**
 * A porta de humanização que o dispatcher consome. Existe como interface para
 * que o teste injete um dublê que não espera de verdade.
 */
export interface Humanizer {
	delay(kind: HumanKind, seed: string): Promise<void>;
	typing(text: string): Promise<void>;
}

export const humanizadorPadrao: Humanizer = {
	delay: (kind, seed) => humanDelay(kind, seed),
	typing: (text) => simulateTyping(text),
};
