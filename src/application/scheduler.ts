/**
 * O tick de 30s que faz o bot **rodar sozinho** (D-03/D-04, FLUP-01/02/03).
 *
 * ## Por que este arquivo é um PRODUTOR, e nunca um sender
 *
 * O scheduler lê o estado, escreve `scheduled_tasks` e chama `outbox.enqueue` —
 * e só. Não importa o orquestrador de envio, não chama o método de envio do
 * canal, não conhece o `ChannelPort`. A razão é estrutural: o único choke-point
 * de envio é o módulo que fala com o canal, e ele **sempre** roda o gate. Um
 * scheduler que enviasse teria de reimplementar o gate ou contorná-lo — que é
 * exatamente o "envio sem gate" que o `tests/lint/choke-point.grep.test.ts`
 * transforma em falha de suíte. Aqui, o
 * trabalho do tick é decidir **o que deve existir na fila**; quem avalia janela,
 * cota e anti-requisitos é o `outbox-worker` no momento do dreno.
 *
 * ## A âncora é `last_outbound_at`, jamais `now()`
 *
 * `proximaTentativa(last_outbound_at, follow_up_index)` (D-01) projeta o alvo de
 * forma determinística. O tick só **compara** `alvo <= now`; ele **nunca**
 * reancora no relógio. Se reancorasse, cada tick de 30s geraria um `scheduled_for`
 * novo para o mesmo `(conversation, index)` e o alvo nunca venceria — o follow-up
 * que o ADR-009 promete nunca sairia (Pitfall 2, T-03-08). É por isso que o teste
 * prova que o `scheduled_for` fica IDÊNTICO entre dois ticks.
 *
 * ## A idempotência vem de três barreiras, não de uma flag
 *
 * (1) o índice único parcial `(conversation_id, follow_up_index) WHERE
 * status='pending'` torna o INSERT da task um `ON CONFLICT DO NOTHING`; (2)
 * `outbox.idempotency_key = 'flup:{conv}:{idx}'` (UNIQUE) faz o segundo
 * `enqueue` devolver `null` — e `null` é a resposta **correta**, não um erro;
 * (3) `messages.idempotency_key` é a rede final no envio. Dois ticks
 * concorrentes não duplicam nem agendamento nem envio (D-05).
 */
import { createHash } from "node:crypto";
import { Cron } from "croner";
import { sql } from "drizzle-orm";
import { cadenciaEncerrada, proximaTentativa } from "../domain/cadence.js";
import type { Db } from "../infra/db/client.js";
import {
	candidatosEmCadencia,
	type PendenteFora,
	pendentesForaDeCadencia,
	reconciliar,
} from "../infra/db/queries/scheduler.js";
import { childLogger } from "../infra/logger.js";
import { abandon, enqueue } from "./outbox.js";

const log = childLogger("scheduler");

/** Padrão de produção: a cada 30s (mesma cadência do monitor de saúde, D-04). */
const CRON_PADRAO = "*/30 * * * * *";

export interface SchedulerDeps {
	readonly db: Db;
	/** Relógio injetável — o tick nunca chama `Date.now()` direto (testável). */
	readonly now: () => Date;
	/** Calendário de feriados BR (carregado no boot, 03-01). */
	readonly feriados: readonly string[];
	/** Teto de toques (`settings.followup.max_touches`, clampado em 1..4). */
	readonly maxToques: number;
	/** Sobrescreve o cron nos testes (um padrão que nunca dispara). */
	readonly cronPattern?: string;
}

export interface Scheduler {
	stop(): void;
	tick(): Promise<void>;
}

/**
 * Textos dos 4 toques (docs/07 §6, verbatim), duas variações cada, na ordem
 * `[0]=1h, [1]=1d, [2]=3d, [3]=7d`. O índice é o `follow_up_index` — o toque
 * número `index+1`.
 */
const TEXTOS_TOQUE: readonly (readonly [string, string])[] = [
	[
		"Oi, [Nome]! Só passando pra ver se você viu minha mensagem anterior.\nFico à disposição.",
		"Oi, [Nome]! Não sei se a mensagem chegou bem.\nSe fizer sentido, me conta como está a parte digital hoje?",
	],
	[
		"Oi, [Nome]! Voltei aqui rapidinho.\nVocê chegou a pensar sobre o que conversamos?",
		"Oi, [Nome]! Sei que a rotina é corrida.\nSó queria saber se faz sentido continuarmos a conversa ou\nse prefere que eu não volte mais.",
	],
	[
		"Oi, [Nome]! Passando pra saber se você teve chance de avaliar.\nEstou por aqui se quiser trocar uma ideia.",
		"Oi, [Nome]! Imagino que a semana esteja cheia.\nSe quiser retomar depois, é só me chamar. Sem pressa.",
	],
	[
		"Oi, [Nome]! Esse é meu último contato pra não te incomodar.\nSe em algum momento fizer sentido conversar sobre presença\ndigital, estou à disposição.",
		"Oi, [Nome]! Vou encerrar por aqui pra não tomar seu tempo.\nSe quiser retomar no futuro, é só me chamar.",
	],
];

/**
 * Escolhe a variação de forma **estável**: `sha256("{conv}:{index}")` primeiro
 * byte `% 2`. Determinístico (o mesmo toque nunca alterna entre ticks), mas
 * espalhado entre conversas — o que evita que todos os leads recebam a mesma
 * frase no mesmo dia.
 */
const varianteDoToque = (conversationId: string, index: number): number => {
	const hash = createHash("sha256")
		.update(`${conversationId}:${index}`)
		.digest();
	return (hash[0] ?? 0) % 2;
};

/**
 * Renderiza o texto do toque. Com nome, troca `[Nome]` pelo primeiro nome. Sem
 * nome, remove a abertura `Oi, [Nome]! ` inteira — a frase seguinte já começa
 * com maiúscula, então o resultado continua uma saudação natural. Um `[Nome]`
 * literal vazando para o lead seria um bug de template, não um caso de borda.
 */
const renderTexto = (modelo: string, nome: string | null): string => {
	const limpo = nome?.trim() ?? "";
	if (limpo.length > 0) {
		const primeiro = limpo.split(/\s+/)[0] ?? limpo;
		return modelo.replaceAll("[Nome]", primeiro);
	}
	return modelo.replace(/^Oi, \[Nome\]! ?/u, "").replaceAll("[Nome]", "");
};

/** Texto do toque `index`, ou `null` se não há template (índice fora da faixa). */
const textoDoToque = (
	conversationId: string,
	nome: string | null,
	index: number,
): string | null => {
	const variacoes = TEXTOS_TOQUE[index];
	if (variacoes === undefined) return null;
	const modelo = variacoes[varianteDoToque(conversationId, index)];
	return modelo === undefined ? null : renderTexto(modelo, nome);
};

/**
 * Passo 1 — avança a cadência: para cada candidato, garante a `scheduled_tasks`
 * do toque corrente e enfileira o job quando o alvo já venceu.
 *
 * O `INSERT ... ON CONFLICT` é a barreira de idempotência do agendamento; o
 * `enqueue` é a do envio. Enfileirar SEMPRE que `alvo <= now` (mesmo quando a
 * task acabou de ser criada) cobre o crash entre o INSERT e o `enqueue`: o
 * segundo `enqueue` é um no-op com a mesma chave.
 */
const agendar = async (deps: SchedulerDeps, agora: Date): Promise<void> => {
	const candidatos = await candidatosEmCadencia(deps.db, {
		now: agora,
		maxToques: deps.maxToques,
	});
	for (const c of candidatos) {
		// Fail-closed: o SQL já filtra `follow_up_index < maxToques`, mas a guarda
		// aqui impede que um índice sem delta chegue a `proximaTentativa` (que
		// lança). Nunca agendar um toque que a cadência não prevê.
		if (cadenciaEncerrada(c.followUpIndex, deps.maxToques)) continue;

		let alvo: Date;
		try {
			alvo = proximaTentativa(c.lastOutboundAt, c.followUpIndex);
		} catch {
			continue;
		}

		if (c.taskPendenteId === null) {
			await deps.db.execute(sql`
				INSERT INTO scheduled_tasks (conversation_id, task_type, scheduled_for, follow_up_index, status)
				VALUES (${c.conversationId}, 'followup', ${alvo}, ${c.followUpIndex}, 'pending')
				ON CONFLICT (conversation_id, follow_up_index) WHERE status = 'pending'
				DO NOTHING
			`);
		}

		if (alvo.getTime() <= agora.getTime()) {
			const texto = textoDoToque(c.conversationId, c.nome, c.followUpIndex);
			if (texto === null) {
				log.warn(
					{
						event: "scheduler_template_ausente",
						conversation_id: c.conversationId,
						follow_up_index: c.followUpIndex,
					},
					"sem template para o toque; pulando enfileiramento",
				);
				continue;
			}
			await enqueue(deps.db, {
				conversationId: c.conversationId,
				origin: "followup",
				body: texto,
				idempotencyKey: `flup:${c.conversationId}:${c.followUpIndex}`,
				scheduledFor: alvo,
			});
		}
	}
};

/**
 * Motivo canônico do cancelamento, em ordem de precedência (o primeiro que casa
 * vence). Os três primeiros espelham `GateReason` (`ar005_opt_out`,
 * `r001_primeiro_contato_nao_humano`, `ar010_handoff_ativo`); `resposta_do_lead`,
 * `conversa_encerrada` e `pausa_manual` são específicos do agendador, mas o
 * `cancelled_reason` é texto livre auditável (Pattern 3).
 */
const motivoCancelamento = (p: PendenteFora): string => {
	if (p.optOut) return "ar005_opt_out";
	if (!p.firstContactByHuman) return "r001_primeiro_contato_nao_humano";
	if (
		p.lastInboundAt !== null &&
		p.lastOutboundAt !== null &&
		p.lastInboundAt.getTime() >= p.lastOutboundAt.getTime()
	) {
		return "resposta_do_lead";
	}
	if (p.handoffActive) return "ar010_handoff_ativo";
	if (p.closedReason !== null || p.state === "encerrado") {
		return "conversa_encerrada";
	}
	return "pausa_manual";
};

/**
 * Passo 2 — cancela o interrompido, com rastro. A task **não** é apagada (Pattern
 * 3): vira `abandoned` + `cancelled_at` + `cancelled_reason`, e o job do `outbox`
 * é `abandon`ado com o mesmo motivo. "Por que este follow-up de 3 dias não
 * saiu?" tem resposta. O `WHERE status='pending'` evita cancelar uma task que o
 * `drainLoop` já fechou entre a leitura e a escrita.
 *
 * Cancela task e job na MESMA transação: um cancelamento pela metade deixaria o
 * job vivo (enviaria mesmo assim) ou a task viva (órfã). Um job já `sent` é
 * pulado de propósito — quem o fecha é o reconciliador (passo 3), que também
 * avança o cursor. Cancelar aqui perderia o "foi enviado".
 */
const cancelarInterrompidos = async (
	deps: SchedulerDeps,
	agora: Date,
): Promise<void> => {
	const pendentes = await pendentesForaDeCadencia(deps.db, {
		now: agora,
		maxToques: deps.maxToques,
	});
	for (const p of pendentes) {
		if (p.jobStatus === "sent") continue;
		const motivo = motivoCancelamento(p);
		await deps.db.transaction(async (txBruto) => {
			const tx = txBruto as unknown as Db;
			await tx.execute(sql`
				UPDATE scheduled_tasks
				SET status = 'abandoned', cancelled_at = ${agora}, cancelled_reason = ${motivo}
				WHERE id = ${p.taskId} AND status = 'pending'
			`);
			if (
				p.jobId !== null &&
				(p.jobStatus === "pending" || p.jobStatus === "reserved")
			) {
				await abandon(tx, p.jobId, motivo);
			}
		});
	}
};

/**
 * Um tick: agendar → cancelar → reconciliar → re-agendar.
 *
 * A re-agenda final só roda quando o reconciliador **mudou** o estado relevante
 * (fechou uma task `sent` e avançou o cursor, ou achou uma conversa em cadência
 * sem task). Sem isso, o toque recém-liberado esperaria um tick inteiro (30s de
 * latência aceitável, mas desnecessária quando o dado já está em mãos).
 *
 * O overlap guard (`emAndamento`) protege contra um tick lento ainda rodando
 * quando o cron dispara o próximo — sem ele, duas passadas leriam o mesmo estado
 * e competiriam pelos mesmos `INSERT`/`enqueue` (as barreiras segurariam, mas o
 * guard evita a corrida na origem).
 */
export const startScheduler = (deps: SchedulerDeps): Scheduler => {
	let emAndamento = false;

	const tick = async (): Promise<void> => {
		if (emAndamento) return;
		emAndamento = true;
		try {
			const agora = deps.now();
			await agendar(deps, agora);
			await cancelarInterrompidos(deps, agora);
			const { fechadas, orfas } = await reconciliar(deps.db, {
				now: agora,
				maxToques: deps.maxToques,
			});
			if (fechadas > 0 || orfas > 0) {
				await agendar(deps, agora);
			}
		} finally {
			emAndamento = false;
		}
	};

	const job = new Cron(
		deps.cronPattern ?? CRON_PADRAO,
		{ maxRuns: Infinity },
		async () => {
			try {
				await tick();
			} catch (erro: unknown) {
				log.error(
					{ event: "scheduler_tick_falhou" },
					`tick do scheduler falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
				);
			}
		},
	);

	return { stop: () => job.stop(), tick };
};
