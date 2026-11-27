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
 * `dispatcher` é o único choke-point de envio e o adaptador LLM de produção é
 * instanciado aqui e injetado no `inbound-handler` (`deps.llm`).
 */
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { Cron } from "croner";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import qrcode from "qrcode-terminal";
import { type PanelCore, startPanel } from "./api/server.js";
import { drenarCatchup } from "./application/catchup-drain.js";
import { BarramentoEventos } from "./application/event-bus.js";
import {
	POLICY_VERSION,
	PROMPT_VERSION,
	processInboundFromMe,
} from "./application/inbound-handler.js";
import { drainLoop } from "./application/outbox-worker.js";
import { startRetencaoJob } from "./application/retention.js";
import { startScheduler } from "./application/scheduler.js";
import { CAP_MENSAGENS } from "./application/shadow.js";
import { criarBaileysChannel } from "./channel/baileys/adapter.js";
import { readCapabilities } from "./channel/baileys/capabilities.js";
import { normalizeJid } from "./channel/baileys/jid-resolver.js";
import {
	abrirSocketDoCanal,
	aguardarSocketAberto,
	backoffComJitter,
	criarHandlersDoCanal,
	criarReferenciaSocket,
	pedirCodigoDoSocket,
	type WASocket,
} from "./channel/baileys/runtime.js";
import { createSession } from "./channel/baileys/session.js";
import { translateDisconnect } from "./channel/baileys/signals.js";
import { type Env, ensureDataDirs, env, logsDir } from "./config/env.js";
import { feriadosNacionais } from "./domain/feriados-br.js";
import { closeDb, openDb } from "./infra/db/client.js";
import { dailyReport } from "./infra/db/queries/daily-report.js";
import {
	lerFeriadosOverride,
	lerMaxToques,
} from "./infra/db/queries/settings.js";
import { checkEnv, falhasDeEnv, formatarFalhaEnv } from "./infra/env-check.js";
import {
	type Achado,
	type BaileysState,
	startHealthMonitor,
} from "./infra/health-monitor.js";
import {
	criarAiSdkAdapter,
	type LanguageModel,
} from "./infra/llm/ai-sdk-adapter.js";
import { childLogger, flushLogSync } from "./infra/logger.js";
import { criarNotifier } from "./infra/notifier.js";

/**
 * `BOOT_CHECK_ONLY=1` vem do `launch.cmd check`. Roda o MESMO boot, passo por passo
 * — o que valida o stack inteiro — e encerra em vez de ficar vivo. Sem isso, um
 * launcher que mantém processo nunca devolveria exit 0 e o gate ficaria pendurado.
 */
const BOOT_CHECK_ONLY = process.env.BOOT_CHECK_ONLY === "1";

/**
 * Teto de espera do WebSocket abrir antes do pareamento (P-004). Cobre com folga um
 * handshake frio (TLS medido em ~370 ms nesta máquina) e, se estourar, transforma o
 * antigo throw silencioso do `requestPairingCode` numa falha VISÍVEL no `app.log`.
 */
const SOCKET_OPEN_TIMEOUT_MS = 30_000;

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
 * Logger de boot no escopo do módulo para que `main().catch` registre a falha no
 * `app.log` — e não só no console. Sem isto, um erro de boot posterior ao logger
 * (ex.: o `Connection Closed` do `requestPairingCode`, P-004) morria mudo no
 * arquivo, que é exatamente o que atrasou o diagnóstico.
 */
let bootLog: ReturnType<typeof childLogger> | undefined;

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
let jobRetencao: ReturnType<typeof startRetencaoJob> | undefined;

/**
 * O "motor" da cadência (03-02): o scheduler é o produtor do `outbox`, e o
 * `drainLoop` é quem o drena. Ambos escrevem no banco, então são parados ANTES
 * do `closeDb` — um tick que disparasse durante o fechamento do pool cairia no
 * meio de um `pool.end()` e gravaria `scheduled_tasks` pela metade.
 */
let motorScheduler: ReturnType<typeof startScheduler> | undefined;
let motorDreno: AbortController | undefined;

/**
 * Instância do painel HTTP (03-03). Vive no escopo do módulo para o `encerra`
 * fechá-la ANTES do pool: `app.close()` encerra as conexões SSE penduradas e
 * para de aceitar requests — um request que lesse o `db` depois do `closeDb`
 * cairia no meio de um `pool.end()`.
 */
let painelApp: Awaited<ReturnType<typeof startPanel>> | undefined;

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
	if (env.KILL_SWITCH) {
		console.log("[boot] KILL_SWITCH=1 — nenhum servico iniciado");
		return;
	}

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
	// Publica o logger para o `main().catch` de nível de módulo: a partir daqui, uma
	// falha de boot deixa rastro no `app.log` (P-004), não só no console.
	bootLog = log;

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

	// (i.0) Encerramento gracioso ANTES do pareamento (P-004). Kill abrupto corrompe o
	//       `useMultiFileAuthState`, e um auth corrompido é lido pelo WhatsApp como
	//       dispositivo novo — sinal de banimento. Registrar AQUI (e não no fim do
	//       boot) garante que um Ctrl+C durante o `await` do pareamento ainda feche o
	//       socket e o pool e drene o log, em vez de matar sem shutdown registrado.
	const sinal = (nome: NodeJS.Signals) => {
		void encerra(conn, log, nome).then(() => {
			flushLogSync();
			process.exit(0);
		});
	};
	process.on("SIGINT", sinal);
	process.on("SIGTERM", sinal);

	// (i) Etapa 4 do boot — CANAL, depois do banco. `createSession()` monta a sessão
	//     a partir de `DATA_ROOT` (nunca do cwd) e `abrirSocketDoCanal` cria o socket
	//     com `emitOwnEvents: true` (via `socketConfigOverrides`, WHS-05/R-001): é a
	//     flag que faz o evento `fromMe` do número dedicado existir, e portanto a
	//     única fonte autorizada de `first_contact_by_human` (R-001). O SDK do Baileys
	//     só é tocado dentro de `src/channel/baileys/**` (T-01-12) — aqui só se
	//     orquestra, nenhum import do pacote de protocolo.
	const sessao = await createSession();
	const referenciaSocket = criarReferenciaSocket(
		await abrirSocketDoCanal(sessao),
	);
	const sock = referenciaSocket.proxy;
	canalSock = sock;
	log.info(
		{
			step: "channel_session",
			restore_required: sessao.restoreRequired,
		},
		"sessao do canal carregada",
	);

	// O adaptador LLM de PRODUÇÃO (D-08/D-10): o `inbound-handler` só roda o
	// sanduíche (extração → decisão → geração) quando `deps.llm` está injetado —
	// e o matcher DETERMINÍSTICO de opt-out (R-024/AR-005) roda dentro desse
	// sanduíche, antes da LLM. Sem este passo, um "pode me tirar" seria gravado
	// e ignorado. Provider/modelo vêm do `.env` (fail-closed no parse do zod);
	// a chave é `LLM_API_KEY` com fallback para a variável padrão do provider,
	// mesma convenção do bake-off. Chave vazia NÃO aborta o boot: o adaptador é
	// injetado e as chamadas falham fail-closed (silêncio + notificação, D-10).
	const CHAVE_ENV_DO_PROVIDER: Record<Env["LLM_PROVIDER"], string> = {
		openai: "OPENAI_API_KEY",
		anthropic: "ANTHROPIC_API_KEY",
		google: "GOOGLE_GENERATIVE_AI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
	};
	const chaveLlm =
		env.LLM_API_KEY ||
		process.env[CHAVE_ENV_DO_PROVIDER[env.LLM_PROVIDER]] ||
		"";
	const criarModeloLlm = (): LanguageModel => {
		const apiKey = chaveLlm || undefined;
		if (env.LLM_PROVIDER === "openrouter") {
			return createOpenRouter({ apiKey })(env.LLM_MODEL);
		}
		if (env.LLM_PROVIDER === "anthropic") {
			return createAnthropic({ apiKey })(env.LLM_MODEL);
		}
		if (env.LLM_PROVIDER === "google") {
			return createGoogleGenerativeAI({ apiKey })(env.LLM_MODEL);
		}
		return createOpenAI({ apiKey })(env.LLM_MODEL);
	};
	const llmProducao = criarAiSdkAdapter({
		model: criarModeloLlm(),
		promptVersion: PROMPT_VERSION,
		policyVersion: POLICY_VERSION,
	});
	// Um notifier por processo: é um objeto sem estado (um `spawn` por chamada),
	// e injetá-lo aqui é o que faz o handoff local (R-013) disparar de verdade —
	// sem ele, `deps.notifier?.notify` engole a notificação em silêncio.
	const notifierInbound = criarNotifier();
	log.info(
		{
			step: "llm_adapter",
			provider: env.LLM_PROVIDER,
			model: env.LLM_MODEL,
			api_key: chaveLlm ? "definida" : "AUSENTE",
		},
		"adaptador LLM de producao instanciado para injetar no inbound",
	);

	// O `inbound-handler` é o consumidor do canal: ligado ao barramento, ele resolve
	// o JID e grava em `messages` (T-01-06) ou aciona o handoff.
	const barramento = new BarramentoEventos(conn.db);
	barramento.on("inbound", async (evt) => {
		await processInboundFromMe(conn.db, sock, evt, {
			llm: llmProducao,
			notifier: notifierInbound,
		});
	});

	let fasePareamentoInicial = sessao.restoreRequired;
	let tentativasReabertura = 0;

	const pedirCodigoDePareamento = async (): Promise<void> => {
		await pedirCodigoDoSocket(
			sock,
			env.CHANNEL_PHONE_E164,
			SOCKET_OPEN_TIMEOUT_MS,
			join(logsDir(), "qr.txt"),
		);
	};

	// Pareamento: só quando não há sessão registrada.
	if (fasePareamentoInicial) {
		if (env.PAIRING_MODE === "code") {
			await pedirCodigoDePareamento();
			log.info(
				{
					step: "pairing_code",
					arquivo: join(logsDir(), "qr.txt"),
					dica: "digite o par de 8 digitos no celular",
				},
				"par de codigo gravado; aguardando connection === open",
			);
		} else {
			console.log("\n=======================================================");
			console.log("👉 AGUARDANDO QR CODE DO WHATSAPP NO TERMINAL...");
			console.log("   Abra o WhatsApp no celular -> Aparelhos conectados");
			console.log("   Toque em 'Conectar um aparelho' e aponte a camera");
			console.log("=======================================================\n");
		}
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

	/**
	 * Recria o socket do Baileys após stream error 515 (restartRequired) recebido
	 * logo depois de um pareamento bem-sucedido. O servidor WhatsApp pede para
	 * reiniciar a conexão; o Baileys fecha o socket via end() e não o reabre.
	 * Como creds.me já está persistido (configureSuccessfulPairing + saveCreds),
	 * o novo socket faz login (não registro) e abre normalmente.
	 *
	 * Declarada como function declaration (hoisted) para ser referenciada em
	 * aoDesconectar (definida abaixo) antes de `canal` existir (linha ~602).
	 * Só é chamada após o boot completar, quando canal já está inicializado.
	 */
	let reabrindo = false;

	async function reabrirSocket(
		motivo: string,
		status: number | null,
	): Promise<void> {
		if (reabrindo) {
			log.warn(
				{ step: "channel_recreate", motivo },
				"reabertura ja em andamento; ignorando novo sinal de close",
			);
			return;
		}
		reabrindo = true;
		try {
			const tentativa = ++tentativasReabertura;
			const espera = backoffComJitter(tentativa);
			log.info(
				{
					step: "channel_recreate",
					motivo,
					status,
					tentativa,
					espera_ms: espera,
				},
				"reabrindo socket do canal",
			);
			await new Promise((resolve) => setTimeout(resolve, espera));
			const novoSock = await abrirSocketDoCanal(sessao);
			await aguardarSocketAberto(novoSock, SOCKET_OPEN_TIMEOUT_MS);

			referenciaSocket.trocar(novoSock);

			sock.ev.on("connection.update", onBaileysConnectionUpdate);
			sock.ev.on("messages.upsert", onBaileysMessage);

			void lerCapacidades();

			log.info(
				{ step: "channel_recreated", motivo, tentativa },
				"socket recriado com sucesso",
			);
		} finally {
			reabrindo = false;
		}
	}

	// Registro explícito dos handlers nomeados do contrato do checkpoint.
	const { onBaileysConnectionUpdate, onBaileysMessage } = criarHandlersDoCanal({
		// `sock.user` só existe após o registro, por isso um GETTER: o runtime o
		// reavalia por mensagem para carimbar o emissor do `fromMe` (CR-01). Acesso
		// a propriedade — nenhum import do pacote Baileys aqui (T-01-12).
		canalSelfJid: () => sock.user?.id,
		aoQrCode: (qrStr: string) => {
			if (fasePareamentoInicial) {
				console.log(
					"\n=======================================================",
				);
				console.log("📲 ESCANEIE O QR CODE ABAIXO NO SEU WHATSAPP:");
				console.log(
					"=======================================================\n",
				);
				qrcode.generate(qrStr, { small: true });
				console.log(
					"\n(Abra o WhatsApp -> Aparelhos conectados -> Conectar um aparelho)\n",
				);
			}
		},
		aoConectar: () => {
			canalEstado = "open";
			sessao.marcarSessaoRestaurada();
			fasePareamentoInicial = false;
			tentativasReabertura = 0;
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
					retry: estadoDoSocket.retry,
					severity: estadoDoSocket.severity,
				},
				"socket do canal caiu",
			);
			if (estadoDoSocket.retry) {
				void reabrirSocket(estadoDoSocket.event, status).catch(
					(erro: unknown) => {
						log.error(
							{ err: erro, step: "channel_recreate" },
							"falha ao reabrir socket do canal",
						);
					},
				);
				return;
			}
			if (estadoDoSocket.terminal) {
				if (fasePareamentoInicial) {
					log.info(
						{ step: "channel_disconnected", sinal: estadoDoSocket.event },
						"socket fechou durante pareamento inicial; aguardando conexao",
					);
					return;
				}
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

	jobRetencao = startRetencaoJob({ db: conn.db, timezone: env.TZ });
	log.info(
		{ step: "retencao_cron", at: "03:37", tz: env.TZ },
		"cron de retencao de 180 dias armado",
	);

	// (l) MOTOR DA CADÊNCIA (03-02) — dreno de catch-up + `drainLoop` + scheduler.
	//     Depois do canal armado e do `migrate()`; antes de tudo, os três são
	//     PRODUTORES e não senders: nenhum chama o método de envio do canal. O
	//     único choke-point continua sendo o `dispatcher`, e o `drainLoop` só o
	//     invoca — com o gate reavaliado a cada job (`outbox-worker.ts`).
	const canal = criarBaileysChannel({
		db: conn.db,
		sock,
		// `criarNotifier` devolve um objeto sem estado (um `spawn` por chamada);
		// um segundo exemplar aqui custa nada e mantém o diff da etapa (j) intacto.
		notifier: criarNotifier(),
	});

	// Feriados: nacionais (D-09, puros — `feriados-br.ts` nunca toca banco) +
	// o override manual do `settings`, já validado por `lerFeriadosOverride`.
	// Ano corrente + próximo: o processo pode atravessar a virada e ainda assim
	// saber que 01-01 é feriado.
	const ano = new Date().getFullYear();
	const feriados = [
		...feriadosNacionais(ano),
		...feriadosNacionais(ano + 1),
		...(await lerFeriadosOverride(conn.db)),
	];
	const tetoToques = await lerMaxToques(conn.db);

	// O catch-up roda UMA vez, no boot. `isCatchupDrain` é decidido AQUI, como
	// parâmetro — NUNCA lido de `settings`: um operador não pode religar um
	// dreno que já rodou, ou o R-007 viraria um loop de reenvio. Vai em
	// background para não atrasar o boot: ele só REAGENDA jobs (limite de 3
	// iminentes + o resto adiado), e quem envia é o `drainLoop` abaixo.
	const CATCHUP_DRAIN_FIRME = true;
	void drenarCatchup(conn.db, {
		now: new Date(),
		isCatchupDrain: CATCHUP_DRAIN_FIRME,
		feriados,
	}).catch((erro: unknown) => {
		log.error(
			{ event: "catchup_drain_falhou" },
			`dreno de catch-up falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
		);
	});

	// `ctx` do gate (D-05): os campos de CONFIGURAÇÃO, lidos uma vez no boot.
	// Os contadores do dia NÃO entram aqui: `sentToday` é atualizado pelo próprio
	// `dispatch` a cada job (via `channel.readQuota`) e `newContactsToday` é
	// lido do `daily_counters` no ATO do dispatch — congelar qualquer um deles no
	// boot faria o gate avaliar o dia inteiro com o contador da subida. O
	// relógio do dreno é fresco a cada iteração (`agora`), senão a janela
	// operacional congelaria no instante do boot.
	motorDreno = new AbortController();
	void drainLoop(
		conn.db,
		{
			channel: canal,
			now: new Date(),
			ctx: {
				tz: env.TZ,
				windowStartHour: env.WINDOW_START_HOUR,
				windowEndHour: env.WINDOW_END_HOUR,
				dailyMessageLimit: env.DAILY_MESSAGE_LIMIT,
				dailyMessageCap: CAP_MENSAGENS,
			},
		},
		{ signal: motorDreno.signal, agora: () => new Date() },
	).catch((erro: unknown) => {
		log.error(
			{ event: "drain_loop_falhou" },
			`drainLoop do outbox caiu: ${erro instanceof Error ? erro.message : String(erro)}`,
		);
	});

	// O scheduler é o PRODUTOR: lê estado e chama `enqueue`. Tick de 30s (D-04),
	// single-instance — uma segunda instância correria contra o mesmo estado e
	// competiria pelos mesmos `INSERT`.
	motorScheduler = startScheduler({
		db: conn.db,
		now: () => new Date(),
		feriados,
		maxToques: tetoToques,
	});
	log.info(
		{
			step: "cadence_motor",
			catchup_drain: CATCHUP_DRAIN_FIRME,
			max_toques: tetoToques,
		},
		"motor armado: scheduler 30s + drainLoop + catch-up",
	);

	// (m) PAINEL HTTP (03-03) — na MESMA instância/porta do processo (D-17), só
	//     DEPOIS do `migrate()` (passo d) e do canal (passo i), que é quem o
	//     `dispatchDeps.channel` espera. O painel NÃO é um segundo motor: as rotas
	//     só LEEM estado e, para enviar, chamam o `dispatcher` — o único
	//     choke-point de envio (NFRQ-05). A borda (Host guard + Bearer token, bind
	//     literal 127.0.0.1) vive em `src/api/server.ts`.
	const corePainel: PanelCore = {
		db: conn.db,
		bus: barramento,
		// Copiloto (03-05): mesma porta de GERAÇÃO que o pipeline usa — a
		// sugestão é rascunho (`ai_suggestion`), nunca envio.
		llm: llmProducao,
		dispatchDeps: {
			db: conn.db,
			channel: canal,
			ctx: {
				tz: env.TZ,
				windowStartHour: env.WINDOW_START_HOUR,
				windowEndHour: env.WINDOW_END_HOUR,
				dailyMessageLimit: env.DAILY_MESSAGE_LIMIT,
				dailyMessageCap: CAP_MENSAGENS,
			},
		},
		feriados,
		agora: () => new Date(),
	};
	painelApp = await startPanel({ core: corePainel });
	log.info(
		{ step: "panel_listening", host: "127.0.0.1", port: env.PANEL_PORT },
		"painel HTTP no ar em 127.0.0.1",
	);
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
	// O motor da cadência escreve no banco: para ANTES do socket e do pool.
	// Um tick que disparasse depois do `closeDb` cairia no meio de um
	// `pool.end()` e gravaria `scheduled_tasks` pela metade.
	if (motorScheduler) {
		motorScheduler.stop();
		motorScheduler = undefined;
	}
	if (jobRetencao) {
		jobRetencao.stop();
		jobRetencao = undefined;
	}
	if (motorDreno) {
		// Aborta o sinal: o laço termina a espera atual e não pega um job novo.
		// `drainOnce` em andamento completa — matá-lo a meio envio seria o kill
		// abrupto que este shutdown existe para evitar.
		motorDreno.abort();
		motorDreno = undefined;
	}
	// Fecha o painel HTTP ANTES do socket e do pool: `app.close()` encerra as
	// conexões SSE penduradas e espera os requests em voo. Uma conexão SSE deixada
	// aberta é exatamente o "pendurado no shutdown" que o plano proíbe — e um
	// request que lesse o `db` após o `closeDb` cairia no `pool.end()`.
	if (painelApp) {
		log.info({ step: "panel_close" }, "fechando painel HTTP");
		try {
			await painelApp.close();
		} catch (erro: unknown) {
			log.warn(
				{ event: "panel_close_falhou" },
				`painel nao fechou limpo: ${erro instanceof Error ? erro.message : String(erro)}`,
			);
		}
		painelApp = undefined;
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
	// Console SEMPRE: é o que o operador vê na janela do launcher.
	console.error(`[boot] FALHA: ${mensagem}`);
	// E no `app.log` quando o logger já subiu. Um throw depois do logger não pode
	// morrer mudo no arquivo — foi o que escondeu o `Connection Closed` do
	// `requestPairingCode` (P-004).
	try {
		bootLog?.error({ event: "boot_falhou" }, `boot falhou: ${mensagem}`);
	} catch {
		// Sem logger acessível, o `console.error` acima já cumpriu o papel.
	}
	try {
		flushLogSync();
	} catch {
		// Sem log não há muito a fazer além de sair com código de erro.
	}
	process.exit(1);
});
