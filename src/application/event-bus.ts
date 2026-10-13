/**
 * Barramento de eventos tipado — três canais: `inbound`, `signal`, `clock`.
 *
 * A regra que dá sentido ao arquivo: **não engolir exceção**. Um handler que
 * falha grava a falha em `event_log` (a trilha append-only, R-022/R-045) e o
 * erro é REPROPAGADO. Engolir uma exceção de `inbound` é perder uma mensagem sem
 * rastro e deixar `conversations.last_processed_at` parada — o boot seguinte
 * reprocessa o histórico inteiro, gasta tokens e reenvia o que já saiu.
 *
 * Handlers rodam **sequencialmente por canal**, na ordem de inscrição: um canal
 * que processa mensagem não pode ter dois handlers correndo em paralelo sobre a
 * mesma conversa (duas gravações idempotentes em corrida é o caminho do
 * double-send, que é o que mais pesa contra o número).
 *
 * O `catch` da gravação da falha é o ÚNICO `catch` do arquivo, e ele não suprime
 * o erro original: se nem a gravação em `event_log` funcionar, o erro vai para o
 * log local e o erro do handler continua subindo.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../infra/db/client.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger("event_bus");

export type Canal = "inbound" | "signal" | "clock";

/** Evento de mensagem recebida (forma mínima do plano + campos que o handler usa). */
export interface EventoInbound {
	readonly fromMe: boolean | null | undefined;
	readonly chatId: string;
	readonly body: string;
	/** `text`/`link` seguem para `messages`; qualquer outro valor é mídia (AR-009). */
	readonly kind?: string;
	readonly providerMsgId?: string;
	readonly timestamp: number;
	/** E.164 já resolvido, quando o emissor souber; senão o handler resolve via JID. */
	readonly phoneNumber?: string;
	readonly isMedia?: boolean;
	readonly mediaType?: string | null;
	/** Sinal sintético de opt-out vindo da fonte; só ATIVA `opt_out`, nunca desativa. */
	readonly providerOptOut?: boolean;
}

export interface EventoSinal {
	readonly tipo: string;
	readonly mensagem: string;
	readonly detalhe?: unknown;
}

export interface EventoClock {
	readonly agora: Date;
}

export interface MapaEventos {
	readonly inbound: EventoInbound;
	readonly signal: EventoSinal;
	readonly clock: EventoClock;
}

export type Handler<C extends Canal> = (
	evento: MapaEventos[C],
) => void | Promise<void>;

export class BarramentoEventos {
	private readonly db: Db;
	private readonly assinantes: {
		inbound: Handler<"inbound">[];
		signal: Handler<"signal">[];
		clock: Handler<"clock">[];
	} = { inbound: [], signal: [], clock: [] };

	constructor(db: Db) {
		this.db = db;
	}

	on<C extends Canal>(canal: C, handler: Handler<C>): void {
		(this.assinantes[canal] as Handler<C>[]).push(handler);
	}

	/**
	 * Emite um evento para todos os handlers do canal, em ordem, aguardando cada um.
	 * A primeira falha interrompe o canal: grava em `event_log` e repropaga.
	 */
	async emit<C extends Canal>(canal: C, evento: MapaEventos[C]): Promise<void> {
		const lista = this.assinantes[canal] as Handler<C>[];
		for (const handler of lista) {
			try {
				await handler(evento);
			} catch (erro) {
				await this.registraFalha(canal, erro);
				throw erro;
			}
		}
	}

	/**
	 * Grava a falha do handler na trilha append-only. **Não suprime** o erro
	 * original — quem chama ainda lança. Se a própria gravação falhar, o erro vai
	 * para o log local e a exceção do handler continua.
	 */
	private async registraFalha(canal: Canal, erro: unknown): Promise<void> {
		const mensagem = erro instanceof Error ? erro.message : String(erro);
		try {
			await this.db.execute(sql`
				insert into event_log (event_type, entity_type, payload, severity)
				values (
					${`handler_${canal}_falhou`},
					'event_bus',
					${JSON.stringify({ canal, mensagem })}::jsonb,
					'error'
				)
			`);
		} catch (erroLog) {
			log.error(
				{
					event: "event_log_indisponivel",
					canal,
					motivo: erroLog instanceof Error ? erroLog.message : String(erroLog),
				},
				"nao consegui gravar a falha do handler em event_log",
			);
		}
		// Log estruturado SEM payload de conversa (redação de PII no logger).
		log.error(
			{ event: "handler_falhou", canal },
			`handler falhou: ${mensagem}`,
		);
	}
}
