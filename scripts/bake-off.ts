/**
 * Harness de bake-off — decide PROVIDER e MODELO por EVIDÊNCIA, não por chute
 * (D-10, pesquisa §Bake-off / Open Questions Q1-Q2).
 *
 * ## Por que isto existe
 *
 * O projeto mantém a escolha de LLM aberta (R-009): `ai@7` dá uma interface só,
 * e trocar de provider toca um arquivo. Mas "dá para trocar" não é "está
 * decidido". Este harness responde à pergunta "qual provider/modelo usar" com uma
 * medição offline sobre um corpus pt-BR, em vez de uma preferência.
 *
 * ## Como ele pontua — e por que os LIMITES pesam mais
 *
 * Cada candidato gera uma resposta para cada transcript e é pontuado em duas
 * dimensões:
 *
 * 1. **Limites** (peso 0.6): o texto gerado passa pelo pós-gate L4
 *    (`scanPostGate`)? Um texto com valor, proposta, agenda ou mídia é uma
 *    violação de anti-requisito — a dimensão que NÃO se negocia. Por isso ela
 *    vale mais que a qualidade de estilo.
 * 2. **Registro consultivo** (peso 0.4): uma heurística pt-BR (pergunta aberta,
 *    marcadores de escuta, tamanho de mensagem) aproxima "o tom é consultivo e
 *    humanizado" (R-010). É um SCORE DE CAMPO, não um benchmark controlado — e
 *    está rotulado como tal.
 *
 * `combinado = 0.6 * limitesTaxa + 0.4 * registroMedio`. Empate desempata por
 * menos falhas (schema/canário) e depois por nome — nunca por ordem de array.
 *
 * ## Offline por padrão
 *
 * Sem chave de provider no ambiente, o harness roda com adaptadores ROTEIRIZADOS
 * (determinísticos, sem rede) e o veredito sai rotulado `offline`. Isso testa o
 * próprio harness (o score DISCRIMINA perfis diferentes) e não finge comparar
 * providers reais. Com `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GOOGLE_*` presentes,
 * os providers reais entram por `import()` dinâmico e o modo vira
 * `provedores-reais`. As chaves são lidas do ambiente; nenhuma é gravada.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LanguageModel } from "ai";
import {
	canarioEsperado,
	type ExtractionEnvelope,
	type GenerationEnvelope,
} from "../src/domain/llm/envelope.js";
import { scanPostGate } from "../src/domain/llm/post-gate.js";
import type { GenerateResult, LlmPort } from "../src/domain/ports/LlmPort.js";
import { criarAiSdkAdapter } from "../src/infra/llm/ai-sdk-adapter.js";
import { scriptedLlmAdapter } from "../src/infra/llm/scripted-adapter.js";

/** Destino de uma linha de saída. Injetável para o teste capturar o que a CLI mostra. */
export type Escrever = (linha: string) => void;

/** Peso da dimensão "respeita os limites" (safety first — ver o doc-comment do topo). */
export const PESO_LIMITES = 0.6;
/** Peso da dimensão "registro consultivo". */
export const PESO_REGISTRO = 0.4;

/** Um item do corpus: a mensagem mascarada do lead, com o estado resolvido por código. */
export interface Transcript {
	readonly id: string;
	/** Estado AUTORITATIVO que o `resolveNextState` escolheria (Camada 2, D-07). */
	readonly estado: string;
	/** Prompt já mascarado (D-16) — o harness não monta prompt com PII. */
	readonly prompt: string;
}

/**
 * Corpus pt-BR de prospecção B2B (24 itens — a faixa pedida é 20-40). Os prompts
 * já vêm mascarados (telefone/endereço trocados por marcadores), como sairiam do
 * `prompt-builder.ts`. A variedade cobre saudação, objeções, qualificação e
 * sinais de risco — é o que exercita tanto o registro quanto os limites.
 */
export const TRANSCRIPTS: readonly Transcript[] = [
	{
		id: "t01",
		estado: "aquecimento",
		prompt: "Bom dia, tudo bem? Vi que vocês fazem sites.",
	},
	{
		id: "t02",
		estado: "aquecimento",
		prompt: "Oi, quem é você? De onde tirou meu contato?",
	},
	{
		id: "t03",
		estado: "qualificando",
		prompt: "Que tipo de serviço vocês fazem exatamente?",
	},
	{ id: "t04", estado: "qualificando", prompt: "Quanto custa um site desses?" },
	{ id: "t05", estado: "contorno_objecao", prompt: "Está caro pra mim agora." },
	{
		id: "t06",
		estado: "contorno_objecao",
		prompt: "Já tenho um fornecedor que cuida disso.",
	},
	{
		id: "t07",
		estado: "contorno_objecao",
		prompt: "Preciso pensar, vou ver com meu sócio.",
	},
	{
		id: "t08",
		estado: "aquecimento",
		prompt: "Estou sem tempo agora, me chama depois.",
	},
	{
		id: "t09",
		estado: "qualificando",
		prompt: "Vocês fazem sistema interno ou só site?",
	},
	{
		id: "t10",
		estado: "qualificando",
		prompt: "Minha empresa é pequena, dá pra começar pequeno?",
	},
	{
		id: "t11",
		estado: "aquecimento",
		prompt: "Achei interessante, como funciona o processo?",
	},
	{
		id: "t12",
		estado: "contorno_objecao",
		prompt: "Um amigo disse que isso não dá resultado.",
	},
	{
		id: "t13",
		estado: "qualificando",
		prompt: "Você é uma pessoa real? Ou é robô?",
	},
	{
		id: "t14",
		estado: "aquecimento",
		prompt: "Boa tarde! Podemos conversar sobre um projeto?",
	},
	{
		id: "t15",
		estado: "qualificando",
		prompt: "Qual o prazo de entrega de um site institucional?",
	},
	{
		id: "t16",
		estado: "contorno_objecao",
		prompt: "Já tentei isso com outra agência e não funcionou.",
	},
	{
		id: "t17",
		estado: "aquecimento",
		prompt: "Será que serve pro meu segmento? É uma clínica.",
	},
	{
		id: "t18",
		estado: "qualificando",
		prompt: "Vocês dão suporte depois que o site fica pronto?",
	},
	{
		id: "t19",
		estado: "contorno_objecao",
		prompt: "Não tenho verba pra isso agora, sabe como é.",
	},
	{
		id: "t20",
		estado: "aquecimento",
		prompt: "Me manda mais detalhes, por favor.",
	},
	{
		id: "t21",
		estado: "qualificando",
		prompt: "Como vocês medem o retorno do investimento?",
	},
	{
		id: "t22",
		estado: "contorno_objecao",
		prompt: "Meu sobrinho faz site de graça, por que eu pagaria?",
	},
	{
		id: "t23",
		estado: "aquecimento",
		prompt: "Bom dia, gostaria de entender melhor a proposta.",
	},
	{
		id: "t24",
		estado: "qualificando",
		prompt: "Isso funciona no celular também, né?",
	},
];

/** Texto consultivo de referência — usado pelo candidato roteirizado `consultivo`. */
export const TEXTO_CONSULTIVO =
	"Olá! Entendo o seu momento. Posso entender melhor o que a sua empresa busca agora para te ajudar sem enrolação?";

/** Marcadores de tom consultivo/empático (pt-BR) para a heurística de registro. */
export const MARCADORES_CONSULTIVOS: readonly string[] = [
	"olá",
	"ola",
	"tudo bem",
	"entendo",
	"imagino",
	"com certeza",
	"claro",
	"posso",
	"podemos",
	"ajudar",
	"empresa",
	"sua empresa",
	"presença digital",
	"presenca digital",
];

/**
 * Score de registro consultivo (0..1), heurístico e rotulado como tal.
 *
 * - pergunta aberta (`?`) → +0.5 (conduz a conversa em vez de despejar texto);
 * - marcador de escuta/empatia → +0.3;
 * - tamanho entre 40 e 400 chars → +0.2 (nem telegráfico, nem um paredão).
 *
 * Satura em 1.0. Não é um benchmark: é um filtro grosso para o bake-off não
 * ranquear por "quem fala mais bonito" sem nenhum critério.
 */
export const avaliarRegistro = (texto: string): number => {
	const t = texto.toLowerCase();
	let nota = 0;
	if (t.includes("?")) nota += 0.5;
	if (MARCADORES_CONSULTIVOS.some((m) => t.includes(m))) nota += 0.3;
	const n = texto.trim().length;
	if (n >= 40 && n <= 400) nota += 0.2;
	return Math.min(nota, 1);
};

/** Um candidato a provider/modelo, pronto para gerar. */
export interface CandidatoBakeOff {
	readonly provider: string;
	readonly model: string;
	readonly adapter: LlmPort<ExtractionEnvelope, GenerationEnvelope>;
}

/** Resultado de um candidato no corpus. */
export interface AvaliacaoCandidato {
	readonly provider: string;
	readonly model: string;
	readonly total: number;
	readonly falhas: number;
	readonly limitesOk: number;
	readonly limitesTaxa: number;
	readonly registroMedio: number;
	readonly combinado: number;
}

/** O veredito do bake-off: a configuração vencedora e as notas de todas. */
export interface VereditoBakeOff {
	readonly modo: "offline" | "provedores-reais";
	readonly total: number;
	readonly avaliacoes: readonly AvaliacaoCandidato[];
	readonly vencedor: {
		readonly provider: string;
		readonly model: string;
	} | null;
}

/** Ordenação total: combinado desc, depois menos falhas, depois nome. Nunca por ordem de array. */
const comparar = (a: AvaliacaoCandidato, b: AvaliacaoCandidato): number =>
	b.combinado - a.combinado ||
	a.falhas - b.falhas ||
	a.provider.localeCompare(b.provider) ||
	a.model.localeCompare(b.model);

/**
 * Roda o bake-off sobre os candidatos. Puro quanto a efeitos externos (não grava
 * nada); quem chama decide persistir o veredito.
 *
 * Um candidato que lança ou não ecoa o canário conta como FALHA daquela corrida e
 * não entra nas médias — um provider instável não é premiado por "não ter texto
 * ruim".
 */
export const runBakeOff = async (
	candidatos: readonly CandidatoBakeOff[],
	opts: { readonly transcripts?: readonly Transcript[] } = {},
): Promise<VereditoBakeOff> => {
	const transcripts = opts.transcripts ?? TRANSCRIPTS;
	const avaliacoes: AvaliacaoCandidato[] = [];

	for (const candidato of candidatos) {
		let falhas = 0;
		let limitesOk = 0;
		let somaRegistro = 0;
		let avaliados = 0;

		for (const t of transcripts) {
			const canary = canarioEsperado(`bakeoff:${t.id}`);
			let resultado: GenerateResult<GenerationEnvelope>;
			try {
				resultado = await candidato.adapter.generate({
					prompt: t.prompt,
					canary,
					resolvedState: t.estado,
				});
			} catch {
				falhas += 1;
				continue;
			}
			if (!resultado.ok || resultado.output.canary !== canary) {
				falhas += 1;
				continue;
			}
			avaliados += 1;
			if (scanPostGate(resultado.output.replyText).allowed) limitesOk += 1;
			somaRegistro += avaliarRegistro(resultado.output.replyText);
		}

		const limitesTaxa = avaliados > 0 ? limitesOk / avaliados : 0;
		const registroMedio = avaliados > 0 ? somaRegistro / avaliados : 0;
		avaliacoes.push({
			provider: candidato.provider,
			model: candidato.model,
			total: transcripts.length,
			falhas,
			limitesOk,
			limitesTaxa,
			registroMedio,
			combinado: PESO_LIMITES * limitesTaxa + PESO_REGISTRO * registroMedio,
		});
	}

	const ordenadas = [...avaliacoes].sort(comparar);
	const primeira = ordenadas[0];
	return {
		modo: candidatos.some((c) => c.provider !== "scripted")
			? "provedores-reais"
			: "offline",
		total: transcripts.length,
		avaliacoes: ordenadas,
		vencedor: primeira
			? { provider: primeira.provider, model: primeira.model }
			: null,
	};
};

/**
 * Candidatos OFFLINE: dois perfis roteirizados. Eles não comparam providers reais
 * — servem para provar que o SCORE discrimina perfis diferentes (é o auto-teste do
 * harness quando não há chave no ambiente).
 */
export const candidatosOffline = (): CandidatoBakeOff[] => [
	{ provider: "scripted", model: "neutro", adapter: scriptedLlmAdapter() },
	{
		provider: "scripted",
		model: "consultivo",
		adapter: scriptedLlmAdapter({ geracao: { replyText: TEXTO_CONSULTIVO } }),
	},
];

type FabricaProvider = (modelo: string) => LanguageModel;

/**
 * Provedores reais, habilitados só quando a chave está no ambiente. O `import()`
 * é dinâmico e o módulo é tratado como `unknown`, para que a AUSÊNCIA de um
 * provider não quebre o typecheck nem o caminho offline.
 */
const PROVEDORES: readonly {
	readonly id: string;
	readonly envKey: string;
	readonly pacote: string;
	readonly fabrica: string;
	readonly modelo: string;
}[] = [
	{
		id: "openai",
		envKey: "OPENAI_API_KEY",
		pacote: "@ai-sdk/openai",
		fabrica: "openai",
		modelo: "gpt-4o-mini",
	},
	{
		id: "anthropic",
		envKey: "ANTHROPIC_API_KEY",
		pacote: "@ai-sdk/anthropic",
		fabrica: "anthropic",
		modelo: "claude-3-5-sonnet-latest",
	},
	{
		id: "google",
		envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
		pacote: "@ai-sdk/google",
		fabrica: "google",
		modelo: "gemini-2.0-flash",
	},
];

/** Constrói os candidatos reais para os quais há chave; ignora (com aviso) os que falharem. */
export const carregarCandidatosReais = async (
	escrever: Escrever,
): Promise<CandidatoBakeOff[]> => {
	const candidatos: CandidatoBakeOff[] = [];
	for (const p of PROVEDORES) {
		if (!process.env[p.envKey]) continue;
		try {
			const mod = (await import(p.pacote)) as Record<string, unknown>;
			const fabrica = mod[p.fabrica] as FabricaProvider | undefined;
			if (typeof fabrica !== "function") {
				escrever(
					`[bake-off] ${p.id}: export '${p.fabrica}' ausente — ignorado`,
				);
				continue;
			}
			candidatos.push({
				provider: p.id,
				model: p.modelo,
				adapter: criarAiSdkAdapter({
					model: fabrica(p.modelo),
					promptVersion: `bakeoff-${p.id}`,
					policyVersion: "bakeoff",
				}),
			});
		} catch (erro) {
			const motivo = erro instanceof Error ? erro.message : String(erro);
			escrever(`[bake-off] provedor ${p.id} indisponível: ${motivo}`);
		}
	}
	return candidatos;
};

/** Formata o veredito em pt-BR (o Admin lê a decisão, não um JSON). */
export const formatarVeredito = (v: VereditoBakeOff): string[] => {
	const pct = (f: number): string => `${(f * 100).toFixed(1)}%`;
	const linhas: string[] = [
		"=== Bake-off de provider/modelo (D-10) ===",
		`Modo: ${v.modo} | Transcripts: ${v.total}`,
		"",
		"Avaliações (ordenadas por score combinado):",
		...v.avaliacoes.map(
			(a) =>
				`  ${a.provider}/${a.model}: combinado ${a.combinado.toFixed(3)} ` +
				`(limites ${pct(a.limitesTaxa)} · registro ${a.registroMedio.toFixed(2)} · falhas ${a.falhas})`,
		),
		"",
		v.vencedor
			? `VENCEDOR: ${v.vencedor.provider}/${v.vencedor.model}`
			: "VENCEDOR: (nenhum candidato)",
	];
	if (v.modo === "offline") {
		linhas.push(
			"",
			"Nota: modo offline — apenas adaptadores roteirizados. O veredito valida o harness,",
			"não decide provider real. Defina OPENAI_API_KEY/ANTHROPIC_API_KEY/GOOGLE_* para comparar de verdade.",
		);
	}
	return linhas;
};

const RAIZ_REPO = fileURLToPath(new URL("..", import.meta.url));

/** Caminho do artefato do veredito (ao lado do relatório de shadow, na fase). */
export const caminhoVeredito = (): string =>
	join(
		RAIZ_REPO,
		".planning",
		"phases",
		"02-ia-handoff-e-shadow-mode",
		"bake-off-resultado.json",
	);

const executadoDiretamente = (): boolean => {
	const alvo = process.argv[1];
	return alvo !== undefined && import.meta.url === pathToFileURL(alvo).href;
};

if (executadoDiretamente()) {
	const escrever: Escrever = (linha) => console.log(linha);
	const reais = await carregarCandidatosReais(escrever);
	const candidatos = reais.length > 0 ? reais : candidatosOffline();
	const veredito = await runBakeOff(candidatos);
	for (const linha of formatarVeredito(veredito)) {
		escrever(linha);
	}

	const saida = caminhoVeredito();
	mkdirSync(dirname(saida), { recursive: true });
	writeFileSync(
		saida,
		`${JSON.stringify({ ...veredito, geradoEm: new Date().toISOString() }, null, 2)}\n`,
		"utf8",
	);
	escrever(`Veredito gravado em: ${saida}`);
}
