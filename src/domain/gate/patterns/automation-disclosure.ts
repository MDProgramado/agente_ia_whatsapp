/**
 * Vocabulário de conteúdo — o **único** lugar onde estes termos são escritos
 * (acceptance da task 5). `AUTOMATION_TERM` (AR-006) mora aqui; os demais
 * (preço, agendamento, mídia) são consumidos pelos guards irmãos.
 *
 * Duas decisões valem uma linha cada:
 *
 * 1. **Fronteira de palavra em todo termo.** Um `/ia/i` sem `\b` casaria "dia",
 *    "seria", "faria" — o bot se calaria em metade das frases, falha silenciosa e
 *    cara. `\bia\b` casa a palavra e não a substring. Mesmo cuidado em "script"
 *    (não deve casar "javascript") e "bot" (não deve casar "robotizar").
 * 2. **Acento vira classe de caracteres, não normalização.** `[áa]` cobre a grafia
 *    acentuada e a não acentuada sem custo de runtime, e `semAcento` não é
 *    necessário para um termo isolado — só seria para comparação por igualdade.
 */

/**
 * Preço, valor, dinheiro. AR-001.
 *
 * Cobre as moedas que o piloto pode encontrar: o real (`R$`, `reais`), o dólar e
 * o euro em símbolo e em sigla, além das palavras genéricas de valor. `[$€£]`
 * pega "R$ 3.500", "US$ 1.200" e "€ 500" de uma vez (o símbolo seguido de
 * dígito); `\b(?:usd|eur|brl)\b` e os nomes por extenso fecham as grafias sem
 * símbolo. Sem esta cobertura, um preço em dólar passaria pelo AR-001 — a
 * violação mais grave da lista (01-04, Rule 2).
 */
export const CURRENCY_TERM =
	/\br\$\s*\d|[$€£]\s*\d|\breais?\b|\bdinheiro\b|\bvalor\b|\bor[çc]amento\b|\b(?:usd|eur|brl)\b|\bd[óo]lar(?:es)?\b|\beuros?\b/i;

/** Porcentagem e desconto como número — o LM pode produzir "50% off" sem dizer a palavra. */
export const PERCENT_TERM = /\b\d+\s*%|\bpor\s?cento\b/i;

/** Promoção e desconto comercial. AR-001/AR-012. */
export const DISCOUNT_TERM =
	/\bdesconto\b|\bpromo[çc][ãa]o\b|\bblack\s?friday\b|\bcupom\b/i;

/**
 * Preço dito sem moeda (AR-001). A auditoria 27/11b acrescentou as formas
 * coloquiais — "custo", "12 parcelas", "2 mil", "5k", "1.500 mensais",
 * "800 por mês", "por R$", "por 5k" — com três cuidados contra falso positivo:
 *
 * - `mil`/`k` tem lista negativa de quantidades que não são preço ("2 mil
 *   empresas", "mil clientes"), senão "Atendemos mais de 2 mil empresas." calaria.
 * - `mensal`/`mensais` exige número logo antes ("1.500 mensais"): "1 entrega
 *   mensal" passa.
 * - `parcelas` exige número antes ("12 parcelas"): "o número de parcelas" sem
 *   valor é condição comercial e continua sendo AR-002 (`CONDICAO_COMERCIAL_TERM`).
 * - `por <número>` só casa com unidade de dinheiro ("por 5k", "por R$"), para
 *   "por 10 anos"/"por 3 estados" passarem.
 */
export const PRICE_TERM =
	/\b(?:investimento|pre[çc]o|mensalidade|assinatura|gr[aá]tis|gra[çc]a)\b|\bcusta\s+(?:uns?\s+)?\d|\bsai\s+por\s+\d|\b\d{1,3}(?:\.\d{3})*x\s+de\s+\d|\bcusto\b|\b\d+\s+parcelas?\b|\d+(?:[.,]\d+)?\s?(?:mil|k)\b(?!\s+(?:clientes|empresas|usu[áa]rios|pessoas|seguidores))|\d\s+mensa(?:l|is)\b|\b\d+(?:[.,]\d+)?\s+por\s+m[êe]s\b|\bpor\s+r\$|\bpor\s+\d+(?:[.,]\d+)?\s?(?:mil|k|reais?)\b/i;

/** Proposta comercial. AR-002. */
export const PROPOSAL_TERM = /\bproposta\b|\bor[çc]amento\b/i;

/**
 * AR-004: o texto nomeia um arquivo de mídia.
 *
 * `[áa]udio` usa lookaround (`(?<!\w)` / `(?!\w)`) em vez de `\b` dos dois lados,
 * pela mesma razão documentada em `AUTOMATION_TERM` abaixo: `\b` é fronteira
 * entre `\w` e não-`\w`, e o JS só trata `[A-Za-z0-9_]` como `\w` — "á" de
 * "áudio" é NÃO-`\w`. Então `\b[áa]udio\b` falha quando "áudio" é a primeira
 * palavra da frase ou vem depois de um espaço (não há fronteira entre dois
 * caracteres não-`\w`), e a grafia acentuada escapava do AR-004 — um furo real
 * de mídia. `(?<!\w)` / `(?!\w)` testam o mesmo limite sem depender do `\b`.
 */
export const MEDIA_TERM =
	/\bfoto\b|\bimagem\b|(?<!\w)[áa]udio(?!\w)|\bv[íi]deo\b|\bpdf\b|\bplanilha\b/i;

/**
 * AR-004: extensão de mídia na URL.
 *
 * É o que barra um link de PDF disfarçado de link normal — a checagem estrutural
 * de `parts` deixa `link` passar, e o texto pode estar limpo. Case-insensitive
 * porque `.JPG` e `.jpg` são o mesmo arquivo.
 *
 * A extensão precisa TERMINAR o token: sem âncora nenhuma, `.pdf` casaria dentro
 * de um nome maior; com `$` puro (o bug WR-02), só casasse no fim exato do texto
 * e `"baixe em https://ex.com/arquivo.pdf e responda"` passava. `[^\w]` fecha o
 * token sem depender de onde ele está — cobre espaço, `?`/`#` de query/fragment
 * E pontuação de frase (`.`, `,`, `)`, `;`), que o `[?#\s]` sugerido originalmente
 * deixaria passar em "…/arquivo.pdf." (fim de frase sem espaço depois).
 */
export const MEDIA_LINK_EXT =
	/\.(png|jpe?g|gif|webp|mp3|ogg|opus|m4a|mp4|mov|pdf|docx?|xlsx?|pptx?|zip)(?:[^\w]|$)/i;

/**
 * Agendamento. AR-003.
 *
 * Cobre o infinitivo (`agendar`) **e as conjugações** que o verbo assume numa
 * frase real ("já agendei", "agendou", "agendando"): o `\bagendar\b` original
 * deixava passar "já agendei amanhã", que é exatamente a intenção proibida. As
 * formas foram listadas explicitamente, sem `\bagend\w*`, para não casar `agenda`
 * (o substantivo: "minha agenda") — um falso positivo que calaria conversa
 * normal. `-feira` entra como dia da semana citado ("quinta-feira"); o sufixo é
 * obrigatório justamente para não casar "segunda opção". `Atendimento 24h` é
 * expediente genérico, não horário de reunião, e precisa continuar passando.
 * A hora usa `(?<!\w)`/`(?!\w)`: `\bàs` nunca casava, porque "à" é não-`\w` em JS,
 * e o sufixo `h`/`horas` é opcional dentro da fronteira final ("às 14h").
 *
 * Auditoria 27/11b: convite sem verbo de agenda — "ligação", "te chamo",
 * "minutinhos" e a hora solta ("15h", "9h30"). A hora solta tem lookahead
 * negativo para `24h` (o expediente continua liberado); qualquer outra hora
 * bloqueia, inclusive prazo de resposta ("em até 2h") — fail-closed aceito pelo
 * usuário.
 */
export const SCHEDULE_TERM =
	/\bagend(?:ar|ei|ou|ando|em|amos)\b|\bmar(?:car|quei|que|quem|cou|cando|camos|cada|cado)\b|\bte\s+ligar\b|\btelefonar\b|\breuni[ãa]o\b|\bchamada\b|\bcall\b|\bhor[áa]rio\b|(?<!\w)às\s+\d{1,2}(?:h|horas?)?(?!\w)|\b(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)-feira\b|\bliga[çc](?:[ãa]o|[õo]es)\b|\bte\s+chamo\b|(?<!\w)(?!24\s?h)\d{1,2}\s?h(?:\d{2})?(?!\w)|\bminutinhos?\b/i;

/**
 * AR-006. `\bia\b` é o caso perigoso: sem `\b` ele casaria "dia".
 * `\brob[ôo]\b` aceita as duas grafias de "robô"; `\bsistema autom[áa]tico\b`
 * exige a palavra "sistema" para não barrar o adjetivo solto.
 */
export const AUTOMATION_TERM: readonly RegExp[] = [
	/\bautoma[çc][ãa]o\b/i,
	/\bbots?\b/i,
	/\bchatbots?\b/i,
	/\bia\b/i,
	/\bgpt\b/i,
	/\bopen\s?ai\b/i,
	/\bassistente\s+virtual\b/i,
	/\bscripts?\b/i,
	/**
	 * `\brob[ôo]\b` NÃO funciona: `\b` é fronteira entre `\w` e não-`\w`, e
	 * JavaScript trata só [A-Za-z0-9_] como `\w` — "ô" é não-`\w`. Então a
	 * fronteira depois do acento cai dentro da palavra e nunca casa. A terminação
	 * usa lookahead explícito: `(?!\w)`, que é o mesmo teste de fronteira mas
	 * posicionado depois de um caractere acento. `robots?` cobre o plural.
	 */
	/\brob[ôo]?(?!\w)/i,
	/\bsistema\s+autom[áa]tico\b/i,
];

/**
 * "IA" é o termo perigoso: `\bia\b` não casa "dia" nem "seria", mas casa a
 * menção de negócio "trabalhamos com IA generativa" — e isso é **proposital**.
 *
 * O gate não tem contexto para saber se o bot está se apresentando ou falando de
 * IA como tecnologia, e errar para o lado de enviar é o erro que a regra proíbe
 * (D-11, fail-closed). Quem distingue os dois casos é o prompt (ADR-012) e, no
 * pior caso, o handoff humano — não um regex.
 */
export const IA_E_TECNOLOGIA = "ia";

/** Preço na forma de objeção ("fica caro, não tenho orçamento") — AR-012. */
export const OBJECTION_TERM =
	/\b(car[oa]|s[áa]o\s+car[oa]|custa\s+(muito|demais))\b|\bn[ãa]o\s+tenho\s+(dinheiro|or[çc]amento)\b|\best[áa]\s+fora\s+do\s+(or[çc]amento|bolso)\b/i;

/** Primeiro termo que casar no texto, ou `null`. A ordem da lista é a precedência. */
export const primeiroTermoQueCasa = (
	texto: string,
	termos: readonly RegExp[],
): string | null => {
	for (const t of termos) {
		const achado = texto.match(t);
		if (achado) return achado[0];
	}
	return null;
};

/**
 * Gatilhos de ENTRADA (mensagem do lead) para handoff determinístico. São
 * aditivos: só podem ACRESCENTAR um handoff, nunca anular o sinal da LLM
 * (`inbound-handler.ts`). Auditoria 27/11b: valor, preço(s), proposta,
 * orçamento, cobra(m/r), "quanto fica/é/sai/cobra" e tabela. "Valeu" não casa
 * `\bvalor`, e "pode mandar mais informações" não tem termo comercial.
 */
export const HANDOFF_PRICE_TERM =
	/\bquanto\s+custa\b|\bqual\s+(?:[ée]\s+)?o\s+pre[çc]o\b|\bme\s+passe\s+o\s+pre[çc]o\b|\bquanto\s+sa[ií]\b|(?<!\w)[ée]\s+quanto\b|\bvalor(?:es)?\b|\bpre[çc]os?\b|\bproposta\b|\bor[çc]amento\b|\bcobra(?:m|r)?\b|\bquanto\s+(?:custa|fica|[ée]|sai|cobra)\b|\btabela\b/i;

/** Auditoria 27/11b: "ligar", "ligação" e "semana que vem" entram como pedido de agenda. */
export const HANDOFF_SCHEDULE_TERM =
	/\bagend(?:ar|ei|ou|ando|em|amos)\b|\bmar(?:car|quei|que|quem|cou|cando|camos|cada|cado)\b|\breuni[ãa]o\b|\bchamada\b|\bcall\b|\bligar\b|\bliga[çc][ãa]o\b|\bsemana\s+que\s+vem\b/i;

export const HANDOFF_IRRITATION_TERM =
	/\birritant|\bchatead|\bperdi\s+meu\s+tempo\b|\bn[ãa]o\s+resolve\b/i;

export const detectarGatilhoHandoff = (texto: string): string | null => {
	if (HANDOFF_PRICE_TERM.test(texto)) return "preco";
	if (HANDOFF_SCHEDULE_TERM.test(texto)) return "agendamento";
	if (primeiroTermoQueCasa(texto, AUTOMATION_TERM) !== null) return "bot";
	if (HANDOFF_IRRITATION_TERM.test(texto)) return "irritacao";
	return null;
};
