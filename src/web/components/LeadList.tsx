import { CircleAlert, Inbox, RefreshCw, Search, Users } from "lucide-react";
import type { KeyboardEvent as EventoTeclado } from "react";
import { useCallback, useMemo, useRef } from "react";
import type { ResumoLead } from "../api";

/**
 * Lista de leads (coluna esquerda, UI-SPEC §Component Inventory).
 *
 * Busca server-side por nome/telefone (D-22), navegação por teclado
 * (`ArrowUp`/`ArrowDown` movem a seleção E o foco real do DOM) e ordenação por
 * prioridade: handoff pendente no topo, depois atividade recente (ADR-011 §6.8).
 *
 * Cada item é um `<button>` real: o foco move de verdade, então não há
 * `role="listbox"` nem `aria-activedescendant` — o estado selecionado é
 * exposto por `aria-current`. O item mostra dot de status + nome + telefone +
 * origem.
 */
export interface LeadListProps {
	readonly leads: readonly ResumoLead[];
	readonly selecionadoId: string | null;
	readonly busca: string;
	readonly carregando: boolean;
	readonly erro: string | null;
	readonly onBusca: (termo: string) => void;
	readonly onSelecionar: (lead: ResumoLead) => void;
	readonly onRecarregar: () => void;
}

const instante = (iso: string | null): number => {
	if (iso === null) return 0;
	const t = new Date(iso).getTime();
	return Number.isNaN(t) ? 0 : t;
};

const ordenarPorPrioridade = (leads: readonly ResumoLead[]): ResumoLead[] =>
	[...leads].sort((a, b) => {
		if (a.handoffActive !== b.handoffActive) return a.handoffActive ? -1 : 1;
		const atv = Math.max(instante(a.lastInboundAt), instante(a.lastOutboundAt));
		const btv = Math.max(instante(b.lastInboundAt), instante(b.lastOutboundAt));
		return btv - atv;
	});

const nomeDoLead = (lead: ResumoLead): string => lead.name ?? lead.phoneNumber;

export function LeadList({
	leads,
	selecionadoId,
	busca,
	carregando,
	erro,
	onBusca,
	onSelecionar,
	onRecarregar,
}: LeadListProps) {
	const ordenados = useMemo(() => ordenarPorPrioridade(leads), [leads]);

	const listaRef = useRef<HTMLUListElement | null>(null);

	const navegar = useCallback(
		(evento: EventoTeclado<HTMLButtonElement>, indice: number): void => {
			const passo =
				evento.key === "ArrowDown" ? 1 : evento.key === "ArrowUp" ? -1 : 0;
			if (passo === 0) return;
			evento.preventDefault();
			const alvo = indice + passo;
			if (alvo < 0 || alvo >= ordenados.length) return;
			const proximo = ordenados[alvo];
			if (proximo === undefined) return;
			onSelecionar(proximo);
			// move o foco real do DOM para o item recém-selecionado
			const botoes =
				listaRef.current?.querySelectorAll<HTMLButtonElement>("li > button");
			botoes?.[alvo]?.focus();
		},
		[ordenados, onSelecionar],
	);

	return (
		<section aria-label="Leads" className="flex min-h-0 flex-col bg-superficie">
			<div className="flex items-center gap-xs border-b border-borda px-md py-sm">
				<Search className="size-4 text-suave" aria-hidden="true" />
				<input
					type="search"
					value={busca}
					onChange={(evento) => onBusca(evento.target.value)}
					placeholder="Buscar por nome ou telefone"
					aria-label="Buscar leads"
					className="w-full rounded border border-borda bg-fundo px-sm py-xs text-sm outline-none placeholder:text-suave focus-visible:ring-2 focus-visible:ring-acento"
				/>
			</div>

			{erro !== null ? (
				<div className="flex items-center gap-xs border-b border-perigo/40 bg-perigo/10 px-md py-sm text-sm">
					<CircleAlert className="size-4 text-perigo" aria-hidden="true" />
					<span className="flex-1">{erro}</span>
					<button
						type="button"
						onClick={onRecarregar}
						className="flex items-center gap-xs rounded border border-borda px-sm py-xs hover:bg-superficie-alta"
					>
						<RefreshCw className="size-3.5" aria-hidden="true" />
						Tentar de novo
					</button>
				</div>
			) : null}

			{carregando && ordenados.length === 0 ? (
				<div className="flex flex-1 flex-col gap-sm p-md" aria-hidden="true">
					{[0, 1, 2, 3, 4].map((n) => (
						<div
							key={n}
							className="h-12 animate-pulse rounded bg-superficie-alta"
						/>
					))}
				</div>
			) : null}

			{!carregando && ordenados.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-sm p-lg text-center">
					<Users className="size-8 text-suave" aria-hidden="true" />
					{erro !== null ? null : busca !== "" ? (
						<>
							<p className="text-sm font-semibold">
								Nenhum lead encontrado para “{busca}”.
							</p>
							<p className="text-sm text-suave">
								Ajuste os filtros ou tente outro termo.
							</p>
						</>
					) : (
						<>
							<p className="text-sm font-semibold">Nenhum lead ainda</p>
							<p className="text-sm text-suave">
								Importe leads da API de caça-leads ou aguarde a ingestão do dia.
								O primeiro contato é sempre manual — o bot nunca inicia
								conversa.
							</p>
						</>
					)}
				</div>
			) : null}

			<ul
				ref={listaRef}
				aria-label="Lista de leads"
				className="rolagem-fina min-h-0 flex-1 overflow-y-auto"
			>
				{ordenados.map((lead, indice) => {
					const ativo = lead.id === selecionadoId;
					return (
						<li key={lead.id}>
							<button
								type="button"
								aria-current={ativo ? "true" : undefined}
								onClick={() => onSelecionar(lead)}
								onKeyDown={(evento) => navegar(evento, indice)}
								className={`flex h-14 w-full flex-col justify-center gap-xs border-l-2 px-md text-left hover:bg-superficie-alta ${
									ativo
										? "border-l-acento bg-superficie-alta"
										: "border-l-transparent"
								}`}
							>
								<span className="flex items-center gap-xs">
									{lead.handoffActive ? (
										<Inbox
											className="size-3.5 text-handoff"
											aria-hidden="true"
										/>
									) : (
										<span
											className={`size-2 rounded-full ${
												lead.optOut ? "bg-perigo" : "bg-suave"
											}`}
											aria-hidden="true"
										/>
									)}
									<span className="truncate text-sm font-semibold">
										{nomeDoLead(lead)}
									</span>
								</span>
								<span className="flex items-center gap-xs truncate text-sm text-suave">
									<span className="tabular-nums">{lead.phoneNumber}</span>
									<span aria-hidden="true">·</span>
									<span>{rotuloEstado(lead)}</span>
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/** Rótulo pt-BR do estado do lead (nunca só cor). */
const rotuloEstado = (lead: ResumoLead): string => {
	if (lead.optOut) return "Opt-out";
	if (lead.handoffActive) return "Handoff";
	if (lead.state === null) return "Sem conversa";
	const mapa: Record<string, string> = {
		novo: "Novo",
		aquecimento: "Aquecimento",
		qualificando: "Qualificando",
		aquecido: "Aquecido",
		awaiting_human: "Aguardando você",
		human: "Com você",
		copilot: "Copiloto",
		pausado: "Pausado",
		encerrado: "Encerrado",
	};
	return mapa[lead.state] ?? lead.state;
};
