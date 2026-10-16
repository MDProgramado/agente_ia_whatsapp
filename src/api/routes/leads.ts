/**
 * Rotas de leitura de leads (R-046, D-22/D-23).
 *
 * Somente leitura: o painel consulta, nunca muta cadastro por aqui (a mutação de
 * lead vive no CRM/importador). A lista ordena por prioridade operacional —
 * handoff ativo primeiro, depois quem respondeu mais recentemente — que é "o que
 * o Admin precisa olhar agora".
 */
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { idParams, listarLeadsQuery } from "../schemas.js";
import type { PanelCore } from "../server.js";

interface LinhaLead {
	readonly id: string;
	readonly name: string | null;
	readonly phone_number: string;
	readonly origin_source: string | null;
	readonly opt_out: boolean;
	readonly legal_basis: string | null;
	readonly purpose: string | null;
	readonly legal_registered_at: string | null;
	readonly first_contact_by_human: boolean;
	readonly conversation_id: string | null;
	readonly state: string | null;
	readonly engagement_mode: string | null;
	readonly handoff_active: boolean | null;
	readonly last_inbound_at: string | null;
	readonly last_outbound_at: string | null;
}

const paraItem = (row: LinhaLead) => ({
	id: row.id,
	name: row.name,
	phoneNumber: row.phone_number,
	originSource: row.origin_source,
	optOut: row.opt_out,
	conversationId: row.conversation_id,
	state: row.state,
	engagementMode: row.engagement_mode,
	handoffActive: row.handoff_active ?? false,
	lastInboundAt: row.last_inbound_at,
	lastOutboundAt: row.last_outbound_at,
});

export const registrarLeads = (app: FastifyInstance, core: PanelCore): void => {
	app.get("/api/leads", async (req, reply) => {
		const parsed = listarLeadsQuery.safeParse(req.query);
		if (!parsed.success) {
			return reply.code(400).send({
				erro: "parametros invalidos",
				detalhes: parsed.error.issues.map((i) => i.message),
			});
		}
		const { q, status, page, pageSize } = parsed.data;
		const busca = q ?? null;
		const filtroStatus = status ?? null;
		const offset = (page - 1) * pageSize;

		const resultado = await core.db.execute(sql`
			select
				l.id,
				l.name,
				l.phone_number,
				l.origin_source,
				l.opt_out,
				l.legal_basis,
				l.purpose,
				l.legal_registered_at,
				l.first_contact_by_human,
				c.id             as conversation_id,
				c.state,
				c.engagement_mode,
				c.handoff_active,
				c.last_inbound_at,
				c.last_outbound_at
			from leads l
			left join conversations c on c.lead_id = l.id
			where (
				${busca}::text is null
				or l.name ilike '%' || ${busca} || '%'
				or l.phone_number like '%' || ${busca} || '%'
			)
			and (${filtroStatus}::text is null or c.state = ${filtroStatus})
			order by
				c.handoff_active desc nulls last,
				c.last_inbound_at desc nulls last,
				l.created_at desc
			limit ${pageSize} offset ${offset}
		`);

		const rows = (resultado as unknown as { rows: LinhaLead[] }).rows;
		return { page, pageSize, itens: rows.map(paraItem) };
	});

	app.get("/api/leads/:id", async (req, reply) => {
		const parsed = idParams.safeParse(req.params);
		if (!parsed.success) {
			return reply.code(400).send({ erro: "id invalido" });
		}

		const resultado = await core.db.execute(sql`
			select
				l.id,
				l.name,
				l.phone_number,
				l.origin_source,
				l.opt_out,
				l.legal_basis,
				l.purpose,
				l.legal_registered_at,
				l.first_contact_by_human,
				c.id             as conversation_id,
				c.state,
				c.engagement_mode,
				c.handoff_active,
				c.last_inbound_at,
				c.last_outbound_at
			from leads l
			left join conversations c on c.lead_id = l.id
			where l.id = ${parsed.data.id}
		`);

		const row = (resultado as unknown as { rows: LinhaLead[] }).rows[0];
		if (!row) {
			return reply.code(404).send({ erro: "lead nao encontrado" });
		}

		// Campos de compliance (LGPD, R-064) expostos junto do lead: o Admin
		// precisa ver a base legal e a finalidade no próprio cartão do lead.
		return {
			...paraItem(row),
			compliance: {
				legalBasis: row.legal_basis,
				purpose: row.purpose,
				legalRegisteredAt: row.legal_registered_at,
				firstContactByHuman: row.first_contact_by_human,
			},
		};
	});
};
