/**
 * Kill switch global em 1 comando (02-03 Task 1, D-02).
 *
 * `mode pause` é o botão de emergência: liga `settings.operational_mode='paused'`
 * e, com isso, o gate devolve `kill_switch_ativo` para TODA conversa — porque o
 * `snapshot.ts` computa `killSwitch` como
 * `(not channel_accounts.is_active) or settings.operational_mode='paused'`. O
 * `kill-switch.ts` do gate observa esse valor computado; nada mais precisa saber
 * que o modo mudou.
 *
 * ## Reversível e auditado
 *
 * `mode resume` reverte para `active`. Cada mudança grava UM evento append-only
 * em `event_log` (`event_type='operational_mode_changed'`) com de/para, ator,
 * motivo e origem — a trilha que o relatório de conformidade lê (R-022).
 *
 * ## Por que `event_log`, e não `mode_changes`
 *
 * `mode_changes.conversation_id` é `NOT NULL` com FK para `conversations`: um
 * registro de modo global (sem conversa) não cabe ali. `mode_changes` continua
 * sendo o log de modo POR CONVERSA (gravado pelo handoff); o interruptor global
 * se audita em `event_log`, que já é a trilha append-only de fatos do sistema.
 * Ver a nota de desvio em `02-03-SUMMARY.md`.
 *
 * ## Promoção shadow→ativo é EXPLÍCITA (D-18)
 *
 * Este comando controla o kill switch global (pausa/retoma o envio). Ele NÃO
 * promove conversas de shadow para ativo. A promoção exige ação EXPLÍCITA do
 * Admin, orientada pelo veredito de `npm run shadow:report`; nenhum caminho de
 * código autopromove. `mode status` imprime esse lembrete junto do modo atual.
 */
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { closeDb, type Db, openDb } from "../infra/db/client.js";

/** Destino de uma linha de saída. Injetável para o teste capturar o que a CLI mostra. */
export type Escrever = (linha: string) => void;

const paraConsole: Escrever = (linha) => {
	console.log(linha);
};

/** Os dois valores de `settings.operational_mode`. */
export type ModoOperacional = "active" | "paused";

/** A chave em `settings` que o snapshot lê como kill switch global (D-02). */
export const CHAVE_MODO_OPERACIONAL = "operational_mode";

const USO =
	"uso: mode | mode pause [--reason <texto>] | mode resume [--reason <texto>]";

/** Lembrete de D-18 impresso por `mode status`: o comando NÃO promove por si só. */
const NOTA_PROMOCAO =
	"Promoção shadow→ativo exige ação EXPLÍCITA do Admin (D-18): confira `npm run shadow:report` (veredito PASS) e promova pela revisão. Nenhum código autopromove.";

const lerFlag = (argv: readonly string[], flag: string): string | null => {
	const i = argv.indexOf(flag);
	return i >= 0 ? (argv[i + 1] ?? null) : null;
};

/** Lê o modo atual. Ausência da chave é `active` (o default operacional). */
export const lerModoOperacional = async (db: Db): Promise<ModoOperacional> => {
	const resultado = await db.execute(sql`
		select value #>> '{}' as v
		from settings
		where key = ${CHAVE_MODO_OPERACIONAL}
	`);
	const v = (resultado as unknown as { rows: { v: string | null }[] }).rows[0]
		?.v;
	return v === "paused" ? "paused" : "active";
};

/**
 * Grava o novo modo e o evento de auditoria na MESMA transação: um modo que muda
 * sem trilha é "quem desligou o bot sem dizer por quê", a pergunta que a
 * auditoria não pode deixar de responder. O valor é gravado como JSON
 * (`"paused"`), casando com o `#>> '{}'` do snapshot.
 */
const gravarModo = async (
	db: Db,
	de: ModoOperacional,
	para: ModoOperacional,
	motivo: string | null,
): Promise<void> => {
	await db.transaction(async (txBruto) => {
		const tx = txBruto as unknown as Db;
		await tx.execute(sql`
			insert into settings (key, value, updated_at)
			values (${CHAVE_MODO_OPERACIONAL}, ${JSON.stringify(para)}::jsonb, now())
			on conflict (key) do update
				set value = excluded.value, updated_at = now()
		`);
		await tx.execute(sql`
			insert into event_log (event_type, entity_type, payload, severity)
			values (
				'operational_mode_changed',
				'settings',
				${JSON.stringify({
					from: de,
					to: para,
					actor: "admin",
					reason: motivo,
					source: "cli",
				})}::jsonb,
				'info'
			)
		`);
	});
};

/**
 * Executa um subcomando de modo. Devolve o código de saída (0 ok, 2 erro de uso).
 */
export const runModeCli = async (
	db: Db,
	argv: readonly string[],
	escrever: Escrever = paraConsole,
): Promise<number> => {
	const acao = argv[0];
	const atual = await lerModoOperacional(db);

	if (acao === undefined || acao === "status") {
		escrever(
			atual === "paused"
				? "Modo operacional: paused (kill switch LIGADO — nenhum envio)."
				: "Modo operacional: active (kill switch global desligado).",
		);
		escrever(NOTA_PROMOCAO);
		return 0;
	}

	if (acao === "pause" || acao === "resume") {
		const para: ModoOperacional = acao === "pause" ? "paused" : "active";
		const motivo = lerFlag(argv, "--reason");
		await gravarModo(db, atual, para, motivo);
		escrever(
			para === "paused"
				? "Modo operacional: paused (auditado em event_log). O gate bloqueia com kill_switch_ativo."
				: "Modo operacional: active (auditado em event_log). Envio permitido (se as demais regras passarem).",
		);
		return 0;
	}

	escrever(USO);
	return 2;
};

const executadoDiretamente = (): boolean => {
	const alvo = process.argv[1];
	return alvo !== undefined && import.meta.url === pathToFileURL(alvo).href;
};

if (executadoDiretamente()) {
	const conexao = await openDb(env.DATABASE_URL);
	try {
		process.exitCode = await runModeCli(conexao.db, process.argv.slice(2));
	} finally {
		await closeDb(conexao);
	}
}
