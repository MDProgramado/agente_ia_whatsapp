/**
 * Relatório de shadow — o GATE DE SAÍDA da Fase 2 (D-17/D-18, ADR-010).
 *
 * ## O que este relatório decide
 *
 * Shadow é a fase de treino: a IA rascunha, o Admin revisa, nada sai pelo
 * número. A promoção de shadow → ativo (D-18) NÃO é automática e NÃO é uma
 * impressão — ela depende deste relatório fechar em PASS. Sem cinco condições
 * satisfeitas (dias de operação, volume revisado, taxa de aprovação, zero
 * alucinação de conteúdo, zero revelação de automação), o veredito é FAIL e a
 * fase continua em shadow. Ver os limiares em `LIMIARES_PADRAO` e a nota de
 * decisão mais abaixo.
 *
 * ## D-17: a fonte é o BANCO, não o log
 *
 * Todas as métricas vêm de tabelas append-only (`messages`, `review_events`,
 * `handoff_events`, `optout_ledger`, `blocked_attempts`, `llm_runs`). Um
 * relatório montado a partir de arquivos de log não é auditável, não sobrevive à
 * rotação e não é o registro que a LGPD alcança. A regra é a mesma do
 * `daily-report.ts`: contar a partir dos EVENTOS gravados, não de um estado que
 * alguém pode sobrescrever.
 *
 * ## Onde os limiares moram — e por que NÃO em `settings`
 *
 * O plano (Task 3) permitia guardar os limiares em `settings` (chaves
 * `shadow_exit.*`) ou como constantes. A escolha é **constantes** em
 * `LIMIARES_PADRAO`, e a razão é de segurança (T-02-16): o gate de saída é um
 * CONTROLE de conformidade. Um valor em `settings` é editável em runtime — um
 * `UPDATE` acidental (ou malicioso) rebaixaria o limiar de aprovação de 80% para
 * 50% e o relatório passaria a liberar a promoção sem ninguém revisar código. A
 * constante muda por commit, com revisão, e a mudança fica no `git log`. É o
 * mesmo raciocínio que mantém `AR-001..AR-012` em código e não em prompt.
 *
 * ## Fuso e timestamps (o detalhe que morde)
 *
 * `messages.created_at` é `timestamp` SEM fuso; as demais colunas de tempo —
 * inclusive `llm_runs.created_at`, apesar do que se costuma supor — são
 * `timestamptz`. Comparar as duas famílias exige um cast, e o cast usa o fuso da
 * SESSÃO — que é consistente dentro de uma conexão.
 * Por isso as contas de janela e de "dias de operação" são feitas em SQL
 * (`::timestamptz` nos dois lados), nunca em JS com `.getTime()` sobre uma
 * string crua que o driver devolve sem tipo.
 */
import { pathToFileURL } from "node:url";
import { type SQL, sql } from "drizzle-orm";
import { env } from "../src/config/env.js";
import {
	PREFIXO_DETALHE_POS_GATE,
	scanPostGate,
} from "../src/domain/llm/post-gate.js";
import { closeDb, type Db, openDb } from "../src/infra/db/client.js";

/** Destino de uma linha de saída. Injetável para o teste capturar o que a CLI mostra. */
export type Escrever = (linha: string) => void;

/**
 * Limiares de saída de shadow (ADR-010). Nome de campo = regra, como no resto do
 * projeto: `minDaysOfOperation` lê-se "mínimo de dias de operação".
 */
export interface LimiaresShadow {
	/** ADR-010: a amostra tem de cobrir ao menos 14 dias de operação real. */
	readonly minDaysOfOperation: number;
	/** ADR-010: ao menos 100 rascunhos revisados antes de qualquer promoção. */
	readonly minSuggestionsReviewed: number;
	/** ADR-010: 80% de aprovação sobre o revisado. Comparação `>=` (fronteira passa). */
	readonly minApprovalRate: number;
	/** ADR-010: ZERO texto com valor/proposta/agenda no outbound gerado. */
	readonly maxCriticalHallucinations: number;
	/** ADR-010: ZERO revelação espontânea de automação (AR-006). */
	readonly maxAutomationReveals: number;
}

/** Os limiares de saída vigentes (ADR-010). Constantes de propósito — ver o doc-comment do topo. */
export const LIMIARES_PADRAO: LimiaresShadow = {
	minDaysOfOperation: 14,
	minSuggestionsReviewed: 100,
	minApprovalRate: 0.8,
	maxCriticalHallucinations: 0,
	maxAutomationReveals: 0,
};

export type VeredictoShadow = "PASS" | "FAIL";

/**
 * Janela temporal opcional. Sem ela, o relatório cobre TODO o histórico — é o
 * modo de produção. Com ela, cobre o intervalo — o modo do teste de fronteira,
 * que isola os dados semeados do resto do banco.
 */
export interface JanelaShadow {
	readonly desde?: Date;
	readonly ate?: Date;
}

/** O relatório completo: métricas de D-17 + veredito do gate de saída. */
export interface ShadowReport {
	readonly geradoEm: Date;
	readonly desde: Date | null;
	readonly ate: Date | null;

	// Operação
	readonly diasOperacao: number;
	readonly rascunhos: number;
	readonly conversasComRascunho: number;

	// Revisão humana
	readonly revisados: number;
	readonly aprovados: number;
	readonly editados: number;
	readonly descartados: number;
	readonly naoRevisados: number;
	readonly taxaAprovacao: number | null;
	readonly taxaEdicao: number | null;
	readonly taxaDescarte: number | null;

	// Handoff e opt-out
	readonly handoffs: number;
	readonly handoffsReconhecidos: number;
	readonly taxaHandoff: number | null;
	readonly optOuts: number;

	// LLM
	readonly corridasLlm: number;
	readonly falhasLlm: number;
	readonly taxaFalhaLlm: number | null;
	readonly tokensEntrada: number;
	readonly tokensSaida: number;
	readonly custoTotalUsd: number;
	readonly latenciaMediaMs: number | null;

	// Pós-gate (L4) e anti-requisitos de conteúdo
	readonly bloqueiosPosGate: number;
	readonly falsosPositivosPosGate: number;
	readonly alucinacoesCriticas: number;
	readonly revelacoesAutomacao: number;

	// Financeiro
	readonly margemAplicavel: boolean;
	readonly observacaoFinanceira: string;

	// Veredito do gate de saída
	readonly verdict: VeredictoShadow;
	readonly motivos: readonly string[];
	readonly limiares: LimiaresShadow;
}

const linhas = <T>(resultado: unknown): T[] =>
	(resultado as { rows: T[] }).rows;

/** Contagem escalar na coluna `c` — a mesma convenção de `daily-report.ts`. */
const contagem = async (db: Db, consulta: SQL): Promise<number> => {
	const resultado = await db.execute(consulta);
	return Number(linhas<{ c: number | string }>(resultado)[0]?.c ?? 0);
};

/**
 * Filtro de janela para uma coluna de tempo. Sem `desde`/`ate` a condição é
 * sempre verdadeira (o relatório cobre todo o histórico). O cast `::timestamptz`
 * é o que faz uma coluna `timestamp` (sem fuso) ser comparada por INSTANTE —
 * ver a nota de fuso no topo do arquivo.
 *
 * `coluna` é sempre um literal interno (nunca entrada de usuário), por isso
 * `sql.raw` é seguro aqui.
 */
const filtroJanela = (coluna: string, janela: JanelaShadow): SQL =>
	sql`(${janela.desde ?? null}::timestamptz is null or ${sql.raw(coluna)} >= ${janela.desde ?? null}::timestamptz)
		and (${janela.ate ?? null}::timestamptz is null or ${sql.raw(coluna)} < ${janela.ate ?? null}::timestamptz)`;

/** Taxa como fração (0..1); denominador zero devolve `null`, nunca 0 (T-01-30). */
const taxa = (numerador: number, denominador: number): number | null =>
	denominador > 0 ? numerador / denominador : null;

const formatarPercentual = (fracao: number): string =>
	`${(fracao * 100).toFixed(0)}%`;

export interface BuildShadowReportOpts {
	/** Instante de referência ("agora"). Injetável para o teste ser determinístico. */
	readonly agora?: Date;
	/** Janela temporal; ver `JanelaShadow`. */
	readonly janela?: JanelaShadow;
	/** Limiares do veredito; default `LIMIARES_PADRAO`. Injetável para o teste. */
	readonly limiares?: LimiaresShadow;
}

/** AR-006: revelação espontânea de automação — invariante de conformidade. */
const RAZAO_REVELACAO = "ar006_revelacao_automacao";

/**
 * Monta o relatório de shadow a partir do BANCO (D-17).
 *
 * Puro do ponto de vista de efeitos: só lê. O `agora` é injetado (o módulo não
 * chama `Date.now()`), e a `janela` recorta o histórico quando fornecida.
 */
export const buildShadowReport = async (
	db: Db,
	opts: BuildShadowReportOpts = {},
): Promise<ShadowReport> => {
	const agora = opts.agora ?? new Date();
	const janela = opts.janela ?? {};
	const limiares = opts.limiares ?? LIMIARES_PADRAO;

	// --- Operação: rascunhos e conversas -------------------------------------
	const rascunhos = await contagem(
		db,
		sql`
			select count(*) as c from messages
			where origin = 'ai_suggestion' and ${filtroJanela("created_at", janela)}
		`,
	);

	const conversasComRascunho = await contagem(
		db,
		sql`
			select count(distinct conversation_id) as c from messages
			where origin = 'ai_suggestion' and ${filtroJanela("created_at", janela)}
		`,
	);

	// "Dias de operação" = do PRIMEIRO rascunho até agora, em dias inteiros. Feito
	// em SQL para não depender de como o driver devolve um `timestamp` sem fuso.
	const segundosRes = await db.execute(sql`
		select extract(epoch from (${agora}::timestamptz - min(created_at)::timestamptz)) as s
		from messages
		where origin = 'ai_suggestion' and ${filtroJanela("created_at", janela)}
	`);
	const segundos = linhas<{ s: string | null }>(segundosRes)[0]?.s ?? null;
	const diasOperacao =
		segundos === null ? 0 : Math.max(0, Math.floor(Number(segundos) / 86_400));

	// --- Revisão: a decisão MAIS RECENTE por rascunho ------------------------
	// `distinct on (message_id) ... order by message_id, created_at desc, id desc`
	// responde "qual foi a última decisão deste rascunho" — um rascunho pode ter
	// mais de uma linha (editado depois de aprovado, por exemplo), e só a última
	// vale para as taxas.
	const porDecisaoRes = await db.execute(sql`
		with ultima as (
			select distinct on (message_id) message_id, decision
			from review_events
			where ${filtroJanela("created_at", janela)}
			order by message_id, created_at desc, id desc
		)
		select decision, count(*)::int as total from ultima group by decision
	`);
	const porDecisao = linhas<{ decision: string; total: number }>(porDecisaoRes);
	const aprovados =
		porDecisao.find((r) => r.decision === "approved")?.total ?? 0;
	const editados = porDecisao.find((r) => r.decision === "edited")?.total ?? 0;
	const descartados =
		porDecisao.find((r) => r.decision === "discarded")?.total ?? 0;
	const revisados = aprovados + editados + descartados;
	const naoRevisados = Math.max(rascunhos - revisados, 0);
	const taxaAprovacao = taxa(aprovados, revisados);
	const taxaEdicao = taxa(editados, revisados);
	const taxaDescarte = taxa(descartados, revisados);

	// --- Handoff e opt-out ---------------------------------------------------
	const handoffs = await contagem(
		db,
		sql`
			select count(*) as c from handoff_events
			where ${filtroJanela("created_at", janela)}
		`,
	);
	const handoffsReconhecidos = await contagem(
		db,
		sql`
			select count(*) as c from handoff_events
			where human_acknowledged_at is not null
				and ${filtroJanela("created_at", janela)}
		`,
	);
	const optOuts = await contagem(
		db,
		sql`
			select count(*) as c from optout_ledger
			where event_type = 'opt_out' and ${filtroJanela("occurred_at", janela)}
		`,
	);
	// Taxa de handoff por CONVERSA que gerou rascunho: "quantas conversas o bot
	// não conseguiu levar sozinho". Por rascunho seria enganoso (uma conversa
	// longa infla o denominador e faz o handoff parecer raro).
	const taxaHandoff = taxa(handoffs, conversasComRascunho);

	// --- LLM: falha-fechada, tokens, custo, latência --------------------------
	// Falha-fechada (D-10) = a corrida cujo schema não parseou OU cujo canário não
	// ecoou: nos dois casos o resultado foi SILÊNCIO, nunca texto livre. É a
	// métrica que diz se a IA está respondendo na forma pedida.
	const llmRes = await db.execute(sql`
		select
			count(*)::int as corridas,
			count(*) filter (where zod_parse_ok = false or canary_ok = false)::int as falhas,
			coalesce(sum(prompt_tokens), 0)::int as tok_in,
			coalesce(sum(completion_tokens), 0)::int as tok_out,
			coalesce(sum(cost_usd), 0)::numeric as custo,
			avg(latency_ms) as lat_media
		from llm_runs
		where ${filtroJanela("created_at", janela)}
	`);
	const llm = linhas<{
		corridas: number;
		falhas: number;
		tok_in: number;
		tok_out: number;
		custo: string;
		lat_media: string | null;
	}>(llmRes)[0];
	const corridasLlm = llm?.corridas ?? 0;
	const falhasLlm = llm?.falhas ?? 0;
	const taxaFalhaLlm = taxa(falhasLlm, corridasLlm);
	const latMediaBruta = llm?.lat_media ?? null;
	const latenciaMediaMs = latMediaBruta === null ? null : Number(latMediaBruta);

	// --- Pós-gate (L4) e anti-requisitos de conteúdo --------------------------
	const prefixoPosGate = `${PREFIXO_DETALHE_POS_GATE}%`;
	const bloqueiosPosGate = await contagem(
		db,
		sql`
			select count(*) as c from blocked_attempts
			where detail like ${prefixoPosGate} and ${filtroJanela("blocked_at", janela)}
		`,
	);

	// Falso-positivo do pós-gate: um texto que o L4 bloqueou mas que, re-escaneado
	// agora, é liberado. Em operação normal é 0 (o L4 é determinístico e não muda
	// sozinho); um valor > 0 significa que a REGRA mudou depois do bloqueio — o
	// detector de deriva (drift) dos regex. O `excerpt` é truncado em 280 chars,
	// então um termo proibido além desse corte escaparia da re-checagem; é o
	// preço da trilha curta e está registrado aqui.
	const blocosRes = await db.execute(sql`
		select excerpt from blocked_attempts
		where detail like ${prefixoPosGate} and ${filtroJanela("blocked_at", janela)}
	`);
	const falsosPositivosPosGate = linhas<{ excerpt: string }>(blocosRes).filter(
		(r) => scanPostGate(r.excerpt).allowed,
	).length;

	// Alucinação crítica = conteúdo comercial (valor/proposta/agenda) que apareceu
	// no TEXTO GERADO, bloqueado por qualquer camada (L4 ou gate canônico). Conta
	// por `rule_reference`, então pega os dois caminhos.
	const alucinacoesCriticas = await contagem(
		db,
		sql`
			select count(*) as c from blocked_attempts
			where rule_reference in ('ar001_preco', 'ar002_proposta', 'ar003_agendamento')
				and ${filtroJanela("blocked_at", janela)}
		`,
	);
	const revelacoesAutomacao = await contagem(
		db,
		sql`
			select count(*) as c from blocked_attempts
			where rule_reference = ${RAZAO_REVELACAO}
				and ${filtroJanela("blocked_at", janela)}
		`,
	);

	// --- Financeiro ----------------------------------------------------------
	// "Participação de margem se aplicável": nesta fase NÃO é apurável — o piloto
	// mede agendamentos, não faturamento contratado, e não há receita registrada
	// no banco. Inventar uma margem seria um número sem lastro. O custo de LLM,
	// esse sim, vem de `llm_runs`.
	const custoTotalUsd = Number(llm?.custo ?? 0);
	const observacaoFinanceira =
		"Margem por serviço não é apurável nesta fase: o piloto não registra receita contratada. " +
		"O custo de LLM é apurado de `llm_runs` (soma de `cost_usd`).";

	// --- Veredito ------------------------------------------------------------
	const { verdict, motivos } = avaliarVeredicto(
		{
			diasOperacao,
			revisados,
			taxaAprovacao,
			alucinacoesCriticas,
			revelacoesAutomacao,
		},
		limiares,
	);

	return {
		geradoEm: agora,
		desde: janela.desde ?? null,
		ate: janela.ate ?? null,
		diasOperacao,
		rascunhos,
		conversasComRascunho,
		revisados,
		aprovados,
		editados,
		descartados,
		naoRevisados,
		taxaAprovacao,
		taxaEdicao,
		taxaDescarte,
		handoffs,
		handoffsReconhecidos,
		taxaHandoff,
		optOuts,
		corridasLlm,
		falhasLlm,
		taxaFalhaLlm,
		tokensEntrada: llm?.tok_in ?? 0,
		tokensSaida: llm?.tok_out ?? 0,
		custoTotalUsd,
		latenciaMediaMs,
		bloqueiosPosGate,
		falsosPositivosPosGate,
		alucinacoesCriticas,
		revelacoesAutomacao,
		margemAplicavel: false,
		observacaoFinanceira,
		verdict,
		motivos,
		limiares,
	};
};

/** As cinco métricas que o veredito lê. Subconjunto de `ShadowReport` para o teste. */
export type MetricasDeSaida = Pick<
	ShadowReport,
	| "diasOperacao"
	| "revisados"
	| "taxaAprovacao"
	| "alucinacoesCriticas"
	| "revelacoesAutomacao"
>;

/**
 * Avalia o gate de saída. PASS só com as CINCO condições satisfeitas; qualquer
 * uma fora rebaixa para FAIL com o motivo em pt-BR. As comparações são `>=`/`<=`,
 * então atingir o limiar EXATO aprova (fronteira inclusiva) — é o que o teste de
 * fronteira prova.
 */
export const avaliarVeredicto = (
	metricas: MetricasDeSaida,
	limiares: LimiaresShadow = LIMIARES_PADRAO,
): { verdict: VeredictoShadow; motivos: string[] } => {
	const motivos: string[] = [];

	if (metricas.diasOperacao < limiares.minDaysOfOperation) {
		motivos.push(
			`dias de operação em shadow: ${metricas.diasOperacao} < mínimo de ${limiares.minDaysOfOperation}`,
		);
	}
	if (metricas.revisados < limiares.minSuggestionsReviewed) {
		motivos.push(
			`rascunhos revisados: ${metricas.revisados} < mínimo de ${limiares.minSuggestionsReviewed}`,
		);
	}
	if (
		metricas.taxaAprovacao === null ||
		metricas.taxaAprovacao < limiares.minApprovalRate
	) {
		motivos.push(
			`taxa de aprovação: ${
				metricas.taxaAprovacao === null
					? "sem dados (nenhum rascunho revisado)"
					: formatarPercentual(metricas.taxaAprovacao)
			} < mínimo de ${formatarPercentual(limiares.minApprovalRate)}`,
		);
	}
	if (metricas.alucinacoesCriticas > limiares.maxCriticalHallucinations) {
		motivos.push(
			`alucinações críticas de conteúdo (valor/proposta/agenda): ${metricas.alucinacoesCriticas} > máximo de ${limiares.maxCriticalHallucinations}`,
		);
	}
	if (metricas.revelacoesAutomacao > limiares.maxAutomationReveals) {
		motivos.push(
			`revelações espontâneas de automação (AR-006): ${metricas.revelacoesAutomacao} > máximo de ${limiares.maxAutomationReveals}`,
		);
	}

	return { verdict: motivos.length === 0 ? "PASS" : "FAIL", motivos };
};

/**
 * Formata o relatório em pt-BR, linha a linha (D-17: a saída é para o Admin ler
 * e decidir a promoção, não para um parser). A política de promoção (D-18) é
 * impressa junto, porque é o contexto que dá SENTIDO ao veredito.
 */
export const formatarRelatorio = (r: ShadowReport): string[] => {
	const pct = (f: number | null): string =>
		f === null ? "sem dados" : formatarPercentual(f);
	const num = (n: number | null): string =>
		n === null ? "sem dados" : n.toLocaleString("pt-BR");

	const periodo =
		r.desde === null && r.ate === null
			? "todo o histórico"
			: `${r.desde?.toISOString() ?? "início"} → ${r.ate?.toISOString() ?? "agora"}`;

	return [
		"=== Relatório de shadow (gate de saída da Fase 2 — D-17) ===",
		`Gerado em: ${r.geradoEm.toISOString()} | Período: ${periodo}`,
		"",
		`Dias de operação em shadow: ${r.diasOperacao}`,
		`Rascunhos gerados: ${r.rascunhos} (em ${r.conversasComRascunho} conversa(s))`,
		"",
		"-- Revisão humana --",
		`Revisados: ${r.revisados} (aprovados ${r.aprovados}, editados ${r.editados}, descartados ${r.descartados}, não revisados ${r.naoRevisados})`,
		`Taxa de aprovação: ${pct(r.taxaAprovacao)} | edição: ${pct(r.taxaEdicao)} | descarte: ${pct(r.taxaDescarte)}`,
		"",
		"-- Handoff e opt-out --",
		`Handoffs: ${r.handoffs} (reconhecidos pelo Admin: ${r.handoffsReconhecidos})`,
		`Taxa de handoff (por conversa com rascunho): ${pct(r.taxaHandoff)}`,
		`Opt-outs registrados: ${r.optOuts}`,
		"",
		"-- LLM --",
		`Corridas: ${r.corridasLlm} | falhas-fechadas (schema/canário): ${r.falhasLlm} (${pct(r.taxaFalhaLlm)})`,
		`Tokens: entrada ${num(r.tokensEntrada)}, saída ${num(r.tokensSaida)} | Custo total (USD): ${r.custoTotalUsd.toFixed(6)}`,
		`Latência média: ${r.latenciaMediaMs === null ? "sem dados" : `${Math.round(r.latenciaMediaMs)} ms`}`,
		"",
		"-- Pós-gate (L4) e anti-requisitos de conteúdo --",
		`Bloqueios do pós-gate: ${r.bloqueiosPosGate} (falsos-positivos detectados: ${r.falsosPositivosPosGate})`,
		`Alucinações críticas (AR-001/002/003 no texto gerado): ${r.alucinacoesCriticas}`,
		`Revelações de automação (AR-006): ${r.revelacoesAutomacao}`,
		"",
		"-- Financeiro --",
		`Margem por serviço aplicável: ${r.margemAplicavel ? "sim" : "não"}`,
		r.observacaoFinanceira,
		"",
		"-- Veredito do gate de saída --",
		`Limiares: ${r.limiares.minDaysOfOperation} dias, ${r.limiares.minSuggestionsReviewed} revisados, ${formatarPercentual(r.limiares.minApprovalRate)} de aprovação, ${r.limiares.maxCriticalHallucinations} alucinação(ões), ${r.limiares.maxAutomationReveals} revelação(ões)`,
		`VEREDITO: ${r.verdict}`,
		...(r.motivos.length > 0
			? r.motivos.map((m) => `  - ${m}`)
			: ["  (todas as condições de saída satisfeitas)"]),
		"",
		"-- Política de promoção (D-18) --",
		"A promoção shadow→ativo exige ação EXPLÍCITA do Admin: nenhum caminho de código autopromove. " +
			"Um veredito PASS acima HABILITA a decisão, não a executa.",
	];
};

const executadoDiretamente = (): boolean => {
	const alvo = process.argv[1];
	return alvo !== undefined && import.meta.url === pathToFileURL(alvo).href;
};

if (executadoDiretamente()) {
	const conexao = await openDb(env.DATABASE_URL);
	try {
		const relatorio = await buildShadowReport(conexao.db);
		for (const linha of formatarRelatorio(relatorio)) {
			console.log(linha);
		}
		// Código de saída espelha o veredito: FAIL é 1, para um script de CI poder
		// barrar a promoção sem parsear texto.
		process.exitCode = relatorio.verdict === "PASS" ? 0 : 1;
	} finally {
		await closeDb(conexao);
	}
}
