/**
 * `GUARD_ORDER` — a ordem canônica de avaliação do gate, como **lista plana de
 * `GateReason`**. É o contrato legível: 15 entradas, na grafia exata que vai para
 * `blocked_attempts.rule_reference` (R-022, R-045). Quem **executa** é
 * `GUARD_SLOTS` (`guard-order.ts`), que carrega a função de cada posição; o teste
 * de ordem (`tests/gate/order.test.ts`) compara os dois para que não divirjam.
 *
 * A ordem importa: o `reason` gravado é o **primeiro** que disparou, e o painel da
 * Fase 04 mostra esse identificador ao Admin. Reordenar muda o que o Admin vê e faz
 * o relatório de conformidade citar a regra errada.
 *
 * A sequência completa, com a grafia exata (docs/10-anti-requisitos.md
 * §"Ordem de Avaliação no Gate"):
 *
 * ```
 * kill_switch_ativo
 *   → r001_primeiro_contato_nao_humano      Guard 0, fora da numeração AR
 *   → lead_numero_invalido                  LEAD-03, estado terminal
 *   → ar011_base_legal                       passo 2
 *   → ar005_opt_out                          passo 3
 *   → ar010_handoff_ativo                    passo 4
 *   → ar009_midia_recebida                   passo 5
 *   → ar001_preco                            passo 6a
 *   → ar002_proposta                         passo 6b
 *   → ar012_preco_como_objecao               passo 6c
 *   → ar003_agendamento                      passo 7
 *   → ar004_midia_saida                      passo 8
 *   → ar006_revelacao_automacao              passo 9
 *   → ar007_fora_da_janela                   passo 10
 *   → ar008_limite_diario                    passo 11
 *   → send
 * ```
 *
 * Copiada de propósito, e não gerada: este é o único lugar onde a sequência
 * completa fica legível, e é o que se compara com
 * `docs/10-anti-requisitos.md` quando a ordem muda.
 */
import { GUARD_SLOTS } from "./guard-order.js";
import type { GateInput, GateReason } from "./types.js";

/**
 * A ordem canônica, só os motivos. **Não reordenar** sem atualizar
 * `guard-order.ts` e `docs/10-anti-requisitos.md`.
 */
export const GUARD_ORDER: readonly GateReason[] = [
	"kill_switch_ativo",
	"r001_primeiro_contato_nao_humano",
	"lead_numero_invalido",
	"ar011_base_legal",
	"ar005_opt_out",
	"ar010_handoff_ativo",
	"ar009_midia_recebida",
	"ar001_preco",
	"ar002_proposta",
	"ar012_preco_como_objecao",
	"ar003_agendamento",
	"ar004_midia_saida",
	"ar006_revelacao_automacao",
	"ar007_fora_da_janela",
	"ar008_limite_diario",
] as const;

/** Motivo pelo qual o gate decidiu, com o detalhe que o painel mostra ao Admin. */
export interface Bloqueio {
	readonly reason: GateReason;
	readonly detail: string;
}

const detalhePadrao = (reason: GateReason): string =>
	`bloqueado por ${reason} (docs/10-anti-requisitos.md)`;

/**
 * Percorre a ordem canônica e devolve o **primeiro** bloqueio, ou `null`.
 *
 * Retorna `null` — não `send` — porque decidir o que fazer com a autorização é
 * do chamador: o dispatcher precisa gravar a mensagem, a fila precisa reenfileirar
 * e o painel só quer o motivo. Confundir "nenhuma regra disparou" com "pode
 * enviar" é como uma autorização vira efeito colateral.
 */
export const primeiroBloqueio = (input: GateInput): Bloqueio | null => {
	for (const slot of GUARD_SLOTS) {
		if (!slot.guard) continue;
		const reason = slot.guard(input);
		if (reason !== null) {
			return { reason, detail: detalhePadrao(reason) };
		}
	}
	return null;
};

/**
 * Avalia o gate. **Função pura**: não envia, não consulta banco, não tem efeito
 * colateral.
 *
 * ## Falha fechada
 *
 * Um erro lançado por um guard (regex catastrófica, campo ausente no snapshot)
 * **nunca** vira um `send`. O `try/catch` devolve `block` com
 * `erro_nao_mapeado` — a mesma disciplina do adaptador de LLM: falha vira
 * silêncio + notificação local, não uma mensagem não sanitizada a um lead.
 *
 * `messageId` é devolvido como string vazia porque o gate não tem acesso ao
 * registro persistido — o dispatcher o preenche com o id que acabou de gravar.
 */
export function evaluatePolicy(input: GateInput) {
	const checkedAt = input.context.now.toISOString();
	try {
		const bloqueio = primeiroBloqueio(input);
		if (bloqueio) {
			return { action: "block" as const, ...bloqueio, checkedAt };
		}
		return { action: "send" as const, messageId: "", checkedAt };
	} catch (erro) {
		return {
			action: "block" as const,
			reason: "erro_nao_mapeado" as const,
			detail: `erro ao avaliar o gate: ${String(erro)}`,
			checkedAt,
		};
	}
}

export type { Guard } from "./guard.js";
export { REASONS_PENDENTES_01_04 } from "./guard-order.js";
export type { GateInput, GateReason } from "./types.js";
