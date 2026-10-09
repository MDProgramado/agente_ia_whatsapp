/**
 * Choke-point de envio (CONV-11) — invariante **estrutural**.
 *
 * Não há guard de runtime para "todo envio passa pelo dispatcher"; a garantia é a
 * arquitetura. Este teste a prende por varredura de código-fonte: conta as
 * CHAMADAS a `sendText` em `src/`, não as declarações. O que se procura é a
 * chamada de método — `algo.sendText(...)` —, então o regex exige o ponto antes
 * do nome.
 *
 * Por que um teste de grep e não um guard: nenhuma configuração de tipo ou
 * runtime impede um `import` novo de `ChannelPort` e uma chamada direta. O teste
 * transforma a convenção em falha de suíte — quem tentar contornar o dispatcher
 * quebra o build.
 *
 * Escopo `src/**&#47;*.ts` (sem `.test.ts` e sem `.d.ts`). O único arquivo que pode
 * chamar `sendText` é `dispatcher.ts`; qualquer outro é violação. As
 * declarações (`ChannelPort.ts`, `fake-channel.ts`, `adapter.ts`) NÃO casam,
 * porque o regex exige o `.` antes de `sendText`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Raiz do projeto: este arquivo vive em `tests/lint/`. */
const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(RAIZ, "src");

/** Chamada de método `X.sendText(`, com espaços opcionais antes do parêntese. */
const CHAMADA = /\.sendText\s*\(/;
const UNICO_PERMITIDO = "src/application/dispatcher.ts";

const listarFontes = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
		const caminho = join(dir, entrada.name);
		if (entrada.isDirectory()) return listarFontes(caminho);
		if (!entrada.isFile()) return [];
		if (!entrada.name.endsWith(".ts")) return [];
		if (entrada.name.endsWith(".test.ts") || entrada.name.endsWith(".d.ts")) {
			return [];
		}
		return [caminho];
	});

const comoPosix = (absoluto: string): string =>
	relative(RAIZ, absoluto).split(sep).join("/");

describe("choke-point de sendText", () => {
	it("apenas o dispatcher chama sendText", () => {
		const infratores = listarFontes(SRC)
			.filter((arquivo) => CHAMADA.test(readFileSync(arquivo, "utf8")))
			.map(comoPosix)
			.sort();

		expect(infratores).toEqual([UNICO_PERMITIDO]);
	});

	it("a varredura é não-vazia: encontra o dispatcher de fato", () => {
		// Sem isto, um `listarFontes` que devolvesse [] faria o teste acima passar
		// por vacuidade — o modo mais comum de um grep-test mentir.
		const dispatcher = join(RAIZ, ...UNICO_PERMITIDO.split("/"));
		expect(CHAMADA.test(readFileSync(dispatcher, "utf8"))).toBe(true);
	});
});
