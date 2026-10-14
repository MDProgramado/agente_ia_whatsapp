/**
 * Boot da aplicação — ordem inegociável: config → banco (com migrate) → logs →
 * canal → motor.
 *
 * Config antes de tudo porque o logger abre arquivo sob `DATA_ROOT`, e `DATA_ROOT`
 * vem da config. Banco antes do canal porque o canal é quem decide o que existe
 * para conversar; um socket conectado a um schema incompleto é pior que nenhum socket.
 *
 * O boot segue config → banco (com migrate) → logs → canal → motor. O "motor"
 * desta fase é o monitor de saúde e o relatório diário do piloto; o
 * dispatcher/LLM entram numa fase seguinte.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { BarramentoEventos } from "./application/event-bus.js";
import { processInboundFromMe } from "./application/inbound-handler.js";
import { readCapabilities } from "./channel/baileys/capabilities.js";
import { normalizeJid } from "./channel/baileys/jid-resolver.js";
import {
	abrirSocketDoCanal,
	criarHandlersDoCanal,
	type WASocket,
} from "./channel/baileys/runtime.js";
import { createSession } from "./channel/baileys/session.js";
import { translateDisconnect } from "./channel/baileys/signals.js";
import { ensureDataDirs, env, logsDir } from "./config/env.js";
import { closeDb, openDb } from "./infra/db/client.js";
import { dailyReport } from "./infra/db/queries/daily-report.js";
import { checkEnv, falhasDeEnv, formatarFalhaEnv } from "./infra/env-check.js";
import {
	type Achado,
	type BaileysState,
	startHealthMonitor,
} from "./infra/health-monitor.js";
import { childLogger, flushLogSync } from "./infra/logger.js";
import { criarNotifier } from "./infra/notifier.js";

/**
 * `BOOT_CHECK_ONLY=1` vem do `launch.cmd check`. Roda o MESMO boot, passo por passo
 * — o que valida o stack inteiro — e encerra em vez de ficar vivo. Sem isso, um
 * launcher que mantém processo nunca devolveria exit 0 e o gate ficaria pendurado.
 */
const BOOT_CHECK_ONLY = process.env.BOOT_CHECK_ONLY === "1";

/**
 * Handle que segura o processo vivo no boot de produção. Vive no escopo do módulo
 * para que `encerra` possa soltá-lo — um timer ref'd que ninguém limpa é justamente
 * o que impediria o processo de sair no Ctrl+C.
 */
let keepAlive: NodeJS.Timeout | undefined;

/**
 * Socket do canal, no escopo do módulo para que `encerra` possa fechá-lo ANTES do
 * pool: um kill abrupto corrompe o `useMultiFileAuthState`, e um auth corrompido é
 * lido pelo WhatsApp como dispositivo novo (Armadilha 4, T-01-02).
 */
let canalSock: WASocket | undefined;

/**
 * Estado do socket no último `connection.update`, lido pelo monitor de saúde.
 * Começa em `unknown` — não em `connecting` — porque um monitor que trata
 * `connecting` como queda dispararia um `critical` falso no primeiro tick, antes
 * da conexão abrir; ruído assim treina o Admin a ignorar o monitor (T-01-28).
 */
let canalEstado: BaileysState = "unknown";

/** Handles do "motor" (monitor de saúde + cron do relatório), parados no encerra. */
let monitorSaude: ReturnType<typeof startHealthMonitor> | undefined;
let cronRelatorio: Cron | undefined;

/**
 * Contagem com `::int`: o driver devolve `count(*)` como `bigint`, que serializa
 * como string (`"0"`) e o campo sairia `"leads_total": "0"` no log — quebrar o gate
 * que exige inteiro e, pior, esconder a diferença entre 0 e "sem lead nenhum".
 */
const countOf = async (
	db: Awaited<ReturnType<typeof openDb>>["db"],
	sqlText: string,
) => {
	const result = await db.execute(sql.raw(sqlText));
	return Number(result.rows[0]?.n ?? 0);
};

const main = async (): Promise<void> => {
	// (a) env-check antes de QUALQUER conexão. `checkEnv` compara o major do
	//     pg_dump com o do servidor e barra DATA_ROOT em link/OneDrive, E.164 fora
	//     do padrão e janela vazia. Fail-closed: uma única falha aborta o boot, com
	//     o código nomeado apontando a correção.
	const verificacoes = await checkEnv();
	const falhasEnv = falhasDeEnv(verificacoes);
	if (falhasEnv.length > 0) {
		for (const falha of falhasEnv) {
			console.error(`[boot] ${formatarFalhaEnv(falha)}`);
		}
		throw new Error(
			`env-check reprovou ${falhasEnv.length} verificacao(oes): ${falhasEnv
				.map((falha) => falha.code)
				.join(", ")}`,
		);
	}

	// (b) DATA_ROOT existe, tem auth/backups/logs e NÃO está no OneDrive.
	//     Sai com DATA_ROOT_ON_ONEDRIVE se estiver: a pasta auth É a sessão do WhatsApp.
	ensureDataDirs();

	// (c) Logger com child por módulo.
	const log = childLogger("boot");

	// (d) Banco + `migrate()` (R-031). Falha de migration aborta o boot aqui.
	const conn = await openDb(env.DATABASE_URL);
	log.info(
		{ step: "db_open", pool_max: 5 },
		"banco aberto e migrations aplicadas",
	);

	// (e) Escrita real seguida de leitura real (WHS-05).
	//     O `ON CONFLICT DO NOTHING` é o que torna o boot idempotente: rodar duas
	//     vezes deixa exatamente uma linha, e é a segunda execução que prova isso.
	await conn.db.execute(
		sql`insert into channel_accounts (phone_e164) values (${env.CHANNEL_PHONE_E164}) on conflict do nothing`,
	);

	const conta = await conn.db.execute(
		sql`select phone_e164 from channel_accounts`,
	);
	const linhas = conta.rows as { phone_e164: string }[];
	const contaLida = linhas.at(0);

	if (linhas.length !== 1 || !contaLida) {
		throw new Error(
			`esperado exatamente 1 linha em channel_accounts, encontrei ${linhas.length} — a conta do canal precisa ser unica`,
		);
	}
	if (contaLida.phone_e164 !== env.CHANNEL_PHONE_E164) {
		// Sem logar o valor: o E.164 do número dedicado é PII e o log não é o lugar
		// para ele (COMP-05, R-064). O motivo do erro é a divergência de config.
		throw new Error(
			"channel_accounts.phone_e164 divergente de CHANNEL_PHONE_E164 do .env — " +
				"o número dedicado mudou ou o .env aponta para outra conta",
		);
	}
	// Só o booleano vai para o log: confirma a conta sem publicar o número.
	log.info(
		{ step: "channel_account", channel_account_ok: true, rows: linhas.length },
		"conta do canal gravada e relida",
	);

	// (f) Sanidade do schema: `leads` tem de responder.
	const leadsTotal = await countOf(
		conn.db,
		"select count(*)::int as n from leads",
	);
	log.info({ step: "healthcheck", leads_total: leadsTotal }, "total de leads");

	// (g) Quantas migrations o banco realmente tem — a resposta a "o boot aplicou
	//     tudo?". Comparar com os arquivos em disco é o cruzamento que fecha o R-031.
	const migrationsApplied = await countOf(
		conn.db,
		"select count(*)::int as n from drizzle.__drizzle_migrations",
	);
	log.info(
		{ step: "healthcheck", migrations_applied: migrationsApplied },
		"migrations aplicadas",
	);

	if (BOOT_CHECK_ONLY) {
		// Modo gate: encerra. O log precisa estar em disco ANTES do exit, senão o
		// `grep leads_total app.log` do gate lê um arquivo sem a linha e falha.
		await encerra(conn, log, "boot_check");
		flushLogSync();
		process.exit(0);
	}

	// (h) Boot de produção: o processo precisa ficar VIVO (Agendador de Tarefas).
	//     Timer REF'D de propósito: o `pg` devolve o cliente ocioso ao pool depois de
	//     ~10s e, com o event loop vazio, o Node sai sozinho — o launcher "verde" no
	//     primeiro segundo e morto no minuto seguinte, que é o modo de falha mais
	//     difícil de ver. `unref()` aqui seria o oposto do que se quer.
	log.info(
		{ step: "boot_ok", check_only: false, tz: env.TZ },
		"boot concluido; processo vivo",
	);
	keepAlive = setInterval(() => {}, 60_000);

	// (i) Etapa 4 do boot — CANAL, depois do banco. `createSession()` monta a sessão
	//     a partir de `DATA_ROOT` (nunca do cwd) e `abrirSocketDoCanal` cria o socket
	//     com `emitOwnEvents: true` (via `socketConfigOverrides`, WHS-05/R-001): é a
	//     flag que faz o evento `fromMe` do número dedicado existir, e portanto a
	//     única fonte autorizada de `first_contact_by_human` (R-001). O SDK do Baileys
	//     só é tocado dentro de `src/channel/baileys/**` (T-01-12) — aqui só se
	//     orquestra, nenhum import do pacote de protocolo.
	const sessao = await createSession();
	const sock = abrirSocketDoCanal(sessao);
	canalSock = sock;
	log.info(
		{
			step: "channel_session",
			restore_required: sessao.restoreRequired,
		},
		"sessao do canal carregada",
	);

	// O `creds.update` PRECISA ser persistido: sem isso a sessão viveria só em
	// memória até o próximo kill, e o kill destrói a credencial no disco — novo
	// dispositivo (Armadilha 4).
	sock.ev.on("creds.update", () => {
		void sessao.saveCreds().catch((erro: unknown) => {
			log.error(
				{ event: "save_creds_falhou" },
				`nao persisti creds do canal: ${erro instanceof Error ? erro.message : String(erro)}`,
			);
		});
	});

	// O `inbound-handler` é o consumidor do canal: ligado ao barramento, ele resolve
	// o JID e grava em `messages` (T-01-06) ou aciona o handoff.
	const barramento = new BarramentoEventos(conn.db);
	barramento.on("inbound", async (evt) => {
		await processInboundFromMe(conn.db, sock, evt);
	});

	// Pareamento: só quando não há sessão registrada. O Admin DIGITA o par de 8
	// dígitos (o WhatsApp o oferece como alternativa oficial ao scan). O código é
	// segredo de sessão: vai SÓ para `logs\qr.txt`, nunca para o log estruturado.
	if (sessao.restoreRequired) {
		const destino = join(logsDir(), "qr.txt");
		const par = await sock.requestPairingCode(
			env.CHANNEL_PHONE_E164.replace(/^\+/, ""),
		);
		writeFileSync(destino, String(par), { encoding: "utf8" });
		log.info(
			{
				step: "pairing_code",
				arquivo: destino,
				dica: "digite o par de 8 digitos no celular",
			},
			"par de codigo gravado; aguardando connection === open",
		);
	}

	// `readCapabilities()` é chamado na ABERTURA (não antes de conectar): as duas
	// leituras são de rede e só fazem sentido com o socket `open`. Elas logam
	// `new_chat_message_cap`/`reachout_timelock_until` — as linhas que o checkpoint
	// de pareamento confere no `app.log`.
	const lerCapacidades = async (): Promise<void> => {
		try {
			const caps = await readCapabilities(sock);
			log.info(
				{
					step: "capabilities",
					new_chat_message_cap: caps.newChatMessageCap,
					reachout_timelock_until: caps.reachoutTimelockUntil
						? caps.reachoutTimelockUntil.toISOString()
						: null,
					account_valid: caps.accountValid,
				},
				"capabilities lidas na abertura da conexao",
			);
		} catch (erro: unknown) {
			log.warn(
				{ event: "capabilities_falhou" },
				`nao li as capabilities: ${erro instanceof Error ? erro.message : String(erro)}`,
			);
		}
	};

	// Registro explícito dos handlers nomeados do contrato do checkpoint.
	const { onBaileysConnectionUpdate, onBaileysMessage } = criarHandlersDoCanal({
		// `sock.user` só existe após o registro, por isso um GETTER: o runtime o
		// reavalia por mensagem para carimbar o emissor do `fromMe` (CR-01). Acesso
		// a propriedade — nenhum import do pacote Baileys aqui (T-01-12).
		canalSelfJid: () => sock.user?.id,
		aoConectar: () => {
			canalEstado = "open";
			// O emissor do número dedicado precisa de E.164 para o Gate 0 (R-001).
			// Id próprio em forma LID não tem número: o Guard 0 fica fail-closed. UM
			// warn por abertura de conexão (nunca por mensagem) para o operador ver no
			// pareamento real (P-004) em vez de a guarda falhar em silêncio.
			const idProprio = sock.user?.id;
			if (idProprio && normalizeJid(idProprio).e164 === null) {
				log.warn(
					{ event: "jid_proprio_sem_e164", step: "channel_session" },
					"o id proprio do numero dedicado nao tem E.164 (forma LID): o Gate 0 do primeiro contato fica fail-closed ate o pareamento real",
				);
			}
			void lerCapacidades();
		},
		aoDesconectar: (status) => {
			const estadoDoSocket = translateDisconnect(status ?? 0);
			canalEstado =
				estadoDoSocket.event === "logged_out" ? "logged_out" : "close";
			log.warn(
				{
					step: "channel_disconnected",
					sinal: estadoDoSocket.event,
					terminal: estadoDoSocket.terminal,
					severity: estadoDoSocket.severity,
				},
				"socket do canal caiu",
			);
			if (estadoDoSocket.terminal) {
				// Reconectar num número deslogado/bloqueado é o pior cenário (T-01-14):
				// fecha e sai em erro em vez de entrar em loop de reconexão.
				void encerra(conn, log, `canal_${estadoDoSocket.event}`).then(() => {
					flushLogSync();
					process.exit(1);
				});
			}
		},
		aoEventoInbound: (evt) => {
			if (evt.fromMe === true) {
				// A linha que o passo 5 do checkpoint procura: prova que `emitOwnEvents`
				// está ligado e que a auto-mensagem do número dedicado chega como `fromMe`.
				log.info(
					{
						event: "inbound_fromme",
						provider_msg_id: evt.providerMsgId ?? null,
					},
					"mensagem fromMe do numero dedicado recebida",
				);
			}
			void barramento.emit("inbound", evt).catch((erro: unknown) => {
				log.error(
					{ event: "inbound_emit_falhou" },
					`handler de inbound falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
				);
			});
		},
	});
	sock.ev.on("connection.update", onBaileysConnectionUpdate);
	sock.ev.on("messages.upsert", onBaileysMessage);
	log.info({ step: "channel_ready" }, "canal armado; aguardando eventos");

	// (j) MONITOR DE SAÚDE (R-045, WHS-04). Um cron de 30s: probe do banco com
	//     `statement_timeout` de 2s numa conexão efêmera (um probe que trava não
	//     pode pendurar o processo), estado do Baileys lido de `canalEstado`, e
	//     notificação SÓ em `critical` — um `warn` repetido vira uma notificação
	//     por transição, e a notificação é revertida quando a saúde volta
	//     (T-01-28). Cada achado grava em `event_log` (trilha append-only).
	monitorSaude = startHealthMonitor({
		notify: criarNotifier().notify,
		baileysState: () => canalEstado,
		probeDb: async () => {
			const cliente = new Client({
				connectionString: env.DATABASE_URL,
				statement_timeout: 2000,
			});
			await cliente.connect();
			try {
				await cliente.query("select 1");
			} finally {
				await cliente.end().catch(() => {});
			}
		},
		logFinding: async (achado: Achado) => {
			try {
				await conn.db.execute(sql`
					insert into event_log (event_type, entity_type, payload, severity)
					values (
						${achado.event},
						'health_monitor',
						${JSON.stringify({ message: achado.message, urgency: achado.urgency })}::jsonb,
						${achado.severity}
					)
				`);
			} catch (erro: unknown) {
				log.error(
					{ event: "event_log_indisponivel" },
					`nao gravei achado do monitor em event_log: ${erro instanceof Error ? erro.message : String(erro)}`,
				);
			}
		},
		cronPattern: "*/30 * * * * *",
		// Reconexão silenciosa (T-01-29): só re-pareia se a sessão carregou com
		// credenciais válidas. Sessão inválida → o monitor para com `critical`, sem
		// pedir par (pedir par com sessão corrompida conta como dispositivo novo).
		credsValid: () => !sessao.restoreRequired,
		requestPairingCode: async () => {
			const par = await sock.requestPairingCode(
				env.CHANNEL_PHONE_E164.replace(/^\+/, ""),
			);
			writeFileSync(join(logsDir(), "qr.txt"), String(par), {
				encoding: "utf8",
			});
			log.info(
				{ step: "reconnect_pairing_code" },
				"reconexao silenciosa: novo par gravado em qr.txt",
			);
		},
	});
	log.info({ step: "health_monitor", cron: "30s" }, "monitor de saude armado");

	// (k) RELATÓRIO DIÁRIO 23:55 America/Sao_Paulo (R-061/R-062). A apuração é do
	//     dia corrente no fuso de São Paulo (o gate avalia nesse fuso, D-05) e vai
	//     para `event_log` — a trilha que o painel lê, não um arquivo solto.
	const diaEmSaoPaulo = (data: Date): string =>
		new Intl.DateTimeFormat("en-CA", {
			timeZone: env.TZ,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(data);

	cronRelatorio = new Cron("55 23 * * *", { timezone: env.TZ }, async () => {
		try {
			const relatorio = await dailyReport(conn.db, diaEmSaoPaulo(new Date()));
			await conn.db.execute(sql`
				insert into event_log (event_type, entity_type, payload, severity)
				values (
					'piloto_relatorio_diario',
					'daily_report',
					${JSON.stringify(relatorio)}::jsonb,
					'info'
				)
			`);
			log.info(
				{
					step: "daily_report",
					reunioes_agendadas: relatorio.reunioesAgendadas,
					leads_qualificados: relatorio.leadsQualificados,
					leads_novos: relatorio.leadsNovos,
					taxa_qualificacao: relatorio.taxaQualificacao,
				},
				"relatorio diario do piloto gravado",
			);
		} catch (erro: unknown) {
			log.error(
				{ event: "daily_report_falhou" },
				`relatorio diario falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
			);
		}
	});
	log.info(
		{ step: "daily_report_cron", at: "23:55", tz: env.TZ },
		"cron do relatorio diario armado",
	);

	// (l) Encerramento gracioso. Kill abrupto corrompe o `useMultiFileAuthState`, e um
	//     auth corrompido é lido pelo WhatsApp como dispositivo novo — sinal de
	//     banimento. Fechar o socket, o pool e drenar o log é o que torna o Ctrl+C seguro.
	const sinal = (nome: NodeJS.Signals) => {
		void encerra(conn, log, nome).then(() => {
			flushLogSync();
			process.exit(0);
		});
	};
	process.on("SIGINT", sinal);
	process.on("SIGTERM", sinal);
};

const encerra = async (
	conn: Awaited<ReturnType<typeof openDb>>,
	log: ReturnType<typeof childLogger>,
	motivo: string,
): Promise<void> => {
	log.info({ step: "shutdown", motivo }, "encerrando");
	// Solta o timer ANTES de fechar o pool: enquanto ele existir ref'd, o processo
	// não sai, e `pool.end()`+%`exit` seriam a única saída.
	if (keepAlive) {
		clearInterval(keepAlive);
		keepAlive = undefined;
	}
	// Fecha o socket ANTES do pool: é o fechamento gracioso que evita corromper o
	// `useMultiFileAuthState` (Armadilha 4). `end(undefined)` encerra sem logout.
	if (canalSock) {
		log.info({ step: "channel_close" }, "fechando socket do canal");
		try {
			await canalSock.end(undefined);
		} catch (erro: unknown) {
			log.warn(
				{ event: "channel_close_falhou" },
				`socket nao fechou limpo: ${erro instanceof Error ? erro.message : String(erro)}`,
			);
		}
		canalSock = undefined;
	}
	await closeDb(conn);
	// Para o "motor" por último (ordem do plano: socket → pool → cron). Parar um
	// cron só desarma o relógio: não há I/O pendente a drenar.
	if (monitorSaude) {
		monitorSaude.stop();
		monitorSaude = undefined;
	}
	if (cronRelatorio) {
		cronRelatorio.stop();
		cronRelatorio = undefined;
	}
};

main().catch((erro: unknown) => {
	// Última linha de defesa: um boot que falha tem que PARAR, nunca seguir meio
	// inicializado (fail-closed — R-031 e a segurança de R-042 dependem disso).
	const mensagem = erro instanceof Error ? erro.message : String(erro);
	console.error(`[boot] FALHA: ${mensagem}`);
	try {
		flushLogSync();
	} catch {
		// Sem log não há muito a fazer além de sair com código de erro.
	}
	process.exit(1);
});
