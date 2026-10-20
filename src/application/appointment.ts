/**
 * Confirmação e lembrete de agendamento (FLUP-08/R-025, D-25).
 *
 * ## 100% manual (D-25) — o bot nunca agenda
 *
 * O Admin registra a reunião no painel; este módulo só REFLETE o que foi
 * registrado: uma mensagem de confirmação e um lembrete, enfileirados no
 * `outbox` (que respeita janela, cota e opt-out — é o gate que decide o envio
 * de verdade, e nada aqui contorna isso). O bot não propõe horário, não
 * negocia e não cria reunião: se o lead pedir para remarcar ou cancelar, o
 * caminho é handoff (R-025) — `tratarRespostaAgendamento` faz exatamente isso.
 *
 * ## Por que `scheduled_tasks` e não só o `outbox`
 *
 * O `outbox` é a fila de ENVIO (descartável depois do envio); `scheduled_tasks`
 * é o ledger DURÁVEL da obrigação ("existe uma confirmação pendente para esta
 * conversa"). A resposta do lead ("confirmar"/"remarcar") precisa ENCERRAR a
 * obrigação — sem o ledger, o lembrete de uma reunião remarcada continuaria
 * agendado e sairia no horário errado.
 *
 * Os índices 100/101 são reservados (fora da faixa 0..5 dos follow-ups): a
 * unique parcial `(conversation_id, follow_up_index) WHERE status='pending'` dá
 * "uma pendência por tipo por conversa" de graça — re-agendar o mesmo tipo sem
 * a anterior vencer não cria duas linhas.
 *
 * ## Janela e cota já no agendamento (não só no envio)
 *
 * Agendar para 03:00 seria enfileirar um envio que o gate vai adiar às 07:00 —
 * o lembrete chegaria depois da reunião. Aqui o horário é NORMALIZADO para a
 * próxima janela útil (R-006) e EMPURRADO enquanto o dia alvo estiver cheio
 * (R-023), antes de qualquer escrita. O gate continua sendo a última palavra.
 */
import { sql } from "drizzle-orm";
import { env } from "../config/env.js";
import {
	ehDiaUtil,
	formatarHoraLocal,
	isWithinWindow,
	nextWindow,
} from "../domain/business-hours.js";
import type { Db } from "../infra/db/client.js";
import { registrarEvento } from "../infra/db/queries/crm.js";
import { dispararHandoff } from "./handoff-service.js";
import { enqueue } from "./outbox.js";

export type TipoAgendamento = "confirmacao" | "lembrete";

/** Índices reservados no ledger (fora da faixa de follow-up 0..5). */
const INDICE: Record<TipoAgendamento, number> = {
	confirmacao: 100,
	lembrete: 101,
};

export interface AgendarInput {
	readonly conversationId: string;
	/** Horário da reunião registrado pelo Admin. */
	readonly quando: Date;
	readonly tipo: TipoAgendamento;
}

export interface AgendarDeps {
	readonly agora?: () => Date;
	readonly tz?: string;
	readonly inicioJanela?: number;
	readonly fimJanela?: number;
	readonly feriados?: readonly string[];
	readonly limite?: number;
}

export type AgendamentoResultado =
	| {
			readonly ok: true;
			/** Horário efetivo do envio (já normalizado para janela/cota). */
			readonly scheduledFor: Date;
			/** `null` = a mensagem já estava na fila com a mesma chave. */
			readonly outboxId: string | null;
			readonly duplicado: boolean;
	  }
	| {
			readonly ok: false;
			readonly erro: "conversa_nao_encontrada" | "limite_diario";
	  };

export type RespostaAgendamento = "confirmar" | "remarcar" | "cancelar";

export type RespostaAgendamentoResultado =
	| { readonly tratado: "erro"; readonly erro: "conversa_nao_encontrada" }
	| { readonly tratado: "confirmado"; readonly pendenciasEncerradas: number }
	| {
			readonly tratado: "handoff";
			readonly disparado: boolean;
			readonly handoffId: string | null;
			readonly pendenciasEncerradas: number;
	  };

/** `DD/MM` no fuso da operação — a data que o lead lê na mensagem. */
const dataCurta = (instante: Date, tz: string): string =>
	new Intl.DateTimeFormat("pt-BR", {
		timeZone: tz,
		day: "2-digit",
		month: "2-digit",
	}).format(instante);

/**
 * Instantes vindos de `sql` cru chegam como texto (o `execute` do Drizzle não
 * aplica o mapper da coluna). Lemos epoch no SQL e reconstruímos o `Date` —
 * imune ao fuso da sessão do PostgreSQL, ao contrário de `new Date(texto)`.
 */
const comoInstante = (epoca: number | string): Date =>
	new Date(Number(epoca) * 1000);

const formatadorDia = (tz: string): Intl.DateTimeFormat =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});

/**
 * Texto da mensagem — vocabulário deliberadamente fora de qualquer gatilho do
 * gate: não fala de preço/mídia/automação e descreve o encontro sem "agendar",
 * "marcar", "reunião" nem horário no formato que o gate de pós-envio varre.
 */
const textoAgendamento = (
	tipo: TipoAgendamento,
	quando: Date,
	tz: string,
): string => {
	const data = dataCurta(quando, tz);
	const hora = formatarHoraLocal(quando, tz);
	return tipo === "confirmacao"
		? `Só para confirmar: nosso encontro fica em ${data}, ${hora}. Se precisar mudar, é só avisar por aqui.`
		: `Lembrete: nosso encontro é em ${data}, ${hora}. Qualquer imprevisto, me avisa por aqui.`;
};

/**
 * Ocupação do dia alvo: envios já enfileirados (pending/reserved) mais o
 * contador de enviados — quando o dia alvo é hoje.
 *
 * O agrupamento é feito em JS, não em SQL: `outbox.scheduled_for` é `timestamp`
 * sem fuso, então `date(...)` em SQL dependeria do TimeZone da sessão. O
 * instante já faz roundtrip (driver + sessão preservam o epoch) e o dia é
 * calculado com o MESMO fuso do resto da aplicação (`env.TZ`). A fila é pequena
 * por construção (teto de R-023), então varrer é barato.
 */
const ocupacaoDoDia = async (
	db: Db,
	alvo: Date,
	formato: Intl.DateTimeFormat,
	incluirEnviadas: boolean,
): Promise<number> => {
	const diaAlvo = formato.format(alvo);
	const fila = await db.execute(sql`
		select extract(epoch from scheduled_for) as epoca from outbox
		where status in ('pending', 'reserved')
	`);
	const rows = (fila as unknown as { rows: { epoca: number | string }[] }).rows;
	let total = rows.filter(
		(r) => formato.format(comoInstante(r.epoca)) === diaAlvo,
	).length;
	if (incluirEnviadas) {
		const enviadas = await db.execute(sql`
			select count from daily_counters where day = ${diaAlvo} and kind = 'sent'
		`);
		total +=
			(enviadas as unknown as { rows: { count: number }[] }).rows[0]?.count ??
			0;
	}
	return total;
};

/** Lê a pendência viva de um tipo; `null` = não existe. */
const lerPendente = async (
	db: Db,
	conversationId: string,
	tipo: TipoAgendamento,
): Promise<Date | null> => {
	const resultado = await db.execute(sql`
		select extract(epoch from scheduled_for) as epoca from scheduled_tasks
		where conversation_id = ${conversationId}
			and follow_up_index = ${INDICE[tipo]}
			and status = 'pending'
	`);
	const linha = (resultado as unknown as { rows: { epoca: number | string }[] })
		.rows[0];
	return linha ? comoInstante(linha.epoca) : null;
};

/**
 * Grava a pendência no ledger e devolve o horário VIGENTE.
 *
 * Primeiro agendamento vence: se já existe pendência do mesmo tipo no futuro,
 * ela é a verdade (o Admin repetiu o registro; não sobrescrevemos o que já foi
 * combinado). Pendência JÁ VENCIDA (o job saiu ou o gate a abandonou) é
 * encerrada para que uma segunda reunião possa ser registrada — sem isso, a
 * confirmação da próxima reunião ficaria travada para sempre.
 */
const gravarPendente = async (
	db: Db,
	conversationId: string,
	tipo: TipoAgendamento,
	alvo: Date,
	agora: Date,
): Promise<Date> => {
	const tentarInserir = async (): Promise<Date | null> => {
		const inserida = await db.execute(sql`
			insert into scheduled_tasks (
				conversation_id, task_type, scheduled_for, follow_up_index
			)
			values (${conversationId}, ${tipo}, ${alvo}, ${INDICE[tipo]})
			on conflict (conversation_id, follow_up_index) where status = 'pending'
			do nothing
			returning extract(epoch from scheduled_for) as epoca
		`);
		const linha = (
			inserida as unknown as { rows: { epoca: number | string }[] }
		).rows[0];
		return linha ? comoInstante(linha.epoca) : null;
	};

	const inserido = await tentarInserir();
	if (inserido) return inserido;

	const existente = await lerPendente(db, conversationId, tipo);
	if (!existente) return alvo; // corrida extrema: saiu entre INSERT e SELECT
	if (existente.getTime() > agora.getTime()) return existente;

	await db.execute(sql`
		update scheduled_tasks
		set status = 'done'
		where conversation_id = ${conversationId}
			and follow_up_index = ${INDICE[tipo]}
			and status = 'pending'
	`);
	const reInserido = await tentarInserir();
	if (reInserido) return reInserido;
	return (await lerPendente(db, conversationId, tipo)) ?? alvo;
};

/**
 * Agenda a confirmação ou o lembrete de uma reunião registrada pelo Admin.
 *
 * Ordem: conversa existe → normaliza janela → ajusta cota → grava o ledger →
 * enfileira no `outbox` com chave idempotente ancorada no horário efetivo.
 * Re-executar com os mesmos argumentos devolve `duplicado: true` (o `enqueue`
 * devolve `null` — a linha já existe) e NÃO duplica a mensagem.
 */
export const agendarConfirmacao = async (
	db: Db,
	input: AgendarInput,
	deps: AgendarDeps = {},
): Promise<AgendamentoResultado> => {
	const tz = deps.tz ?? env.TZ;
	const inicio = deps.inicioJanela ?? env.WINDOW_START_HOUR;
	const fim = deps.fimJanela ?? env.WINDOW_END_HOUR;
	const feriados = deps.feriados ?? [];
	const limite = deps.limite ?? env.DAILY_MESSAGE_LIMIT;
	const agora = deps.agora?.() ?? new Date();

	const existe = await db.execute(
		sql`select id from conversations where id = ${input.conversationId}`,
	);
	if ((existe as unknown as { rows: unknown[] }).rows.length === 0) {
		return { ok: false, erro: "conversa_nao_encontrada" };
	}

	// 1) Janela (R-006): fora de dia útil 7h–17h → próxima janela útil às 07:00.
	let alvo =
		ehDiaUtil(input.quando, tz, feriados) &&
		isWithinWindow(input.quando, tz, inicio, fim)
			? input.quando
			: nextWindow(input.quando, tz, inicio, fim, feriados);

	// 2) Cota (R-023): dia alvo cheio empurra para a próxima janela — nunca
	// acumula (um lembrete para depois da reunião é pior que um dia depois).
	const formato = formatadorDia(tz);
	const diaDeHoje = formato.format(agora);
	let cheio = false;
	for (let passo = 0; passo < 14; passo += 1) {
		const ocupacao = await ocupacaoDoDia(
			db,
			alvo,
			formato,
			formato.format(alvo) === diaDeHoje,
		);
		if (ocupacao < limite) {
			cheio = false;
			break;
		}
		cheio = true;
		alvo = nextWindow(new Date(alvo.getTime() + 1), tz, inicio, fim, feriados);
	}
	if (cheio) {
		return { ok: false, erro: "limite_diario" };
	}

	// 3) Ledger (um pendente por tipo por conversa) e fila de envio.
	const agendadoEm = await gravarPendente(
		db,
		input.conversationId,
		input.tipo,
		alvo,
		agora,
	);

	const outboxId = await enqueue(db, {
		conversationId: input.conversationId,
		origin: "bot",
		body: textoAgendamento(input.tipo, agendadoEm, tz),
		idempotencyKey: `agend:${input.conversationId}:${input.tipo}:${agendadoEm.getTime()}`,
		scheduledFor: agendadoEm,
	});

	await registrarEvento(db, {
		eventType: "agendamento_programado",
		entityType: "conversation",
		entityId: input.conversationId,
		conversationId: input.conversationId,
		payload: {
			tipo: input.tipo,
			scheduledFor: agendadoEm.toISOString(),
			duplicado: outboxId === null,
		},
	});

	return {
		ok: true,
		scheduledFor: agendadoEm,
		outboxId,
		duplicado: outboxId === null,
	};
};

/** Encerra pendências de agendamento da conversa; devolve quantas fecharam. */
const encerrarPendentes = async (
	db: Db,
	conversationId: string,
	acao: "confirmar" | "abandonar",
	motivo: string | null,
	agora: Date,
): Promise<number> => {
	const resultado =
		acao === "confirmar"
			? await db.execute(sql`
					update scheduled_tasks
					set status = 'done'
					where conversation_id = ${conversationId}
						and task_type in ('confirmacao', 'lembrete')
						and status = 'pending'
					returning id
				`)
			: await db.execute(sql`
					update scheduled_tasks
					set status = 'abandoned',
						cancelled_at = ${agora},
						cancelled_reason = ${motivo}
					where conversation_id = ${conversationId}
						and task_type in ('confirmacao', 'lembrete')
						and status = 'pending'
					returning id
				`);
	return (resultado as unknown as { rows: unknown[] }).rows.length;
};

/**
 * Trata a resposta do lead sobre a reunião registrada.
 *
 * - `confirmar` → encerra as pendências (a confirmação foi dada; não se
 *   confirma de novo) e devolve `confirmado`. NAO envia nada sozinho.
 * - `remarcar` / `cancelar` → NUNCA tratado pelo bot (R-025): abandona as
 *   pendências (o lembrete do horário antigo não deve sair) e dispara handoff
 *   com o excerpt da resposta — o Admin assume com o contexto.
 *
 * A conversa é pré-checada antes de qualquer escrita: `event_log` e
 * `scheduled_tasks` têm FK para ela, e um 404 limpo é melhor que um erro de
 * driver.
 */
export const tratarRespostaAgendamento = async (
	db: Db,
	input: {
		readonly conversationId: string;
		readonly resposta: RespostaAgendamento;
	},
	deps: Pick<AgendarDeps, "agora"> = {},
): Promise<RespostaAgendamentoResultado> => {
	const agora = deps.agora?.() ?? new Date();

	const existe = await db.execute(
		sql`select id from conversations where id = ${input.conversationId}`,
	);
	if ((existe as unknown as { rows: unknown[] }).rows.length === 0) {
		return { tratado: "erro", erro: "conversa_nao_encontrada" };
	}

	if (input.resposta === "confirmar") {
		const encerradas = await encerrarPendentes(
			db,
			input.conversationId,
			"confirmar",
			null,
			agora,
		);
		await registrarEvento(db, {
			eventType: "agendamento_confirmado",
			entityType: "conversation",
			entityId: input.conversationId,
			conversationId: input.conversationId,
			payload: { pendenciasEncerradas: encerradas },
		});
		return { tratado: "confirmado", pendenciasEncerradas: encerradas };
	}

	const encerradas = await encerrarPendentes(
		db,
		input.conversationId,
		"abandonar",
		`lead pediu ${input.resposta.toUpperCase()} do agendamento (R-025)`,
		agora,
	);

	const handoff = await dispararHandoff(db, {
		conversationId: input.conversationId,
		reason: `lead pediu ${input.resposta.toUpperCase()} do agendamento (R-025)`,
		triggeredBy: "intent",
		triggerDetail: `agendamento:${input.resposta}`,
		excerpt: `resposta do lead: ${input.resposta}`,
		actor: "bot",
		agora,
	});

	return {
		tratado: "handoff",
		disparado: handoff.disparado,
		handoffId: handoff.handoffId,
		pendenciasEncerradas: encerradas,
	};
};
