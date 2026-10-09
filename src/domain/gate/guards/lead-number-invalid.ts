import { leadNumeroInvalido } from "../../number-validation.js";
import type { GateInput, GateReason } from "../types.js";

/**
 * `lead_numero_invalido` (LEAD-03 / R-019) — guard **nomeado**, fora da numeração
 * AR. Fica em `guards/` mas não casa `ar-*`: um número rejeitado pelo WhatsApp é
 * estado terminal, não um anti-requisito, e o total canônico
 * (`ls guards/ar-*.ts`) continua 12.
 *
 * O estado `invalido` bloqueia imediatamente: o 463 do 01-03 é definitivo até o
 * Admin corrigir/limpar. `desconhecido` **não** bloqueia — o `onWhatsApp()` do
 * 01-03 ainda está em voo logo após a primeira mensagem, e tratar "não verificado"
 * como "inválido" calaria o bot em toda conversa nova (o contrato de
 * `number-validation.ts` já faz essa distinção).
 *
 * ## TTL de `desconhecido` — diferido
 *
 * O documento sugere barrar `desconhecido` após 7 dias sem validação. O
 * `GateInput` do 01-01 **não** expõe o instante da última validação (nem
 * `wa_validated_at`), e `types.ts` é fechado nesta task — adicionar um campo aqui
 * seria editar a taxonomia por conveniência. Enquanto não houver o timestamp no
 * snapshot, só o estado terminal `invalido` bloqueia. Registrado como diferimento
 * para a fase que trouxer `wa_validated_at` ao `GateInput`.
 */
export function evaluate(input: GateInput): GateReason | null {
	return leadNumeroInvalido(input.lead.waValidationState)
		? "lead_numero_invalido"
		: null;
}
