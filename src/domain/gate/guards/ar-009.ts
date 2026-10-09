import type { GateInput, GateReason } from "../types.js";

/**
 * AR-009 — mídia recebida nunca é processada.
 *
 * O sinal já está no `GateInput` desde o 01-01 (`conversations.pending_media_block`)
 * e é ligado pelo `inbound-handler` do 01-03 quando o lead manda áudio, imagem ou
 * PDF: um guard baseado em `waValidationState` estaria testando a coisa **errada**
 * — número inválido é R-019, não AR, e vive em `lead-number-invalid.ts`.
 *
 * Enquanto `pendingMediaBlock` estiver ligado, **nenhum** outbound sai: o conteúdo
 * da mídia não foi interpretado e o Admin precisa assumir. `ar-010.ts` também é
 * handoff; a diferença é que AR-009 carrega o motivo específico "mídia recebida", e
 * `ar-009` vem **antes** na ordem, então `pendingMediaBlock` tem a precedência
 * quando os dois estão ligados.
 */
export function evaluate(input: GateInput): GateReason | null {
	return input.conversation.pendingMediaBlock ? "ar009_midia_recebida" : null;
}
