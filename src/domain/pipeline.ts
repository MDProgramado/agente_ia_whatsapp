/**
 * Pipeline de vendas do CRM — os 9 status de RN-078/D-14 e as regras puras de
 * transição (D-15, D-16, RN-083..RN-085).
 *
 * ## O que é E o que não é este domínio
 *
 * `pipeline_status` responde "onde o lead está no FUNIL DE VENDAS" e vive só
 * na coluna `conversations.pipeline_status`. `state` é a FSM do motor
 * (novo/aquecimento/qualificando/…) e `stage` é sub-estágio de qualificação —
 * três domínios parecidos que, confundidos, fazem o motor setar o funil
 * (Pitfall 6 do 03-RESEARCH). Este arquivo nunca lê nem escreve `state`.
 *
 * ## Duas fontes de verdade, uma só regra
 *
 * O CHECK no banco (migration 0008) barra valor FORA do domínio; este módulo
 * barra TRANSIÇÃO inválida dentro do domínio. São barreiras diferentes e
 * complementares: nenhum dos dois depende do outro para falhar sozinho.
 *
 * Sem I/O, sem exceção: `transicaoValida` devolve booleano e quem chama decide
 * o que fazer (400 na borda Zod, silêncio no caminho automático).
 */

/**
 * Os 9 status EXATOS de RN-078/D-14. `as const` porque a ordem é semântica —
 * `ORDEM` abaixo lê o índice — e porque o CHECK do banco usa esta mesma lista.
 */
export const PIPELINE_STATUS = [
	"novo",
	"contatado",
	"respondeu",
	"qualificado",
	"aquecido",
	"reuniao_agendada",
	"proposta",
	"fechado",
	"perdido",
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUS)[number];

/**
 * Os 9 motivos de Perdido/encerramento de D-15/RN-084, na ordem do contexto de
 * decisão. `conversations.closed_reason` carrega o mesmo conjunto em CHECK.
 */
export const MOTIVOS = [
	"sem_resposta",
	"sem_interesse",
	"sem_verba",
	"sem_decisao",
	"concorrente",
	"fora_do_perfil",
	"opt_out",
	"bad_timing",
	"outro",
] as const;

export type Motivo = (typeof MOTIVOS)[number];

/**
 * Status críticos de RN-082: exigem JUSTIFICATIVA obrigatória na transição
 * (`reason` em `status_history`). RN-082 nomeia os quatro; para Perdido o
 * motivo é ainda enumerado (D-15), para os demais a justificativa é texto livre.
 */
export const STATUS_CRITICOS = [
	"reuniao_agendada",
	"proposta",
	"fechado",
	"perdido",
] as const;

/**
 * Posição no funil, do mais cedo ao mais tarde. `fechado` e `perdido` são
 * TERMINAIS (D-16) — o ranking deles existe só para a monotonia da correção
 * automática; a saída deles é decidida pelo ramo `de ∈ TERMINAIS`, não por aqui.
 */
const ORDEM: Record<PipelineStatus, number> = {
	novo: 0,
	contatado: 1,
	respondeu: 2,
	qualificado: 3,
	aquecido: 4,
	reuniao_agendada: 5,
	proposta: 6,
	fechado: 7,
	perdido: 8,
};

const TERMINAIS: ReadonlySet<PipelineStatus> = new Set<PipelineStatus>([
	"fechado",
	"perdido",
]);

/** Guarda de tipo em runtime: o valor vem da borda HTTP e o Zod ainda não viu. */
export const isPipelineStatus = (valor: unknown): valor is PipelineStatus =>
	typeof valor === "string" &&
	(PIPELINE_STATUS as readonly string[]).includes(valor);

/** Guarda de tipo para motivos (D-15) — usado pelo endpoint de correção. */
export const isMotivo = (valor: unknown): valor is Motivo =>
	typeof valor === "string" && (MOTIVOS as readonly string[]).includes(valor);

/**
 * RN-082: os status críticos exigem justificativa antes de gravar a transição.
 * A camada de query (queries/crm.ts) consulta isto antes do INSERT — não depois.
 */
export const exigeJustificativa = (status: string): boolean =>
	(STATUS_CRITICOS as readonly string[]).includes(status);

/** Rótulo pt-BR do status — a única fonte de tradução (banco guarda o valor). */
export const rotulo = (status: PipelineStatus): string => {
	switch (status) {
		case "novo":
			return "Novo";
		case "contatado":
			return "Contatado";
		case "respondeu":
			return "Respondeu";
		case "qualificado":
			return "Qualificado";
		case "aquecido":
			return "Aquecido";
		case "reuniao_agendada":
			return "Reunião agendada";
		case "proposta":
			return "Proposta";
		case "fechado":
			return "Fechado";
		case "perdido":
			return "Perdido";
	}
};

/** Rótulo pt-BR de um motivo (D-15) para exibição no painel. */
export const rotuloMotivo = (motivo: Motivo): string => {
	switch (motivo) {
		case "sem_resposta":
			return "Sem resposta";
		case "sem_interesse":
			return "Sem interesse";
		case "sem_verba":
			return "Sem verba";
		case "sem_decisao":
			return "Sem decisão";
		case "concorrente":
			return "Escolheu concorrente";
		case "fora_do_perfil":
			return "Fora do perfil";
		case "opt_out":
			return "Pediu para sair (opt-out)";
		case "bad_timing":
			return "Momento errado";
		case "outro":
			return "Outro";
	}
};

export interface TransicaoContexto {
	/**
	 * `true` quando a mudança é correção manual do Admin pela API do painel
	 * (RN-083: pode corrigir a qualquer momento). `undefined`/`false` é o
	 * caminho AUTOMÁTICO (IA, backfill, cadência) — e automação não reabre
	 * terminal nem rebaixa funil (D-16/RN-085).
	 */
	readonly manual?: boolean;
	/**
	 * `true` quando o lead tem `opt_out` ativo. D-16/AR-005: terminal e
	 * IRREVERSÍVEL — nenhuma transição reativa, nem com `manual: true`.
	 */
	readonly optOut?: boolean;
}

/**
 * A regra pura de transição do funil (D-14, D-15, D-16, RN-083..085).
 *
 * Ordem de verificação — cada caminho nega por um motivo diferente, e o
 * primeiro que casa vence:
 *
 * 1. **Domínio**: `de`/`para` fora dos 9 status → inválida (valor inventado).
 * 2. **opt_out**: lead com opt_out → NUNCA, nem manual (D-16/AR-005).
 * 3. **Mesmo status**: não é transição → inválida (a correção de MOTIVO não é
 *    mudança de status; `status_history` registra transições, não edições).
 * 4. **Saída de terminal** (`fechado`/`perdido` → qualquer): só com
 *    `manual: true` (D-16/RN-085 — `perdido → novo` é a reativação auditada;
 *    automação nunca reabre).
 * 5. **Automação** (sem `manual`): precisa ser AVANÇO no funil
 *    (`ORDEM[para] > ORDEM[de]`) — inclui ir para `perdido` (D-13: cadência
 *    encerrada) e para `fechado`. Retrocesso é exclusivamente manual.
 * 6. **Manual**: qualquer outra mudança é aceita (RN-083), inclusive rebaixar.
 *
 * Motivo/justificativa NÃO são parâmetros aqui: `exigeJustificativa` diz quem
 * exige, e `queries/crm.ts` recusa a gravação sem ele. Regra de transição e
 * preenchimento de campo são camadas diferentes — misturar as duas faria uma
 * transição válida virar inválida por causa de um campo que o INSERT preenche.
 */
export const transicaoValida = (
	de: string,
	para: string,
	contexto: TransicaoContexto = {},
): boolean => {
	if (!isPipelineStatus(de) || !isPipelineStatus(para)) return false;
	if (contexto.optOut === true) return false;
	if (de === para) return false;

	if (TERMINAIS.has(de)) return contexto.manual === true;

	if (contexto.manual === true) return true;

	// Caminho automático: só avanço estrito no funil.
	return ORDEM[para] > ORDEM[de];
};
