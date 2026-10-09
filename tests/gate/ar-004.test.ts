/**
 * AR-004 — mídia de saída (R-037).
 *
 * Duas portas para mídia: a **estrutural** (um `part` que não é `text` nem
 * `link`) e a **de conteúdo** (o texto nomeia um arquivo, ou a URL termina em
 * extensão de mídia). O link de convite (`wa.me`, `chat.whatsapp.com`) é o
 * inverso do risco: um guard "seguro demais" que o bloqueasse quebraria R-045
 * (texto e links são permitidos) sem ninguém notar. Este teste o prende como
 * regressão de primeira classe (CONV-14).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../src/domain/gate/evaluate-policy.js";
import type { OutboundPart } from "../../src/domain/ports/ChannelPort.js";
import { TEXTO_NEUTRO, validInbound } from "./fixtures.js";

const EXTENSOES = [
	"pdf",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"mp3",
	"ogg",
	"m4a",
	"mp4",
	"mov",
	"docx",
	"xlsx",
	"pptx",
	"zip",
] as const;

const linkDeMidia = fc
	.constantFrom(...EXTENSOES)
	.map((ext): readonly OutboundPart[] => [
		{ kind: "link", href: `https://exemplo.com.br/arquivo.${ext}` },
	]);

describe("AR-004 — mídia de saída", () => {
	it("bloqueia um part que não é text nem link (rede de segurança estrutural)", () => {
		const partes = [{ kind: "image" }] as unknown as readonly OutboundPart[];
		const decisao = evaluatePolicy(
			validInbound({ outbound: { text: TEXTO_NEUTRO, parts: partes } }),
		);
		expect(decisao).toMatchObject({
			action: "block",
			reason: "ar004_midia_saida",
		});
	});

	it("bloqueia link cuja URL termina em extensão de mídia, mesmo com texto limpo", () => {
		fc.assert(
			fc.property(linkDeMidia, (parts) => {
				const decisao = evaluatePolicy(
					validInbound({ outbound: { text: TEXTO_NEUTRO, parts } }),
				);
				expect(decisao).toMatchObject({
					action: "block",
					reason: "ar004_midia_saida",
				});
			}),
			{ seed: 20260928, numRuns: 500 },
		);
	});

	it("bloqueia texto que nomeia mídia", () => {
		const decisao = evaluatePolicy(
			validInbound({ outbound: { text: "te mando o pdf agora" } }),
		);
		expect(decisao).toMatchObject({
			action: "block",
			reason: "ar004_midia_saida",
		});
	});

	it("CONV-14: link de wa.me NÃO bloqueia", () => {
		const decisao = evaluatePolicy(
			validInbound({
				outbound: {
					text: "Fala comigo por aqui",
					parts: [{ kind: "link", href: "https://wa.me/5571989211292" }],
				},
			}),
		);
		expect(decisao.action).toBe("send");
	});

	it("CONV-14: link de chat.whatsapp.com NÃO bloqueia", () => {
		const decisao = evaluatePolicy(
			validInbound({
				outbound: {
					text: "Entra no nosso grupo de casos",
					parts: [
						{
							kind: "link",
							href: "https://chat.whatsapp.com/ABCDEF123456",
						},
					],
				},
			}),
		);
		expect(decisao.action).toBe("send");
	});

	it("link comum com caminho e query string NÃO bloqueia", () => {
		const decisao = evaluatePolicy(
			validInbound({
				outbound: {
					text: "Dá uma olhada no nosso site",
					parts: [
						{
							kind: "link",
							href: "https://exemplo.com.br/cases/automacao?id=7",
						},
					],
				},
			}),
		);
		expect(decisao.action).toBe("send");
	});
});
