/**
 * `socketConfigOverrides` — plataforma anunciada no vínculo companion (T2 do 01-03-DIAG).
 *
 * O default do pacote (`Browsers.macOS("Chrome")`) anuncia
 * `companion_platform_display` como `"Chrome (Mac OS)"`. Em Windows, o valor
 * coerente com o SO hospedeiro é `"Chrome (Windows)"`. O display é montado pelo
 * pacote como `` `${browser[1]} (${browser[0]})` `` (`Socket/socket.js:640-643`),
 * então a asserção reconstrói a string a partir da tupla de `browser` do config.
 */
import { describe, expect, it } from "vitest";
import { socketConfigOverrides } from "../../src/channel/baileys/session.js";

const loggerFake = {} as Parameters<typeof socketConfigOverrides>[0];

const displayCompanion = (browser: readonly string[]): string =>
	`${browser[1]} (${browser[0]})`;

describe("socketConfigOverrides — plataforma do pareamento companion", () => {
	it("anuncia o SO hospedeiro (Windows) no formato 'Chrome (Windows)'", () => {
		const cfg = socketConfigOverrides(loggerFake);
		expect(cfg.browser).toEqual(["Windows", "Chrome", "10.0.22631"]);
		expect(displayCompanion(cfg.browser ?? [])).toBe("Chrome (Windows)");
	});

	it("mantém emitOwnEvents ligado (R-001/WHS-05)", () => {
		expect(socketConfigOverrides(loggerFake).emitOwnEvents).toBe(true);
	});
});
