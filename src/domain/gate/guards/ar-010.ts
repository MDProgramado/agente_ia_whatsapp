import type { GateInput, GateReason } from "../types.js";

/**
 * AR-010 — agir após handoff. Silêncio.
 *
 * Duas checagens, porque a flag sozinha não cobre o intervalo real:
 *
 * (a) `handoffActive === true` **ou** `engagementMode` em `human`/`awaiting_human`;
 * (b) `state` em `awaiting_human`/`human`.
 *
 * A segunda cobre o bug de transição: `handoff_active` pode já estar `false`
 * enquanto `engagement_mode` ainda é `human`, e nesse intervalo qualquer outbound
 * violaria R-066. Este é o guard de **modo**, não só de flag.
 *
 * **Não** é o guard de dia útil: dia útil e janela são `ar-007.ts` (01-01).
 *
 * ## Feriados estão fora de escopo
 *
 * Não há calendário de feriados na Fase 01 (decisão do usuário, registrada em
 * 2026-10-09). Um "conserto" que introduza feriados sem decisão explícita muda a
 * janela operacional de R-006/R-058 por conta própria — não faça isso aqui.
 */
export function evaluate(input: GateInput): GateReason | null {
	const { handoffActive, engagementMode, state } = input.conversation;
	const modoHumano =
		engagementMode === "human" || engagementMode === "awaiting_human";
	const estadoHumano = state === "awaiting_human" || state === "human";
	return handoffActive || modoHumano || estadoHumano
		? "ar010_handoff_ativo"
		: null;
}
