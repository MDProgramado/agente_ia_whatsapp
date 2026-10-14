/**
 * `criarEventoInbound` — carimbo do emissor (02-04 Task 1, CR-01).
 *
 * O Gate 0 (`deveMarcarPrimeiroContatoHumano`) precisa saber QUEM emitiu uma
 * mensagem `fromMe`. Num `fromMe` o `chatId` é o JID do lead (destinatário), não
 * o emissor — o emissor é o próprio socket dedicado. O runtime carimba
 * `senderPhoneE164` a partir do `sock.user.id` (obtido no boot via getter, para
 * ser reavaliado após reconexão) e o passador `canalSelfJid` injeta esse JID.
 *
 * Nota: `@whiskeysockets/baileys` NÃO pode ser importado fora de
 * `src/channel/baileys/**` (biome noRestrictedImports). Por isso a WAMessage
 * mínima é um literal tipado por `Parameters<...>[0]`, sem importar o pacote.
 */

import { describe, expect, it } from "vitest";
import { criarEventoInbound } from "../../src/channel/baileys/runtime.js";

type Msg = Parameters<typeof criarEventoInbound>[0];

const waMessage = (over: {
	readonly remoteJid: string;
	readonly fromMe?: boolean;
	readonly id?: string;
	readonly texto?: string;
}): Msg =>
	({
		key: {
			remoteJid: over.remoteJid,
			fromMe: over.fromMe ?? false,
			id: over.id ?? "m1",
		},
		message: { conversation: over.texto ?? "oi" },
		messageTimestamp: 1_700_000_000,
	}) as unknown as Msg;

describe("criarEventoInbound — carimbo do emissor (senderPhoneE164)", () => {
	it("behavior D-1: fromMe=true com canalSelfJid → carimba o E.164 do número dedicado", () => {
		const evt = criarEventoInbound(
			waMessage({ remoteJid: "5571988887777@s.whatsapp.net", fromMe: true }),
			"5511999999999:12@s.whatsapp.net",
		);
		expect(evt?.fromMe).toBe(true);
		expect(evt?.senderPhoneE164).toBe("+5511999999999");
	});

	it("behavior D-2: fromMe=true SEM canalSelfJid → senderPhoneE164 undefined (fail-closed)", () => {
		const evt = criarEventoInbound(
			waMessage({ remoteJid: "5571988887777@s.whatsapp.net", fromMe: true }),
		);
		expect(evt?.fromMe).toBe(true);
		expect(evt?.senderPhoneE164).toBeUndefined();
	});

	it("behavior D-3: fromMe=false → carimba o E.164 do remoteJid (o par)", () => {
		const evt = criarEventoInbound(
			waMessage({ remoteJid: "5571988887777@s.whatsapp.net", fromMe: false }),
		);
		expect(evt?.fromMe).toBe(false);
		expect(evt?.senderPhoneE164).toBe("+5571988887777");
	});
});
