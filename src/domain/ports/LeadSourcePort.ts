/**
 * Porta da fonte de leads (o "caça-leads", R-044).
 *
 * A fronteira existe para que a origem dos leads seja substituível: hoje um
 * adaptador fake (testes) e um adaptador HTTP; amanhã, outro provider. O
 * importador de banco (`src/application/lead-importer.ts`) conhece ESTA porta e
 * nunca HTTP — é o que mantém a regra "o importador não fala rede" verificável.
 *
 * As duas capabilities são OPCIONAIS de propósito (D-05): "não expõe" e "expõe e
 * devolve 0" levam a decisões opostas. Se `fetchNewChatMessageCap` não existir, o
 * limite de config governa; se existir e devolver `0`, o sistema PARA.
 */

/**
 * O lead como a fonte o entrega — antes de qualquer validação de negócio.
 *
 * `originSource`, `legalBasis` e `purpose` são `string` porque R-064 exige que a
 * AUSÊNCIA seja tratada no importador (lead sem lastro é rejeitado), não escondida
 * atrás de um `?`. A fonte pode mandar vazio/`undefined` em runtime; quem barra é
 * o importador, com `DadosIncompletos`.
 */
export interface Lead {
	/** E.164 (`+55…`). Validado pelo importador — não aqui. */
	readonly e164: string;
	readonly name?: string | null;
	readonly addressLine?: string | null;
	/** LGPD/R-064: procedência do lead. Obrigatório em runtime. */
	readonly originSource: string;
	/** LGPD/R-064: base legal. Obrigatório em runtime. */
	readonly legalBasis: string;
	/** LGPD/R-064: finalidade do tratamento. Obrigatório em runtime. */
	readonly purpose: string;
	/** Estado autoritativo é o do banco; este só pode ATIVAR, nunca desativar. */
	readonly optOut?: boolean;
	/** Payload cru da fonte, para o `optout_ledger.raw_content` (nunca em log). */
	readonly rawContent?: unknown;
}

export interface FetchNewLeadsOpts {
	/** Teto sugerido de itens por chamada; a fonte pode ignorar. */
	readonly limit?: number;
	/** Só leads criados/alterados depois deste instante, quando a fonte suportar. */
	readonly since?: Date;
}

export interface LeadSourcePort {
	/** Devolve a lista de leads novos a importar. Nunca lança por lista vazia. */
	fetchNewLeads(opts?: FetchNewLeadsOpts): Promise<Lead[]>;

	/**
	 * Sinaliza à fonte que o lead virou um contato válido (telefone confirmado).
	 * `void | Promise<void>`: a fonte fake é síncrona, a HTTP é assíncrona, e a
	 * diferença não deve vazar para o importador.
	 */
	markValidNewLead(e164: string): void | Promise<void>;

	/** Opcional. `null` = "não sei" (config governa); `0` = "o servidor mandou parar". */
	fetchNewChatMessageCap?(): Promise<number | null>;

	/** Opcional. Fim da restrição de reach-out, quando a fonte souber dizer. */
	fetchAccountReachoutTimelock?(): Promise<Date | null>;
}
