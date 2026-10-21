import {
	History,
	ListTodo,
	MessageSquare,
	NotebookPen,
	ShieldCheck,
	X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { isPipelineStatus, rotulo } from "../../domain/pipeline";
import type { LeadDetalhe, Mensagem } from "../api";
import {
	ApiError,
	buscarHistorico,
	rotuloBaseLegal,
	rotuloFinalidade,
} from "../api";
import { AuditTimeline } from "./AuditTimeline";
import { CompliancePanel } from "./CompliancePanel";
import { LeadNotes } from "./LeadNotes";
import { MessageHistory } from "./MessageHistory";
import { TaskList } from "./TaskList";

/**
 * Gaveta de detalhe do lead (wireframe §4, UI-SPEC §Component Inventory).
 *
 * `<dialog>` NATIVO com `showModal()`: focus-trap e `Esc` saem do próprio
 * elemento do navegador (UI-SPEC §Accessibility & Keyboard) — nada de
 * simular modal com `div`.
 *
 * O cabeçalho é o resumo do lead (nome, telefone, status do funil, etiquetas,
 * origem, base legal e finalidade) e as ABAS são as do wireframe: Conversa,
 * Notas, Tarefas, Histórico e Compliance. A aba Compliance concentra o
 * opt-out MANUAL com prova dupla (R-024/AR-005, R-064).
 *
 * A aba Conversa reaproveita o `MessageHistory` read-only do 03-04 e a aba
 * Histórico monta a `AuditTimeline` read-only do 03-06 — NADA aqui é
 * reimplementado, e nenhuma aba escreve histórico (D-23/R-043).
 */

type Aba = "conversa" | "notas" | "tarefas" | "historico" | "compliance";

interface DefinicaoAba {
	readonly id: Aba;
	readonly rotulo: string;
	readonly Icone: typeof MessageSquare;
}

/** As abas do wireframe §4 — a ordem é a do wireframe. */
const ABAS: readonly DefinicaoAba[] = [
	{ id: "conversa", rotulo: "Conversa", Icone: MessageSquare },
	{ id: "notas", rotulo: "Notas", Icone: NotebookPen },
	{ id: "tarefas", rotulo: "Tarefas", Icone: ListTodo },
	{ id: "historico", rotulo: "Histórico", Icone: History },
	{ id: "compliance", rotulo: "Compliance", Icone: ShieldCheck },
];

export interface LeadDetailDrawerProps {
	/** Lead em detalhe; `null` enquanto nada está aberto ou o fetch falhou. */
	readonly lead: LeadDetalhe | null;
	/** Gaveta aberta? O componente cuida de `showModal()`/`close()`. */
	readonly aberto: boolean;
	/** Detalhe do lead ainda sendo buscado. */
	readonly carregando: boolean;
	/** Falha ao buscar o detalhe do lead. */
	readonly erro: string | null;
	/** Fecha a gaveta (botão "Fechar" ou `Esc`). */
	readonly onFechar: () => void;
	/** "Ver conversa completa": fecha a gaveta e leva o lead ao chat principal. */
	readonly onAbrirConversaCompleta: (lead: LeadDetalhe) => void;
	/**
	 * Opt-out manual registrado no painel de compliance — o App re-sincroniza
	 * o lead (e a lista) com o servidor.
	 */
	readonly onRegistrarOptOut?: (leadId: string) => void;
}

const mensagemDeErro = (causa: unknown): string => {
	if (causa instanceof ApiError) return causa.message;
	return causa instanceof Error ? causa.message : String(causa);
};

/** Rótulo do status do funil (RN-078/D-14) — o valor cru nunca chega na tela. */
const rotuloFunil = (status: string | null): string => {
	if (status === null) return "Sem conversa";
	return isPipelineStatus(status) ? rotulo(status) : status;
};

export function LeadDetailDrawer({
	lead,
	aberto,
	carregando,
	erro,
	onFechar,
	onAbrirConversaCompleta,
	onRegistrarOptOut,
}: LeadDetailDrawerProps) {
	const dialogoRef = useRef<HTMLDialogElement | null>(null);
	const botoesRef = useRef<(HTMLButtonElement | null)[]>([]);
	const idTitulo = useId();
	const idAbas = useId();

	const [aba, setAba] = useState<Aba>("conversa");
	const [mensagens, setMensagens] = useState<readonly Mensagem[]>([]);
	const [carregandoMensagens, setCarregandoMensagens] = useState(false);
	const [erroMensagens, setErroMensagens] = useState<string | null>(null);

	const conversationId = lead?.conversationId ?? null;

	// `showModal()`/`close()` sãoeffects do estado `aberto` — o pai decide,
	// o componente só executa. O guard `!dialogo.open` evita o
	// `InvalidStateError` do `showModal()` em dialog já aberto (StrictMode).
	useEffect(() => {
		const dialogo = dialogoRef.current;
		if (dialogo === null) return;
		if (aberto && !dialogo.open) dialogo.showModal();
		if (!aberto && dialogo.open) dialogo.close();
	}, [aberto]);

	// Abrir sempre cai na aba Conversa: mostrar o histórico de outro lead em
	// cima da aba que o Admin deixou seria confuso.
	const leadId = lead?.id ?? null;
	useEffect(() => {
		if (leadId === null) return;
		setAba("conversa");
	}, [leadId]);

	const carregarMensagens = useCallback(async (): Promise<void> => {
		if (conversationId === null) {
			setMensagens([]);
			setErroMensagens(null);
			return;
		}
		setCarregandoMensagens(true);
		try {
			const historico = await buscarHistorico(conversationId);
			setMensagens(historico.itens);
			setErroMensagens(null);
		} catch (causa) {
			setErroMensagens(mensagemDeErro(causa));
		} finally {
			setCarregandoMensagens(false);
		}
	}, [conversationId]);

	useEffect(() => {
		void carregarMensagens();
	}, [carregarMensagens]);

	/** `Esc` fecha o `<dialog>` — o evento `close` avisa o pai. */
	const aoFechar = useCallback(() => {
		onFechar();
	}, [onFechar]);

	const aoEscolherAba = useCallback((id: Aba): void => setAba(id), []);

	/** Navegação por teclado do `tablist`: setas movem aba e foco real. */
	const moverAba = useCallback(
		(
			evento: {
				key: string;
				preventDefault: () => void;
			},
			indice: number,
		): void => {
			const passo =
				evento.key === "ArrowRight" ? 1 : evento.key === "ArrowLeft" ? -1 : 0;
			if (passo === 0) return;
			evento.preventDefault();
			const proximo = (indice + passo + ABAS.length) % ABAS.length;
			const alvo = ABAS[proximo];
			if (alvo === undefined) return;
			setAba(alvo.id);
			botoesRef.current[proximo]?.focus();
		},
		[],
	);

	const aoVerConversaCompleta = useCallback((): void => {
		if (lead === null) return;
		onAbrirConversaCompleta(lead);
	}, [lead, onAbrirConversaCompleta]);

	return (
		<dialog
			ref={dialogoRef}
			aria-labelledby={idTitulo}
			onClose={aoFechar}
			className="m-auto max-h-[85vh] w-[720px] rounded-lg border border-borda bg-superficie p-lg text-texto backdrop:bg-black/60"
		>
			{lead !== null ? (
				<>
					<div className="flex items-start gap-sm">
						{" "}
						<div className="flex min-w-0 flex-col">
							<h2 id={idTitulo} className="truncate text-base font-semibold">
								{lead.name ?? lead.phoneNumber}
							</h2>
							<span className="text-xs text-suave">{lead.phoneNumber}</span>
						</div>
						<button
							type="button"
							onClick={aoFechar}
							aria-label="Fechar detalhe do lead"
							className="ml-auto flex h-9 items-center gap-xs rounded border border-borda px-sm py-xs text-sm hover:bg-superficie-alta"
						>
							<X className="size-4" aria-hidden="true" />
							Fechar
						</button>
					</div>

					<dl className="mt-md grid grid-cols-2 gap-x-md gap-y-xs text-sm">
						<div className="flex flex-col">
							<dt className="text-xs uppercase tracking-wide text-suave">
								Status do funil
							</dt>
							<dd>{rotuloFunil(lead.pipelineStatus)}</dd>
						</div>
						<div className="flex flex-col">
							<dt className="text-xs uppercase tracking-wide text-suave">
								Origem
							</dt>
							<dd>{lead.originSource ?? "—"}</dd>
						</div>
						<div className="flex flex-col">
							<dt className="text-xs uppercase tracking-wide text-suave">
								Base legal
							</dt>
							<dd>{rotuloBaseLegal(lead.compliance.legalBasis)}</dd>
						</div>
						<div className="flex flex-col">
							<dt className="text-xs uppercase tracking-wide text-suave">
								Finalidade
							</dt>
							<dd>{rotuloFinalidade(lead.compliance.purpose)}</dd>
						</div>
						<div className="col-span-2 flex flex-col">
							<dt className="text-xs uppercase tracking-wide text-suave">
								Etiquetas
							</dt>
							<dd className="flex flex-wrap gap-xs">
								{lead.tags.length === 0 ? (
									<span className="text-suave">Sem etiquetas</span>
								) : (
									lead.tags.map((tag) => (
										<span
											key={tag}
											className="rounded border border-borda px-xs text-xs text-suave"
										>
											#{tag}
										</span>
									))
								)}
							</dd>
						</div>
					</dl>

					<div
						role="tablist"
						aria-label="Abas do detalhe do lead"
						className="mt-md flex gap-xs border-b border-borda pb-xs"
					>
						{ABAS.map((definicao, indice) => {
							const { Icone } = definicao;
							const ativa = definicao.id === aba;
							return (
								<button
									key={definicao.id}
									ref={(elemento) => {
										botoesRef.current[indice] = elemento;
									}}
									type="button"
									role="tab"
									id={`${idAbas}-${definicao.id}`}
									aria-selected={ativa}
									aria-controls={`${idAbas}-${definicao.id}-painel`}
									tabIndex={ativa ? 0 : -1}
									onClick={() => aoEscolherAba(definicao.id)}
									onKeyDown={(evento) => moverAba(evento, indice)}
									className={`flex h-9 items-center gap-xs px-md py-xs text-sm ${
										ativa
											? "rounded border border-acento bg-acento/10 font-semibold"
											: "rounded border border-transparent text-suave hover:bg-superficie-alta"
									}`}
								>
									<Icone className="size-3.5" aria-hidden="true" />
									{definicao.rotulo}
								</button>
							);
						})}
					</div>

					<div
						role="tabpanel"
						id={`${idAbas}-${aba}-painel`}
						aria-labelledby={`${idAbas}-${aba}`}
						className="mt-md max-h-[46vh] overflow-y-auto"
					>
						{aba === "conversa" ? (
							<>
								{erroMensagens !== null ? (
									<div
										role="alert"
										className="mb-sm rounded border border-perigo/40 bg-perigo/10 px-sm py-xs text-sm"
									>
										{erroMensagens}
									</div>
								) : null}
								{conversationId === null ? (
									<p className="text-sm text-suave">
										Este lead ainda não tem conversa.
									</p>
								) : (
									<MessageHistory
										mensagens={mensagens}
										carregando={carregandoMensagens}
									/>
								)}
							</>
						) : null}
						{aba === "notas" ? <LeadNotes leadId={lead.id} /> : null}
						{aba === "tarefas" ? <TaskList leadId={lead.id} /> : null}
						{aba === "historico" ? (
							<AuditTimeline conversationId={conversationId} />
						) : null}
						{aba === "compliance" ? (
							<CompliancePanel lead={lead} onRegistrado={onRegistrarOptOut} />
						) : null}
					</div>

					<div className="mt-md flex justify-end">
						<button
							type="button"
							onClick={aoVerConversaCompleta}
							className="h-9 rounded border border-borda px-md text-sm hover:bg-superficie-alta"
						>
							Ver conversa completa
						</button>
					</div>
				</>
			) : (
				<div className="flex flex-col gap-sm">
					{erro !== null ? (
						<div
							role="alert"
							className="rounded border border-perigo/40 bg-perigo/10 px-sm py-xs text-sm"
						>
							{erro}
						</div>
					) : null}
					{carregando ? (
						<div className="flex flex-col gap-sm" aria-hidden="true">
							{[0, 1, 2].map((n) => (
								<div
									key={n}
									className="h-9 animate-pulse rounded bg-superficie-alta"
								/>
							))}
						</div>
					) : null}
					{erro === null && !carregando ? (
						<p className="text-sm text-suave">
							Nenhum lead selecionado para detalhar.
						</p>
					) : null}
					<div className="flex justify-end">
						<button
							type="button"
							onClick={aoFechar}
							className="h-9 rounded border border-borda px-md text-sm hover:bg-superficie-alta"
						>
							Fechar
						</button>
					</div>
				</div>
			)}
		</dialog>
	);
}
