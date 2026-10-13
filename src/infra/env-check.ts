/**
 * Verificação de ambiente no boot (R-031, WHS-05, T-01-02, Armadilha 5).
 *
 * Existe separado do `config/env.ts` porque o que ele pega o `zod` NÃO pega: o
 * `env.ts` valida a FORMA da config (URL parseável, E.164, faixa de horas), mas
 * não sabe nada sobre o mundo — se o `pg_dump` instalado tem o MESMO major do
 * servidor, se o `DATA_ROOT` virou um junction do OneDrive, se a janela faz
 * sentido (`start < end`). São falhas que só aparecem em runtime, e a pior delas
 * — o `pg_dump` de major diferente — só explode no RESTORE, dias depois, quando o
 * backup já era necessário.
 *
 * Contrato: `checkEnv()` devolve TODAS as verificações (aprovadas e reprovadas),
 * sem lançar. Quem chama decide o que fazer — o `index.ts` reprova o boot se
 * houver QUALQUER falha, com o log apontando o código nomeado e a correção.
 */
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { DATA_ROOT_DEFAULT } from "../config/env.js";

/**
 * Códigos nomeados. Cada um é uma causa acionável e é a string que se procura no
 * log/bilhete para achar a correção sem reler o boot inteiro.
 */
export const ENV_DATABASE_URL_MISSING = "ENV_DATABASE_URL_MISSING";
export const ENV_DATABASE_URL_INVALID = "ENV_DATABASE_URL_INVALID";
export const ENV_DATA_ROOT_ON_ONEDRIVE = "ENV_DATA_ROOT_ON_ONEDRIVE";
export const ENV_PHONE_E164_INVALID = "ENV_PHONE_E164_INVALID";
export const ENV_PGDUMP_NOT_FOUND = "ENV_PGDUMP_NOT_FOUND";
export const ENV_PGDUMP_VERSION_MISMATCH = "ENV_PGDUMP_VERSION_MISMATCH";
export const ENV_PG_UNREACHABLE = "ENV_PG_UNREACHABLE";
export const ENV_WINDOW_INVALID = "ENV_WINDOW_INVALID";

/** Pasta bin do cliente PostgreSQL quando `PGBIN` não está definido (18 = servidor). */
export const PGBIN_DEFAULT = String.raw`C:\Program Files\PostgreSQL\18\bin`;

/** Mesmo formato do `CHECK` do banco e do `env.ts` (WHS-05). */
const E164 = /^\+[1-9][0-9]{7,14}$/;

/** Mesmo protocolo duplo que o `env.ts` aceita (`postgres://` e `postgresql://`). */
const URL_POSTGRES = /^postgres(ql)?:\/\/\S+$/;

export type EnvCheck = {
	readonly code: string;
	readonly ok: boolean;
	readonly detail: string;
	/** Ação de correção — ausente quando `ok` é true. */
	readonly correction?: string;
};

/** Só as reprovadas. O boot aborta se isto não for vazio. */
export const falhasDeEnv = (checks: EnvCheck[]): EnvCheck[] =>
	checks.filter((c) => !c.ok);

/** Uma linha legível por falha: `[CODIGO] detalhe — correcao: ...`. */
export const formatarFalhaEnv = (c: EnvCheck): string =>
	`[${c.code}] ${c.detail}${c.correction ? ` — correcao: ${c.correction}` : ""}`;

/** Extrai o major (primeiro número antes do ponto) de `18.1` ou `pg_dump ... 18.1`. */
const majorDe = (versao: string): number | null => {
	const casa = /(\d+)\./.exec(versao);
	return casa ? Number(casa[1]) : null;
};

/**
 * OneDrive/junction/symlink: todos aparecem para o Node como reparse point, e o
 * libuv reporta junction como link. Mesma rede do `env.ts` — a checagem do nome
 * cobre o caso em que o OneDrive reparseia a pasta PAI.
 */
const isInsideOneDrive = (target: string): boolean =>
	target
		.split(/[\\/]/)
		.some((segmento) => segmento.toLowerCase().startsWith("onedrive"));

const caminhoPgDump = (): string =>
	join(process.env.PGBIN ?? PGBIN_DEFAULT, "pg_dump.exe");

/**
 * Compara o major do `pg_dump` com o do servidor. Abre uma conexão EFÊMERA e
 * própria — o check roda antes do pool da aplicação existir, e um probe que não
 * fecha vazaria uma conexão no boot.
 */
const checarPgDump = async (url: string): Promise<EnvCheck[]> => {
	const bin = caminhoPgDump();
	const dump = spawnSync(bin, ["--version"], { encoding: "utf8" });

	if (dump.error || dump.status !== 0) {
		const motivo = dump.error
			? dump.error.message
			: `saiu com codigo ${dump.status}`;
		return [
			{
				code: ENV_PGDUMP_NOT_FOUND,
				ok: false,
				detail: `nao consegui executar ${bin}: ${motivo}`,
				correction: `instale o cliente PostgreSQL do MESMO major do servidor e aponte PGBIN para a pasta bin (padrao ${PGBIN_DEFAULT})`,
			},
		];
	}
	const majorDump = majorDe(`${dump.stdout}${dump.stderr}`);

	const cliente = new Client({ connectionString: url });
	let majorServidor: number | null = null;
	try {
		await cliente.connect();
		const resultado = await cliente.query("show server_version");
		const linha = resultado.rows[0] as Record<string, unknown> | undefined;
		majorServidor = majorDe(String(linha?.server_version ?? ""));
	} catch (erro) {
		return [
			{
				code: ENV_PG_UNREACHABLE,
				ok: false,
				detail: `nao consegui ler SHOW server_version: ${erro instanceof Error ? erro.message : String(erro)}`,
				correction:
					"verifique se o PostgreSQL local esta no ar e se DATABASE_URL aponta para ele",
			},
		];
	} finally {
		await cliente.end().catch(() => {});
	}

	if (majorDump === null || majorServidor === null) {
		return [
			{
				code: ENV_PGDUMP_VERSION_MISMATCH,
				ok: false,
				detail: `nao consegui determinar o major (pg_dump=${majorDump}, server_version=${majorServidor})`,
				correction: `confirme a instalacao do cliente em ${PGBIN_DEFAULT}`,
			},
		];
	}

	if (majorDump !== majorServidor) {
		return [
			{
				code: ENV_PGDUMP_VERSION_MISMATCH,
				ok: false,
				detail: `pg_dump e major ${majorDump} mas SHOW server_version e major ${majorServidor}`,
				correction: `use o pg_dump da MESMA instalacao do servidor (PGBIN=${PGBIN_DEFAULT}); um dump de major diferente falha no restore, dias depois`,
			},
		];
	}

	return [
		{
			code: "ENV_PGDUMP_OK",
			ok: true,
			detail: `pg_dump major ${majorDump} == server_version major ${majorServidor}`,
		},
	];
};

export async function checkEnv(): Promise<EnvCheck[]> {
	const checks: EnvCheck[] = [];

	// 1. DATABASE_URL presente e parseável.
	const url = process.env.DATABASE_URL ?? "";
	let urlOk = false;
	if (url === "") {
		checks.push({
			code: ENV_DATABASE_URL_MISSING,
			ok: false,
			detail: "DATABASE_URL nao definida",
			correction:
				"defina DATABASE_URL=postgres://usuario:senha@localhost:5432/whatsapp_prospect no .env",
		});
	} else if (!URL_POSTGRES.test(url)) {
		checks.push({
			code: ENV_DATABASE_URL_INVALID,
			ok: false,
			detail: "DATABASE_URL nao comeca com postgres:// nem postgresql://",
			correction: "use o formato postgres://usuario:senha@host:porta/base",
		});
	} else {
		urlOk = true;
		checks.push({
			code: "ENV_DATABASE_URL_OK",
			ok: true,
			detail: "DATABASE_URL presente e parseavel",
		});
	}

	// 2. CHANNEL_PHONE_E164 no formato E.164.
	const telefone = process.env.CHANNEL_PHONE_E164 ?? "";
	if (!E164.test(telefone)) {
		checks.push({
			code: ENV_PHONE_E164_INVALID,
			ok: false,
			detail: "CHANNEL_PHONE_E164 fora do formato E.164",
			correction: "use +55DDDNUMERO, sem espacos (ex.: +5511999999999)",
		});
	} else {
		checks.push({
			code: "ENV_PHONE_E164_OK",
			ok: true,
			detail: "CHANNEL_PHONE_E164 no formato E.164",
		});
	}

	// 3. DATA_ROOT: se já existe, NÃO pode ser link/junction/OneDrive. A ausência
	//    não é falha aqui — `ensureDataDirs()` cria em seguida; o que não pode é o
	//    caminho já existente ser um reparse point (a pasta auth É a sessão do
	//    WhatsApp e não pode ser sincronizada — COMP-05/D-01).
	const raiz = process.env.DATA_ROOT ?? DATA_ROOT_DEFAULT;
	let existe = false;
	let isLink = false;
	try {
		const info = lstatSync(raiz);
		existe = true;
		isLink = info.isSymbolicLink();
	} catch {
		existe = false;
	}
	if (existe && (isLink || isInsideOneDrive(raiz))) {
		checks.push({
			code: ENV_DATA_ROOT_ON_ONEDRIVE,
			ok: false,
			detail: `DATA_ROOT="${raiz}" existe e e um link/junction ou esta dentro do OneDrive`,
			correction:
				"configure DATA_ROOT fora do OneDrive (padrao C:\\whatsapp_prospecao); sincronizar a pasta auth faz o numero ser lido como dispositivo novo",
		});
	} else {
		checks.push({
			code: "ENV_DATA_ROOT_OK",
			ok: true,
			detail: existe
				? "DATA_ROOT existe e nao e link"
				: "DATA_ROOT ainda nao existe; sera criado por ensureDataDirs",
		});
	}

	// 4. Janela operacional: start < end. Fora dessa ordem a janela é vazia e o
	//    gate de envio (R-006) bloqueia tudo sem dizer por quê.
	const inicio = Number(process.env.WINDOW_START_HOUR ?? "7");
	const fim = Number(process.env.WINDOW_END_HOUR ?? "17");
	if (!(inicio < fim)) {
		checks.push({
			code: ENV_WINDOW_INVALID,
			ok: false,
			detail: `WINDOW_START_HOUR (${inicio}) >= WINDOW_END_HOUR (${fim})`,
			correction:
				"ajuste para uma janela nao vazia (padrao 7 -> 17, dias uteis)",
		});
	} else {
		checks.push({
			code: "ENV_WINDOW_OK",
			ok: true,
			detail: `janela ${inicio}h -> ${fim}h`,
		});
	}

	// 5. pg_dump do mesmo major do servidor (Armadilha 5). Só faz sentido se a URL
	//    é válida — sem ela não há servidor para comparar.
	if (urlOk) {
		checks.push(...(await checarPgDump(url)));
	}

	return checks;
}
