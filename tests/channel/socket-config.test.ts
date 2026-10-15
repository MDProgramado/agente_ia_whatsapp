/**
 * `socketConfigOverrides` — plataforma anunciada no vínculo companion
 * (T2 + T4b do 01-03-DIAG).
 *
 * `BAILEYS_BROWSER_MODE` isola o browser anunciado no `link_code_companion_reg`:
 * - `custom`  → `Browsers.windows("Chrome")` → `"Chrome (Windows)"`
 * - `default` → a chave `browser` é OMITIDA, e o
 *   `{ ...DEFAULT_CONNECTION_CONFIG, ...config }` do `makeWASocket`
 *   (`Socket/index.js:4-9`) mantém o `Browsers.macOS("Chrome")` interno.
 *
 * A omissão (e não `browser: undefined`) é o ponto: um `undefined` explícito
 * sobrescreveria o default e o pacote leria `browser[1]` de `undefined`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { socketConfigOverrides } from "../../src/channel/baileys/session.js";
import { env } from "../../src/config/env.js";

const loggerFake = {} as Parameters<typeof socketConfigOverrides>[0];

const displayCompanion = (browser: readonly string[]): string =>
	`${browser[1]} (${browser[0]})`;

const modoOriginal = env.BAILEYS_BROWSER_MODE;

afterEach(() => {
	env.BAILEYS_BROWSER_MODE = modoOriginal;
});

describe("socketConfigOverrides — plataforma do pareamento companion", () => {
	it("modo 'custom': anuncia o SO hospedeiro no formato 'Chrome (Windows)'", () => {
		env.BAILEYS_BROWSER_MODE = "custom";
		const cfg = socketConfigOverrides(loggerFake);
		expect(cfg.browser).toEqual(["Windows", "Chrome", "10.0.22631"]);
		expect(displayCompanion(cfg.browser ?? [])).toBe("Chrome (Windows)");
	});

	it("modo 'default': OMITE a chave browser (deixa o default do pacote)", () => {
		env.BAILEYS_BROWSER_MODE = "default";
		const cfg = socketConfigOverrides(loggerFake);
		expect("browser" in cfg).toBe(false);
	});

	it("mantém emitOwnEvents ligado (R-001/WHS-05)", () => {
		expect(socketConfigOverrides({} as typeof loggerFake).emitOwnEvents).toBe(
			true,
		);
	});

	it("aplica BAILEYS_LOG_LEVEL ao logger (T3: falha de handshake auditável)", () => {
		const logger = {} as typeof loggerFake;
		socketConfigOverrides(logger);
		expect(logger.level).toBe(env.BAILEYS_LOG_LEVEL);
	});
});
