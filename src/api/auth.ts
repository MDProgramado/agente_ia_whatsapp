/**
 * Autenticação do painel local por token Bearer (D-18, T-03-12).
 *
 * O painel é a primeira superfície HTTP do projeto. O token é o ÚNICO controle
 * de acesso: uma página ou extensão de terceiro rodando no navegador do Admin
 * não consegue ler o painel sem ele. Por isso a comparação é com
 * `crypto.timingSafeEqual`, e não com `===`: uma comparação de string de tempo
 * variável deixa um canal lateral de timing em que um atacante local mede o
 * tempo de comparação caractere a caractere e reconstrói o token.
 *
 * `timingSafeEqual` lança se os buffers têm comprimentos diferentes — então o
 * caminho de comprimentos diferentes é interceptado ANTES e devolve `false`,
 * sem lançar. A função devolve booleano, nunca exceção: um `throw` no hook de
 * autenticação viraria 500 e revelaria que o caminho existe.
 *
 * O token vem de `env.PANEL_TOKEN` (`.env`, gitignored) e nunca é logado: o
 * `logger.ts` já redige `req.headers.authorization` e `*.token` no logger, então
 * um esquecimento de `redact` não vaza.
 */
import { timingSafeEqual } from "node:crypto";

/**
 * Compara duas strings em tempo constante. Comprimentos diferentes → `false`
 * imediato (sem lançar, e sem comparar conteúdo: não há o que comparar).
 */
export const timingSafeEqualStr = (a: string, b: string): boolean => {
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
};

/**
 * Valida o header `Authorization: Bearer <token>`.
 *
 * Devolve `true` só quando o scheme é exatamente `Bearer` (case-sensitive, como
 * exige RFC 9110) e o token casa em tempo constante. Qualquer outro scheme,
 * header ausente ou token divergente → `false` (o hook de borda converte em 401).
 */
export const requireToken = (
	headerAuthorization: string | undefined,
	token: string,
): boolean => {
	if (typeof headerAuthorization !== "string") return false;
	const match = /^Bearer\s+(\S+)$/.exec(headerAuthorization);
	if (match === null) return false;
	const capturado = match[1];
	if (typeof capturado !== "string") return false;
	return timingSafeEqualStr(capturado, token);
};
