/**
 * Dreno de catch-up (R-007/D-07) e encerramento por não-resposta (D-12/D-13).
 *
 * ## O que é o dreno, e por que ele existe
 *
 * O R-007 promete que um follow-up vencido enquanto o PC estava desligado ainda
 * sai quando o app reabre. O R-007 **não** promete — e o ADR-009 proíbe — que
 * todos saiam de uma vez. Despejar 20 follow-ups atrasados ao abrir é o burst de
 * cadência de máquina que a pesquisa associa a banimento (V-03/R-059), e o
 * número dedicado é insubstituível. O dreno é, portanto, uma **válvula**: libera
 * no máximo `LIMITE_IMINENTES` (3) para sair logo (com jitter de 3–12s entre
 * eles, dentro dos primeiros 10 min) e ADIA o resto para a próxima janela —
 * **nunca descarta** (WHS-02/D-07). O dia seguinte drena mais 3, e assim a fila
 * atrasada se esvazia em passos limitados em vez de num pico.
 *
 * ## Este módulo é um REAGENDADOR, não um sender
 *
 * `drenarCatchup` NÃO envia nada: ele escolhe quais jobs podem sair agora
 * (`marcarCatchupIminente`) e quais esperam (`markDeferred`). Quem envia é o
 * `drainLoop` do `outbox-worker`, que reavalia o gate. Isso preserva o
 * invariante do choke-point (CONV-11): o scheduler e o dreno nunca importam nem
 * chamam o dispatcher. Um dreno que enviasse teria de reimplementar o gate — o
 * "envio sem gate" que o `choke-point.grep.test.ts` transforma em falha.
 *
 * ## Encerramento (D-13): o 4º toque sem resposta fecha a conversa
 *
 * Quando o cursor alcança o teto de toques sem nenhum inbound posterior ao
 * último outbound, a cadência acabou: a conversa vira `encerrado` com
 * `closed_reason='sem_resposta'` e a transição entra em `status_history`
 * (`reason='sem_resposta'`, `changed_by='bot'`, R-022). Read receipts **não**
 * contam — só o watermark de inbound (D-12).
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
	dentroDaJanelaOperacional,
	nextWindow,
} from "../domain/business-hours.js";
import type { Db } from "../infra/db/client.js";
import {
	conversasParaEncerrar,
	jaEnviouFollowUpHoje,
	marcarCatchupIminente,
	type ReconciliarOpts,
	vencidosNoOutbox,
} from "../infra/db/queries/scheduler.js";
import { recordStatusChange } from "../infra/db/queries/status-history.js";
import { childLogger } from "../infra/logger.js";
import { markDeferred } from "./outbox.js";

const log = childLogger("catchup-drain");

/** Janela operacional (AR-007/R-006): dias úteis, 7h–17h. */
const JANELA_INICIO = 7;
const JANELA_FIM = 17;
/** No máximo 3 envios iminentes por drenagem (R-007/ADR-009). */
const LIMITE_IMINENTES = 3;
/** A faixa que o jitter do dreno deve respeitar — os iminentes saem nela. */
const JITTER_MIN_MS = 3_000;
const JITTER_MAX_MS = 12_000;

export interface CatchupDrainDeps {
	/** Relógio injetável (o dreno nunca lê `Date.now()` direto). */
	readonly now: Date;
	/**
	 * O dreno de catch-up roda UMA vez, no boot (`true`). Uma passada com
	 * `false` é um no-op — o boot não pode virar um loop de reenvio.
	 */
	readonly isCatchupDrain: boolean;
	/** Calendário de feriados BR (para `nextWindow`). */
	readonly feriados?: readonly string[];
	/** Teto defensivo da varredura de vencidos. */
	readonly limite?: number;
	/** `sleep` injetável (testes passam no-op; produção dorme de verdade). */
	readonly sleep?: (ms: number) => Promise<void>;
}

export interface CatchupDrainResultado {
	readonly enviados: number;
	readonly adiados: number;
}

const sleepPadrao = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Jitter determinístico por `(conversation, job)` em `[3s, 12s]`: espalha os 3
 * iminentes sem que dois leads recebam no mesmo segundo. Espelha o
 * `varianteDoToque` do scheduler (sha256 do seed), para que a mesma conversa
 * nunca "tire" um número diferente entre passadas.
 */
const jitterDe = (seed: string): number => {
	const hash = createHash("sha256").update(seed).digest();
	const n = hash.readUInt32BE(0) / 0xffff_ffff;
	return Math.round(JITTER_MIN_MS + n * (JITTER_MAX_MS - JITTER_MIN_MS));
};

/**
 * Drena a fila de catch-up. Devolve quantos jobs foram liberados para sair logo
 * (`enviados`, ≤ 3) e quantos foram adiados para a próxima janela (`adiados`).
 */
export const drenarCatchup = async (
	db: Db,
	deps: CatchupDrainDeps,
): Promise<CatchupDrainResultado> => {
	if (!deps.isCatchupDrain) return { enviados: 0, adiados: 0 };

	const feriados = deps.feriados ?? [];
	const dormir = deps.sleep ?? sleepPadrao;

	const vencidos = await vencidosNoOutbox(db, {
		now: deps.now,
		limite: deps.limite,
	});
	const jaHoje = await jaEnviouFollowUpHoje(db, { now: deps.now });

	let enviados = 0;
	let adiados = 0;
	let offsetAcumulado = 0;

	for (const vencido of vencidos) {
		const dentro = dentroDaJanelaOperacional(
			deps.now,
			vencido.timezone,
			JANELA_INICIO,
			JANELA_FIM,
		);
		const podeIminente =
			dentro &&
			enviados < LIMITE_IMINENTES &&
			!jaHoje.has(vencido.conversationId);

		if (!podeIminente) {
			// Fora da janela, acima do limite, ou o lead já teve follow-up hoje:
			// ADIA (durabilidade preservada) — nunca descarta.
			const alvo = nextWindow(
				deps.now,
				vencido.timezone,
				JANELA_INICIO,
				JANELA_FIM,
				feriados,
			);
			await markDeferred(db, vencido.outboxId, alvo);
			adiados += 1;
			continue;
		}

		// Iminente: dorme o jitter (pacing real) e agenda para o offset
		// acumulado, que fica dentro dos primeiros 10 min por construção.
		const jitter = jitterDe(`${vencido.conversationId}:${vencido.outboxId}`);
		await dormir(jitter);
		offsetAcumulado += jitter;
		await marcarCatchupIminente(
			db,
			vencido.outboxId,
			new Date(deps.now.getTime() + offsetAcumulado),
		);
		enviados += 1;
	}

	if (enviados > 0 || adiados > 0) {
		log.info(
			{ event: "catchup_drain", enviados, adiados },
			"dreno de catch-up aplicado (R-007): iminentes limitados, restante adiado",
		);
	}
	return { enviados, adiados };
};

export interface EncerrarResultado {
	readonly encerradas: number;
}

/**
 * Encerra as conversas que esgotaram a cadência sem resposta (D-13).
 *
 * Cada encerramento é uma transação: o `UPDATE` do estado e a auditoria
 * (`status_history`, R-022) são um só commit — se o segundo write falhar, o
 * primeiro reverte. O `to_state` é `'encerrado'`, o valor REAL de
 * `conversations.state`; o nome "Perdido" do funil CRM é uma camada posterior
 * (`pipeline_status`, plano 03-05), e `status_history` guarda o estado de
 * máquina, não o rótulo de CRM.
 */
export const encerrarCadenciasSemResposta = async (
	db: Db,
	deps: ReconciliarOpts,
): Promise<EncerrarResultado> => {
	const alvos = await conversasParaEncerrar(db, deps);

	for (const alvo of alvos) {
		await db.transaction(async (txBruto) => {
			const tx = txBruto as unknown as Db;
			await tx.execute(sql`
				UPDATE conversations
				SET state = 'encerrado', closed_reason = 'sem_resposta'
				WHERE id = ${alvo.conversationId} AND closed_reason IS NULL
			`);
			await recordStatusChange(tx, {
				conversationId: alvo.conversationId,
				fromState: alvo.state,
				toState: "encerrado",
				changedBy: "bot",
				reason: "sem_resposta",
				changedAt: deps.now,
			});
		});
	}

	if (alvos.length > 0) {
		log.info(
			{ event: "cadencias_encerradas", encerradas: alvos.length },
			"cadência esgotada sem resposta (D-13): conversas encerradas",
		);
	}
	return { encerradas: alvos.length };
};
