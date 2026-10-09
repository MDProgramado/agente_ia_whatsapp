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
 *    não é engolir; seguir com `state` vazio seria.
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
	//     não veio como registrado = auth corrompido, pela metade, ou de outra
	//     conta. Abortar. Degradar para sessão vazia aqui é o vetor de ban.
	const sessaoRegistrada = carregado.state.creds.registered === true;
	if (pastaExistiaAntes && jsonsAntes.length > 0 && !sessaoRegistrada) {
		throw new AuthCorruptedError(
			`${PASTA_AUTH} tem ${jsonsAntes.length} arquivo(s) json, mas as credenciais ` +
				"carregaram sem registro (registered !== true) — restaure de um backup de auth " +
				"e nao pare por cima",
		);
	}

	// (e) `restoreRequired` cobre o único caminho restante: pasta nova ou vazia =
	//     pareamento necessário, decisão do Admin no celular.
	const restoreRequired = !sessaoRegistrada;
	log.info(
		{
			step: "session",
			pasta_existia: pastaExistiaAntes,
			arquivos_json: jsonsAntes.length,
			restore_required: restoreRequired,
		},
		"sessao do Baileys carregada",
	);

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
 * - `browser: Browsers.windows("Chrome")` (T2 do 01-03-DIAG): o default do pacote é
 *   `Browsers.macOS("Chrome")`, que anuncia `companion_platform_display` como
 *   `"Chrome (Mac OS)"` (`Socket/socket.js:640-643`). Em Windows, anunciar o SO
 *   hospedeiro é o valor que o servidor espera no vínculo companion. O
 *   `companion_platform_id` (getCompanionWebClientType) segue CHROME (1) — só o
 *   display muda; a trava de pareamento é o display.
 * - nível do logger = `BAILEYS_LOG_LEVEL` (T3 do 01-03-DIAG): as falhas internas do
 *   vendor (`companion_reg_refresh`, 463, recusa de `link_code_companion_reg`) só
 *   saem neste logger. Com `debug`/`trace`, uma falha de pareamento antes muda de
 *   "silêncio total no `app.log`" para uma trilha auditável.
 */
export const socketConfigOverrides = (
	logger: SocketConfig["logger"],
): Partial<SocketConfig> => {
	logger.level = env.BAILEYS_LOG_LEVEL;
	return {
		emitOwnEvents: true,
		browser: Browsers.windows("Chrome"),
		logger,
		...({
			messages: { ack: { auto: "all" } },
		} as unknown as Partial<SocketConfig>),
	};
};
