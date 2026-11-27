/**
 * Mídia é um branded type sem construtor exportado: nenhum código de produção
 * consegue fabricar um valor de mídia para enviar. Não existe método de envio
 * de mídia na interface.
 */
export type OutboundPart =
	| { readonly kind: "text" }
	| { readonly kind: "link"; readonly href: string };

export interface ChannelSendResult {
	readonly providerMsgId: string | null;
	readonly latencyMs: number;
}

export interface ChannelPort {
	sendText(
		conversationId: string,
		text: string,
		idempotencyKey: string,
	): Promise<ChannelSendResult>;
	/** Presença é sinal de humanização — nunca mídia e nunca conteúdo. */
	sendPresenceUpdate(
		conversationId: string,
		presence: "composing" | "paused",
	): Promise<void>;
	readQuota(today: Date): Promise<{ sent: number; cap: number }>;
	markNumberInvalid(
		phoneE164: string,
		reason: "invalid" | "unreachable",
	): Promise<void>;
}
