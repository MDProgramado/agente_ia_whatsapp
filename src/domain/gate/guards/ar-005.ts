import type { GateInput, GateReason } from "../types.js";

/**
 * AR-005 — contorno de opt-out. Bloqueio total.
 *
 * O guard mais simples do arquivo, de propósito: a irreversibilidade do opt-out
 * já é garantida no banco pelo trigger `fn_opt_out_irreversible` (01-02), então o
 * trabalho aqui é **não deixar passar**. Não há exceção, não há janela, não há
 * "só desta vez": passado o opt-out, o único caminho é o `block` — dentro da
 * janela, com cota sobrando, com handoff inativo, venha o que vier.
 *
 * **Não** é o guard de handoff: `handoffActive` é `ar-010.ts`. Opt-out e handoff
 * são eixos diferentes, e misturá-los faria um bloqueio por irritação parecer um
 * pedido de saída no painel.
 */
export function evaluate(input: GateInput): GateReason | null {
	return input.lead.optOut ? "ar005_opt_out" : null;
}
