import { History, LoaderCircle, TriangleAlert } from "lucide-react";
import { isPipelineStatus, rotulo } from "../../domain/pipeline";
import { type LeadDetalhe, rotuloBaseLegal, rotuloFinalidade } from "../api";

/**
 * Resumo do lead selecionado na coluna direita (R-064).
 *
 * Tudo aqui vem de `GET /api/leads/:id` — nenhuma consulta extra. Mostra o
 * suficiente para o Admin responder "de onde veio este lead, sob qual base
 * legal, para qual finalidade e ele já pediu para sair?".
 */

export interface LeadHistoryPanelProps {
	readonly lead: LeadDetalhe | null;
	readonly carregando: boolean;
	readonly erro: string | null;
}

const formatarDataHora = (iso: string | null): string => {
	if (iso === null || iso === "") return "—";
	const data = new Date(iso);
	if (Number.isNaN(data.getTime())) return "—";
	return data.toLocaleString("pt-BR", {
		dateStyle: "short",
		timeStyle: "short",
	});
};

const rotuloPipeline = (valor: string | null): string => {
	if (valor === null || valor === "") return "Sem status de funil";
	return isPipelineStatus(valor) ? rotulo(valor) : valor;
};

export function LeadHistoryPanel({
	lead,
	carregando,
	erro,
}: LeadHistoryPanelProps) {
	return (
		<section
			aria-label="Resumo do lead selecionado"
			className="rounded-lg border border-borda bg-superficie p-md"
		>
			<h2 className="flex items-center gap-xs text-sm font-semibold">
				<History className="size-4 text-acento" aria-hidden="true" />
				Resumo do lead
			</h2>

			{carregando ? (
				<p className="mt-sm flex items-center gap-xs text-sm text-suave">
					<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
					Carregando resumo do lead…
				</p>
			) : null}

			{erro !== null ? (
				<p
					role="alert"
					className="mt-sm flex items-start gap-xs rounded border border-perigo/40 bg-perigo/10 px-sm py-xs text-sm"
				>
					<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
					<span>{erro}</span>
				</p>
			) : null}

			{!carregando && erro === null && lead === null ? (
				<p className="mt-sm text-sm text-suave">
					Selecione um lead para ver a origem, a base legal e o estado de
					opt-out.
				</p>
			) : null}

			{!carregando && erro === null && lead !== null ? (
				<dl className="mt-sm grid grid-cols-[auto_1fr] gap-x-md gap-y-xs text-sm">
					<dt className="text-suave">Lead</dt>
					<dd className="truncate">{lead.name ?? lead.phoneNumber}</dd>

					<dt className="text-suave">Funil</dt>
					<dd>{rotuloPipeline(lead.pipelineStatus)}</dd>

					<dt className="text-suave">Etiquetas</dt>
					<dd>
						{lead.tags.length === 0 ? (
							"—"
						) : (
							<span className="flex flex-wrap gap-xs">
								{lead.tags.map((tag) => (
									<span
										key={tag}
										className="rounded-full border border-borda px-sm py-px text-xs"
									>
										{tag}
									</span>
								))}
							</span>
						)}
					</dd>

					<dt className="text-suave">Origem</dt>
					<dd>{lead.originSource}</dd>

					<dt className="text-suave">Base legal</dt>
					<dd>{rotuloBaseLegal(lead.compliance.legalBasis)}</dd>

					<dt className="text-suave">Finalidade</dt>
					<dd>{rotuloFinalidade(lead.compliance.purpose)}</dd>

					<dt className="text-suave">Opt-out</dt>
					<dd>
						{lead.optOut
							? `Solicitado em ${formatarDataHora(lead.optOutAt)}`
							: "Não solicitado"}
					</dd>

					<dt className="text-suave">Última mensagem recebida</dt>
					<dd>{formatarDataHora(lead.lastInboundAt)}</dd>

					<dt className="text-suave">Última mensagem enviada</dt>
					<dd>{formatarDataHora(lead.lastOutboundAt)}</dd>
				</dl>
			) : null}
		</section>
	);
}
