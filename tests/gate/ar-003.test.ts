/**
 * AR-003 — agendar reunião sozinho (R-025).
 *
 * O bot NUNCA agenda; no máximo notifica o Admin. O guard é fail-closed de
 * propósito (D-11): não tenta distinguir "vou agendar" de "já agendei" — as duas
 * são a intenção proibida. O property test cobre o infinitivo, as conjugações
 * ("já agendei"), o verbo "marcar", a menção de reunião/chamada/call, o horário
 * e o dia da semana citado — todas as formas em que um agendamento vaza no texto.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../../src/domain/gate/evaluate-policy.js";
import { validInbound } from "./fixtures.js";

const TERMOS = [
	"vou agendar",
	"já agendei para amanhã",
	"ele agendou sozinho",
	"estou agendando agora",
	"vamos agendem isso",
	"posso marcar um café",
	"te mando o link da call",
	"fechar a chamada",
	"a reunião ficou para depois",
	"nosso horário é 9h",
	"quinta-feira funciona para você?",
] as const;

const comMoldura = fc
	.constantFrom(...TERMOS)
	.map((termo) => `Sobre o encontro, ${termo}.`);

describe("AR-003 — agendamento", () => {
	it("bloqueia qualquer texto com termo de agendamento", () => {
		fc.assert(
			fc.property(comMoldura, (texto) => {
				const decisao = evaluatePolicy(
					validInbound({ outbound: { text: texto } }),
				);
				expect(decisao).toMatchObject({
					action: "block",
					reason: "ar003_agendamento",
				});
			}),
			{ seed: 20260928, numRuns: 500 },
		);
	});

	it.each([
		"Posso te ligar amanhã às 14h?",
		"marquei terça às 14h",
		"vamos telefonar na quinta",
	])("bloqueia proposta de ligação com horário: %s", (texto) => {
		const decisao = evaluatePolicy(validInbound({ outbound: { text: texto } }));
		expect(decisao).toMatchObject({
			action: "block",
			reason: "ar003_agendamento",
		});
	});

	/**
	 * Auditoria 27/11b, item 5 — convite de agenda sem "agendar"/"reunião":
	 * "te chamo", ligação, hora solta ("15h") e "minutinhos".
	 */
	it.each([
		"Te chamo amanhã 15h pra gente alinhar?",
		"Bora uma ligação rápida?",
		"Tem 5 minutinhos amanhã de manhã?",
	])("bloqueia convite de agenda coloquial (auditoria 27/11b): %s", (texto) => {
		const decisao = evaluatePolicy(validInbound({ outbound: { text: texto } }));
		expect(decisao).toMatchObject({
			action: "block",
			reason: "ar003_agendamento",
		});
	});

	it("hora solta bloqueia mesmo como prazo de resposta (decisão do usuário, fail-closed)", () => {
		// "2h" não distingue prazo de compromisso de horário; o usuário aceitou o
		// falso positivo. Só o expediente "24h" é liberado (teste abaixo).
		const decisao = evaluatePolicy(
			validInbound({ outbound: { text: "Respondemos em até 2h." } }),
		);
		expect(decisao).toMatchObject({
			action: "block",
			reason: "ar003_agendamento",
		});
	});

	it("libera expediente genérico sem promessa de horário", () => {
		const decisao = evaluatePolicy(
			validInbound({ outbound: { text: "Atendimento 24h" } }),
		);
		expect(decisao.action).toBe("send");
	});

	it("o limite diário é AR-008, NÃO AR-003", () => {
		// Texto neutro, cota estourada: a decisão tem de ser a cota, nunca a
		// agendamento. Se este teste virasse `ar003`, o gate estaria atribuindo a
		// causa errada no relatório de conformidade.
		const decisao = evaluatePolicy(
			validInbound({
				outbound: { text: "Boa tarde! Posso ajudar em alguma coisa?" },
				context: { sentToday: 30 },
			}),
		);
		expect(decisao).toMatchObject({
			action: "block",
			reason: "ar008_limite_diario",
		});
	});
});
