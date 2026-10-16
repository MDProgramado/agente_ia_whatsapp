/**
 * Histórico de mensagens de uma conversa (R-043, D-23).
 *
 * READ-ONLY por contrato: `messages` é append-only (trigger `messages_append_only`
 * barra UPDATE/DELETE). A rota só lê, e a leitura é a "história imutável" que o
 * painel exibe ao lado da conversa.
 */
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { idParams } from "../schemas.js";
import type { PanelCore } from "../server.js";

/** Teto de leitura: o painel pede dezenas de mensagens, não a tabela inteira. */
const LIMITE_PADRAO = 50;
const LIMITE_TETO = 200;

interface LinhaMensagem {
	readonly id: string;
	readonly direction: string;
	readonly origin: string;
	readonly kind: string;
	readonly body: string;
	readonly status: string;
	readonly author_user_id: string | null;
	readonly created_at: string;
}

export const registrarMessages = (
	app: FastifyInstance,
	core: PanelCore,
): void => {
	app.get("/api/conversations/:id/messages", async (req, reply) => {
		const parsed = idParams.safeParse(req.params);
		if (!parsed.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}

		const limiteBruto = Number(
			(req.query as Record<string, unknown>).limit ?? LIMITE_PADRAO,
		);
		const limite = Number.isFinite(limiteBruto)
			? Math.min(Math.max(Math.trunc(limiteBruto), 1), LIMITE_TETO)
			: LIMITE_PADRAO;

		// Lê as MAIS RECENTES (`desc` + teto) e depois inverte: a UI mostra o
		// fim da conversa, com o histórico subindo. O `desc`+`limit` é o que
		// evita ler uma conversa longa inteira para exibir as últimas N.
		const resultado = await core.db.execute(sql`
			select
				id, direction, origin, kind, body, status, author_user_id, created_at
			from messages
			where conversation_id = ${parsed.data.id}
			order by created_at desc, id desc
			limit ${limite}
		`);

		const rows = (resultado as unknown as { rows: LinhaMensagem[] }).rows;
		const itens = rows.reverse().map((row) => ({
			id: row.id,
			direction: row.direction,
			origin: row.origin,
			kind: row.kind,
			body: row.body,
			status: row.status,
			authorUserId: row.author_user_id,
			createdAt: row.created_at,
		}));

		return { conversationId: parsed.data.id, itens };
	});
};
