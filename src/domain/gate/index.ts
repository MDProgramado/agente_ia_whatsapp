/**
 * Ponto de entrada do domínio do gate.
 *
 * O resto do sistema importa **daqui** (`domain/gate/index.js`), não de arquivos
 * internos: `evaluatePolicy` é a decisão, `GUARD_ORDER` é o contrato de ordem e
 * `AR_MAP` é a tradução de cada motivo para o anti-requisito e o requisito de
 * origem — é o que o painel e o relatório de conformidade consomem.
 */
import type { GateReason } from "./types.js";

export {
	evaluatePolicy,
	GUARD_ORDER,
	primeiroBloqueio,
	REASONS_PENDENTES_01_04,
} from "./evaluate-policy.js";
export type { Bloqueio } from "./evaluate-policy.js";
export type { Guard } from "./guard.js";
export type { Decision, GateInput, GateReason } from "./types.js";

/**
 * Uma linha do mapa: o anti-requisito (ou `null`), o requisito de origem e onde o
 * guard vive. `file: null` marca invariantes **estruturais** — não há guard
 * correspondente, a garantia é a arquitetura (choke-point por grep + barreira de
 * pacotes do Biome).
 */
export interface ArMapEntry {
	/** Número do AR (`"AR-001"`..`"AR-012"`) ou `null` para os motivos **não-AR**. */
	readonly ar: string | null;
	/** Requisito(s) de `docs/01-requisitos-funcionais.md` que originam o motivo. */
	readonly rule: string;
	/** Arquivo do guard, relativo a `src/domain/gate/`, ou `null` se estrutural. */
	readonly file: string | null;
	/** Texto curto, em pt-BR, para o painel da Fase 04. */
	readonly description: string;
}

/**
 * `AR_MAP` — 18 entradas, uma por `GateReason` da união fechada.
 *
 * As 12 primeiras linhas com `ar !== null` são os anti-requisitos; as 6 com
 * `ar: null` são motivos legítimos que **não** são AR (o kill switch, o Guard 0,
 * o número inválido e três invariantes estruturais).
 */
export const AR_MAP: Record<GateReason, ArMapEntry> = {
	// ── não-AR (6) ────────────────────────────────────────────────────────────
	kill_switch_ativo: {
		ar: null,
		rule: "R-034",
		file: "kill-switch.ts",
		description: "Chave de emergência ativada — nenhum envio até desligar.",
	},
	r001_primeiro_contato_nao_humano: {
		ar: null,
		rule: "R-001",
		file: "guard-0-r001.ts",
		description: "A primeira mensagem da conversa tem de ter sido humana.",
	},
	lead_numero_invalido: {
		ar: null,
		rule: "R-019",
		file: "guards/lead-number-invalid.ts",
		description: "O WhatsApp rejeitou o número (463) — estado terminal.",
	},
	envio_sem_gate: {
		ar: null,
		rule: "CONV-11",
		file: null,
		description: "Invariante estrutural: todo envio passa pelo dispatcher.",
	},
	timeout: {
		ar: null,
		rule: "R-045",
		file: null,
		description: "O gate não respondeu a tempo — falha fechada (silêncio).",
	},
	erro_nao_mapeado: {
		ar: null,
		rule: "R-045",
		file: null,
		description: "Exceção durante a avaliação — falha fechada (silêncio).",
	},

	// ── AR-001..AR-012 (12) ───────────────────────────────────────────────────
	ar001_preco: {
		ar: "AR-001",
		rule: "R-012",
		file: "guards/ar-001.ts",
		description: "Preço, valor ou desconto no outbound.",
	},
	ar002_proposta: {
		ar: "AR-002",
		rule: "R-012",
		file: "guards/ar-002.ts",
		description: "Proposta, orçamento ou condição comercial.",
	},
	ar003_agendamento: {
		ar: "AR-003",
		rule: "R-012, R-025",
		file: "guards/ar-003.ts",
		description: "Agendamento de reunião sem o Admin.",
	},
	ar004_midia_saida: {
		ar: "AR-004",
		rule: "R-037",
		file: "guards/ar-004.ts",
		description: "Mídia no outbound — apenas texto e link.",
	},
	ar005_opt_out: {
		ar: "AR-005",
		rule: "R-024",
		file: "guards/ar-005.ts",
		description: "Lead pediu opt-out — bloqueio permanente.",
	},
	ar006_revelacao_automacao: {
		ar: "AR-006",
		rule: "R-055, R-056, R-057",
		file: "guards/ar-006.ts",
		description: "Revelação espontânea de que há automação.",
	},
	ar007_fora_da_janela: {
		ar: "AR-007",
		rule: "R-006, R-058",
		file: "guards/ar-007.ts",
		description: "Fora da janela operacional (dias úteis, 7h–17h).",
	},
	ar008_limite_diario: {
		ar: "AR-008",
		rule: "R-023",
		file: "guards/ar-008.ts",
		description: "Limite diário de mensagens atingido.",
	},
	ar009_midia_recebida: {
		ar: "AR-009",
		rule: "R-038",
		file: "guards/ar-009.ts",
		description: "Mídia recebida do lead — não processar, handoff.",
	},
	ar010_handoff_ativo: {
		ar: "AR-010",
		rule: "R-014, R-066",
		file: "guards/ar-010.ts",
		description: "Handoff acionado — silêncio até o humano assumir.",
	},
	ar011_base_legal: {
		ar: "AR-011",
		rule: "R-064",
		file: "guards/ar-011.ts",
		description: "Lead sem registro de origem e base legal (LGPD).",
	},
	ar012_preco_como_objecao: {
		ar: "AR-012",
		rule: "R-012, R-041",
		file: "guards/ar-012.ts",
		description: "Contorno de preço tratado como objeção comum.",
	},
};
