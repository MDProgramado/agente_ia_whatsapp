/**
 * Normalização de JID/LID sem nunca transformar identificador de rede em chave.
 *
 * Três colunas separadas em `leads`: `phone_number` (E.164, estável, UNIQUE),
 * `wa_jid` (JID PN, reescrito pela migração PN→LID) e `lid`. A regra de ouro
 * (T-01-15): **`remoteJid` nunca é PK nem alvo de FK** — a migração de identidade
 * reescreve esse valor e uma FK por ele quebraria junto. `phone_number` é a chave;
 * este módulo só traduz formatos.
 *
 * LID (Armadilha 6): `…@lid` NÃO contém o número de telefone. Ninguém aqui inventa
 * E.164 a partir do LID — ou o `lidMapping` store resolve, ou o fluxo para com log
 * `jid_unresolved`. Chutar o número mandaria mensagem para a pessoa errada.
 */
import {
	isLidUser,
	jidDecode,
	jidNormalizedUser,
	type WASocket,
} from "@whiskeysockets/baileys";
import { childLogger } from "../../infra/logger.js";

const log = childLogger("jid-resolver");

/** Mesmo formato do CHECK `leads_phone_number_check` (0000_initial.sql). */
export const E164_REGEX = /^\+[1-9][0-9]{7,14}$/;

export interface JidNormalizado {
	/** E.164 (`+55…`) quando derivável; `null` para LID/grupo/servidor desconhecido. */
	readonly e164: string | null;
	/** JID normalizado (sem device). Nunca usado como chave — só como referência. */
	readonly jid: string;
	/** O LID, quando o input era um LID. Ausente (`null`) quando não há LID. */
	readonly lid: string | null;
}

/**
 * Normaliza um JID cru. Síncrona e sem rede: só formatos.
 *
 * - `…@s.whatsapp.net` → o número é o prefixo → `e164` preenchido;
 * - `…@lid` → `e164: null` (o número não está aqui) e `lid` preenchido — quem
 *   precisar do número chama `resolveE164`, que consulta o `lidMapping` store;
 * - grupo/status/outros → `e164: null`, `lid: null`.
 *
 * O log `jid_unresolved` fica para o ponto onde a resolução REALMENTE falha
 * (`resolveE164`/inbound handler) — aqui a ausência de número é formato, não
 * erro, e logar em todo evento de grupo seria ruído.
 */
export const normalizeJid = (rawJid: string): JidNormalizado => {
	const jid = jidNormalizedUser(rawJid);
	const decodificado = jidDecode(jid);
	if (!decodificado) return { e164: null, jid, lid: null };

	if (isLidUser(jid)) {
		// NUNCA derive `+…` daqui: LID não é telefone.
		return { e164: null, jid, lid: jid };
	}
	if (decodificado.server !== "s.whatsapp.net") {
		return { e164: null, jid, lid: null };
	}
	const candidato = `+${decodificado.user}`;
	return { e164: E164_REGEX.test(candidato) ? candidato : null, jid, lid: null };
};

/**
 * JID de destino derivado de `phone_number`, a coluna estável.
 *
 * Nem `wa_jid` nem `lid` servem de alvo: os dois são identificadores que a
 * migração PN→LID reescreve (T-01-15). `phone_number` não muda, é o que o gate
 * audita, e o CHECK do banco garante o formato.
 */
export const jidDeEnvio = (phoneE164: string): string =>
	`${phoneE164.replace(/^\+/, "")}@s.whatsapp.net`;

/**
 * Resolve `jidOrPhone` para E.164: aceita E.164 cru, deriva de JID PN e, para
 * LID, pergunta ao `lidMapping` store do próprio socket (cache LRU de 7 dias no
 * rc14). O `onWhatsApp` do rc14 **não aceita LID** (descarta com warn no fonte),
 * então não há validação por aqui — a validação é `validateWaId` em capabilities.
 *
 * Falhou resolver → log `jid_unresolved` e `null`. O chamador (inbound handler)
 * PARA; inventar um número a partir do LID é a forma mais silenciosa de mandar
 * mensagem para a pessoa errada.
 */
export const resolveE164 = async (
	sock: Pick<WASocket, "signalRepository">,
	jidOrPhone: string,
): Promise<string | null> => {
	if (E164_REGEX.test(jidOrPhone)) return jidOrPhone;

	const normalizado = normalizeJid(jidOrPhone);
	if (normalizado.e164) return normalizado.e164;

	if (normalizado.lid) {
		try {
			// `getPNForLID` devolve um JID PN (`user:device@s.whatsapp.net`),
			// não um número cru — por isso passa pelo normalizeJid de volta.
			const pnJid = await sock.signalRepository.lidMapping.getPNForLID(
				normalizado.lid,
			);
			if (pnJid) {
				const pn = normalizeJid(pnJid);
				if (pn.e164) return pn.e164;
			}
		} catch (erro) {
			log.warn(
				{ event: "jid_unresolved", motivo: "lid_mapping_falhou" },
				`lidMapping falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
			);
		}
	}

	log.warn(
		{ event: "jid_unresolved", jid: normalizado.jid },
		"nao deu para derivar E.164 — o fluxo para aqui; nunca chute o numero",
	);
	return null;
};
