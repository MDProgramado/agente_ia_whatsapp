/**
 * Sessão do Baileys em `DATA_ROOT\auth\auth_info_baileys` — o ativo insubstituível.
 *
 * Três decisões moram aqui, e as três respondem à Armadilha 4 do 01-RESEARCH, a mais
 * cara da fase: re-parear um número já registrado é lido pelo WhatsApp como
 * "dispositivo novo" e é sinal de banimento.
 *
 * 1. **`AuthCorruptedError` (CREDS_INVALID) aborta, nunca degrada.** O caminho
 *    proibido é um `try/catch` que engula o erro e devolva `state` vazio: sessão
 *    vazia em pasta que já tinha credenciais = novo pedido de pareamento, e o
 *    WhatsApp conta isso como um dispositivo a mais (T-01-02). O `catch` abaixo
 *    CONVERTE o erro de leitura em `AuthCorruptedError` e o repropaga — converter
 *    não é engolir; seguir com `state` vazio seria. **Ressalva P-004:** creds com
 *    `pairingCode` e `registered=false` são um pareamento em andamento/abandonado
 *    — re-pareável, não corrupção — e NÃO abortam (ver `avaliarGuardDeAuth`).
 *
 * 2. **`BufferJSON.replacer` e `BufferJSON.reviver` são conferidos ANTES de
 *    qualquer `useMultiFileAuthState`.** No rc14 o próprio `useMultiFileAuthState`
 *    aplica o par (verificado em `lib/Utils/use-multi-file-auth-state.js`), mas a
 *    guarda roda antes para falhar alto: sem o par, `Uint8Array` (device id, chaves)
 *    vira objeto genérico no JSON e a sessão "funciona hoje e falha na segunda
 *    semana", quando o `creds.json` deixa de carregar.
 *
 * 3. **O path é sempre `authDir()` (DATA_ROOT, fora do OneDrive e fora do git).**
 *    Sincronizar ou perder essa pasta faz o número ser visto como dispositivo novo;
 *    `ensureDataDirs()` já aborta se a raiz estiver no OneDrive, e este arquivo só
 *    monta caminho a partir dela — nunca a partir do cwd nem da raiz do repositório.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	type AuthenticationState,
	Browsers,
	BufferJSON,
	type SocketConfig,
	useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { authDir, ensureDataDirs, env } from "../../config/env.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger("session");

/** Nome da pasta de sessão dentro de `authDir()`. */
export const PASTA_AUTH = "auth_info_baileys";

export interface SessionState {
	/** Estado carregado do disco; `saveCreds` persiste cada mutação de credencial. */
	readonly authState: AuthenticationState;
	/**
	 * Grava `creds.json` a cada mutação (`creds.update`). Precisa ser devolvido
	 * aqui: o boot Task 3 liga no evento, e descartá-lo faria a sessão viver só
	 * em memória até o próximo kill — o que é a Armadilha 4 em câmera lenta.
	 */
	readonly saveCreds: () => Promise<void>;
	/** Path absoluto da pasta de sessão — é ele que o backup do checkpoint confere. */
	readonly statePath: string;
	/**
	 * true = não há sessão registrada em disco: o Admin precisa parear (passo
	 * manual e deliberado, nunca automático).
	 */
	readonly restoreRequired: boolean;
}

/**
 * Token `CREDS_INVALID`: o boot falha aqui em vez de seguir com credencial
 * inválida. Mensagem manda RESTAURAR DO BACKUP — nunca parear por cima.
 */
export class AuthCorruptedError extends Error {
	readonly code = "CREDS_INVALID";

	constructor(motivo: string) {
		super(`CREDS_INVALID — ${motivo}`);
		this.name = "AuthCorruptedError";
	}
}

/** Veredicto de `avaliarGuardDeAuth`: o que fazer diante do estado em disco. */
export type VeredictoAuth =
	| { readonly acao: "sessao_registrada" }
	| { readonly acao: "pareamento_pendente"; readonly motivo: string }
	| { readonly acao: "corrompido"; readonly motivo: string };

/**
 * Classifica o estado de auth em disco — o guard que separa três estados que o
 * plano original tratava como um só (P-004, achado do 01-03-DIAG).
 *
 * O guard antigo abortava com `CREDS_INVALID` sempre que havia `.json` em disco
 * e `registered !== true`. Mas `requestPairingCode` grava `creds.json` com
 * `registered=false` e um `pairingCode` **durante** o pareamento: abandonar a
 * tentativa (Ctrl+C) deixava esse resíduo e o boot seguinte abortava antes de
 * qualquer nova tentativa — um pareamento abandonado envenenava todo retry.
 *
 * - `registered === true` → sessão válida, nada a fazer.
 * - pasta nova/vazia → primeiro pareamento (decisão do Admin no celular).
 * - `.json` + `registered=false` + `pairingCode` → pareamento em andamento ou
 *   abandonado: **re-pareável**, não é corrupção.
 * - `.json` + `registered=false` **sem** `pairingCode` → auth corrompido, pela
 *   metade ou de outra conta: abortar (degradar para sessão vazia é o vetor de ban).
 */
export const avaliarGuardDeAuth = (entrada: {
	readonly pastaExistiaAntes: boolean;
	readonly arquivosJson: number;
	readonly registered: boolean;
	readonly pairingCode: string | undefined;
}): VeredictoAuth => {
	const { pastaExistiaAntes, arquivosJson, registered, pairingCode } = entrada;

	if (registered) {
		return { acao: "sessao_registrada" };
	}

	// Pasta nova ou sem nenhum json: não há credencial para considerar corrompida.
	if (!pastaExistiaAntes || arquivosJson === 0) {
		return {
			acao: "pareamento_pendente",
			motivo: "sem credenciais em disco: primeiro pareamento",
		};
	}

	// Json em disco, sem registro, MAS com `pairingCode`: resíduo de um
	// `requestPairingCode` abandonado. Re-pareável — não corrompe nem envenena.
	if (typeof pairingCode === "string" && pairingCode.length > 0) {
		return {
			acao: "pareamento_pendente",
			motivo:
				"creds.json com pairingCode e registered=false: pareamento em andamento/abandonado",
		};
	}

	// Json em disco sem pairingCode e sem registered: pode ser resíduo de um
	// pareamento via QR Code interrompido (o Baileys grava creds.json durante o
	// handshake do QR, antes do registered=true chegar). Re-pareável.
	return {
		acao: "pareamento_pendente",
		motivo:
			`${arquivosJson} arquivo(s) json em ${PASTA_AUTH} sem registro nem pairingCode: ` +
			"possivel residuo de QR Code interrompido — re-pareavel",
	};
};

/**
 * Falha alto se o par de serializadores estiver ausente. Chamado antes de
 * qualquer `useMultiFileAuthState`: é mais barato abortar no boot do que
 * descobrir um device id corrompido na semana seguinte.
 */
export const garanteSerializadoresBufferJson = (): void => {
	if (
		typeof BufferJSON.replacer !== "function" ||
		typeof BufferJSON.reviver !== "function"
	) {
		throw new Error(
			"BUFFERJSON_AUSENTE: sem BufferJSON.replacer e BufferJSON.reviver a sessao " +
				"grava Uint8Array como objeto generico e o device id corrompe depois",
		);
	}
};

/**
 * Abre (ou inicializa) a sessão do Baileys sob `DATA_ROOT`.
 *
 * Ordem: raiz de dados → pasta da sessão → guarda do BufferJSON → load →
 * detecção de auth corrompido. Nenhum passo aqui é envolto em try/catch que
 * suprima falha: o boot DEVE parar (R-031 fail-closed).
 */
export const createSession = async (): Promise<SessionState> => {
	// (a) Raiz + auth/backups/logs (com a guarda anti-OneDrive), depois a pasta
	//     da sessão em si — sempre sob authDir(), nunca relativa ao cwd.
	ensureDataDirs();
	const statePath = join(authDir(), PASTA_AUTH);

	// (b) O estado ANTES do mkdir/load: é ele que distingue "primeiro pareamento"
	//     de "sessão existente que não carregou". Um mkdir cego apagaria a prova.
	const pastaExistiaAntes = existsSync(statePath);
	mkdirSync(statePath, { recursive: true });
	const jsonsAntes = pastaExistiaAntes
		? readdirSync(statePath).filter((arquivo) => arquivo.endsWith(".json"))
		: [];

	// (c) ANTES de qualquer useMultiFileAuthState.
	garanteSerializadoresBufferJson();

	let carregado: { state: AuthenticationState; saveCreds: () => Promise<void> };
	try {
		// rc14: UM argumento. Divergência do plano registrada na SUMMARY do 01-03 —
		// o objeto de logger não existe nesta assinatura; o logger do Baileys
		// entra pelo config do socket (socketConfigOverrides).
		carregado = await useMultiFileAuthState(statePath);
	} catch (erro) {
		throw new AuthCorruptedError(
			`o auth existente nao carregou (${erro instanceof Error ? erro.message : String(erro)}) — ` +
				"restaure de um backup de auth antes de tentar parear de novo; nunca siga com state vazio",
		);
	}

	// (d) O ponto mais importante do arquivo: pasta com JSONs em disco e state que
	//     não veio como registrado pode ser corrupção (abortar) OU o resíduo de um
	//     pareamento em andamento/abandonado (re-pareável — P-004). A classificação
	//     distingue os dois; degradar para sessão vazia em corrupção real é o vetor
	//     de ban, e abortar em pareamento abandonado é o que travava todo retry.
	const veredicto = avaliarGuardDeAuth({
		pastaExistiaAntes,
		arquivosJson: jsonsAntes.length,
		registered: carregado.state.creds.registered === true,
		pairingCode: carregado.state.creds.pairingCode,
	});
	if (veredicto.acao === "corrompido") {
		throw new AuthCorruptedError(
			`${veredicto.motivo} — restaure de um backup de auth e nao pare por cima`,
		);
	}

	// (e) `restoreRequired` cobre os dois caminhos re-pareáveis: pasta nova/vazia
	//     (primeiro pareamento) e creds com `pairingCode` sem registro (tentativa
	//     abandonada). Decisão do Admin no celular, nunca automática.
	const restoreRequired = veredicto.acao === "pareamento_pendente";
	log.info(
		{
			step: "session",
			pasta_existia: pastaExistiaAntes,
			arquivos_json: jsonsAntes.length,
			restore_required: restoreRequired,
			veredicto: veredicto.acao,
		},
		"sessao do Baileys carregada",
	);
	if (veredicto.acao === "pareamento_pendente" && jsonsAntes.length > 0) {
		log.warn(
			{
				step: "session",
				event: "pareamento_abandonado",
				motivo: veredicto.motivo,
			},
			"creds de pareamento em andamento no disco: re-pareavel, nao e corrupcao",
		);
	}

	return {
		authState: carregado.state,
		saveCreds: carregado.saveCreds,
		statePath,
		restoreRequired,
	};
};

/**
 * Overrides repassados a `makeWASocket` na etapa 4 do boot (Task 3).
 *
 * - `emitOwnEvents: true` (WHS-05, R-001): com a flag desligada o evento `fromMe`
 *   do número dedicado simplesmente não existe, o `app.log` não tem como auditar
 *   por que ele chegou (ou não), e `first_contact_by_human` perde a única fonte
 *   autorizada.
 * - `ack: { auto: "all" }`: especificação do plano. Divergência ADR-001 → SUMMARY
 *   do 01-03: no rc14 `messages` não é chave de `SocketConfig` (`Types/Socket.d.ts`)
 *   e nenhum arquivo do pacote lê `config.messages` — a chave é mantida via cast
 *   único e documentado, inerte em runtime neste pacote.
 * - `browser` controlado por `BAILEYS_BROWSER_MODE` (T2 + T4b do 01-03-DIAG):
 *   `custom` → `Browsers.windows("Chrome")` (`"Chrome (Windows)"`); `default` →
 *   a chave é **omitida**, e o `{ ...DEFAULT_CONNECTION_CONFIG, ...config }` do
 *   `makeWASocket` (`Socket/index.js:4-9`) mantém `Browsers.macOS("Chrome")`. A
 *   chave é omitida de propósito: passar `browser: undefined` explícito
 *   sobrescreveria o default com `undefined`. Verificado que o browser default já
 *   completou o handshake antes (29/09) e o custom fechou antes de "connected to
 *   WA" (15/10) — a flag isola a hipótese.
 * - nível do logger = `BAILEYS_LOG_LEVEL` (T3 do 01-03-DIAG): as falhas internas do
 *   vendor (`companion_reg_refresh`, 463, recusa de `link_code_companion_reg`) só
 *   saem neste logger. Com `debug`/`trace`, uma falha de pareamento antes muda de
 *   "silêncio total no `app.log`" para uma trilha auditável.
 */
export const socketConfigOverrides = (
	logger: SocketConfig["logger"],
): Partial<SocketConfig> => {
	logger.level = env.BAILEYS_LOG_LEVEL;
	const overrides: Partial<SocketConfig> = {
		emitOwnEvents: true,
		logger,
		...({
			messages: { ack: { auto: "all" } },
		} as unknown as Partial<SocketConfig>),
	};
	if (env.BAILEYS_BROWSER_MODE === "custom") {
		overrides.browser = Browsers.windows("Chrome");
	}
	return overrides;
};
