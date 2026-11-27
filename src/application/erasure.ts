import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../infra/db/client.js";
import {
	conversations,
	eventLog,
	leads,
	optoutLedger,
} from "../infra/db/schema.js";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ApagarTitularInput {
	readonly leadId: string;
	readonly rawContent: string;
	readonly occurredAt?: Date;
}

export interface ApagarTitularResultado {
	readonly leadId: string;
	readonly conversasEncerradas: number;
	readonly camposAnonimizados: readonly string[];
}

const validar = (input: ApagarTitularInput, agora: Date): void => {
	if (!UUID.test(input.leadId)) {
		throw new Error(`leadId invalido: ${input.leadId}`);
	}
	if (input.rawContent.trim().length === 0) {
		throw new Error("rawContent nao pode ser vazio");
	}
	if (input.occurredAt && Number.isNaN(input.occurredAt.getTime())) {
		throw new Error("occurredAt invalido");
	}
	if (Number.isNaN(agora.getTime())) {
		throw new Error("agora invalido");
	}
};

export const apagarTitularNaTransacao = async (
	db: Db,
	input: ApagarTitularInput,
	agora: Date,
): Promise<ApagarTitularResultado> => {
	validar(input, agora);

	const lead = await db.query.leads.findFirst({
		where: eq(leads.id, input.leadId),
	});
	if (!lead) throw new Error(`lead nao encontrado: ${input.leadId}`);

	await db
		.update(leads)
		.set({
			optOut: true,
			name: null,
			addressLine: null,
			waJid: null,
			lid: null,
		})
		.where(eq(leads.id, lead.id));

	const encerradas = await db
		.update(conversations)
		.set({ state: "encerrado", closedReason: "opt_out" })
		.where(
			and(
				eq(conversations.leadId, lead.id),
				ne(conversations.state, "encerrado"),
			),
		)
		.returning({ id: conversations.id });

	await db.insert(optoutLedger).values({
		leadId: lead.id,
		eventType: "erasure_request",
		source: "manual",
		detectedBy: null,
		rawContent: input.rawContent.slice(0, 200),
		legalBasis: lead.legalBasis,
		purpose: lead.purpose,
		occurredAt: input.occurredAt ?? agora,
	});

	await db.insert(eventLog).values({
		eventType: "erasure_request",
		entityType: "lead",
		entityId: lead.id,
		leadId: lead.id,
		payload: {
			conversas_encerradas: encerradas.length,
			campos_anonimizados: ["name", "address_line", "wa_jid", "lid"],
			ocorrido_em: (input.occurredAt ?? agora).toISOString(),
		},
		severity: "info",
	});

	return {
		leadId: lead.id,
		conversasEncerradas: encerradas.length,
		camposAnonimizados: ["name", "address_line", "wa_jid", "lid"],
	};
};

export const apagarTitular = async (
	db: Db,
	input: ApagarTitularInput,
): Promise<ApagarTitularResultado> => {
	const agora = new Date();
	validar(input, agora);
	return db.transaction((tx) =>
		apagarTitularNaTransacao(tx as unknown as Db, input, agora),
	);
};
