import { Hand, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import type { ConversaDetalhe, Mensagem } from "../api";
import { MessageHistory } from "./MessageHistory";

/**
 * Coluna central: cabeçalho da conversa + banner de handoff + histórico +
 * (via `children`) o compositor/barra de ações.
 *
 * O `children` é o slot do compositor — a `ActionBar` (Task 3) entra aqui sem
 * acoplar o painel de leitura ao mecanismo de envio. Sem lead selecionado, a
 * coluna mostra o estado vazio literal do Copywriting Contract.
 */
export interface ChatPaneProps {
	readonly conversa: ConversaDetalhe | null;
	readonly mensagens: readonly Mensagem[];
	readonly carregando: boolean;
	readonly motivoSilencio: string | null;
	readonly onAssumir?: () => void;
	readonly children?: ReactNode;
}

const ROTULO_ESTADO: Record<string, string> = {
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

export function ChatPane({
	conversa,
	mensagens,
	carregando,
	motivoSilencio,
	onAssumir,
	children,
}: ChatPaneProps) {
	if (conversa === null) {
		return (
			<section
				aria-label="Conversa"
				className="flex min-h-0 flex-1 flex-col items-center justify-center gap-sm bg-fundo p-xl text-center"
			>
				<MessageSquare className="size-8 text-suave" aria-hidden="true" />
				<h2 className="text-base font-semibold">
					Nenhuma conversa selecionada
				</h2>
				<p className="max-w-[42ch] text-sm text-suave">
					Selecione um lead na lista à esquerda para ver a conversa, as
					sugestões, o histórico e as ações rápidas.
				</p>
			</section>
		);
	}

	return (
		<section
			aria-label="Conversa"
			className="flex min-h-0 flex-1 flex-col bg-fundo"
		>
			<div className="flex items-center gap-sm border-b border-borda px-lg py-sm">
				<div className="flex flex-col">
					<span className="text-base font-semibold">
						{conversa.lead.name ?? conversa.lead.phoneNumber}
					</span>
					<span className="flex items-center gap-xs text-sm text-suave">
						<span className="tabular-nums">{conversa.lead.phoneNumber}</span>
						<span aria-hidden="true">·</span>
						<span>Origem: {conversa.lead.originSource}</span>
						<span aria-hidden="true">·</span>
						<span>{ROTULO_ESTADO[conversa.state] ?? conversa.state}</span>
					</span>
				</div>
			</div>

			{conversa.handoffActive ? (
				<div
					role="alert"
					className="flex items-center gap-sm border-b border-handoff/40 bg-handoff/10 px-lg py-sm text-sm"
				>
					<Hand className="size-4 text-handoff" aria-hidden="true" />
					<span className="flex-1">
						HANDOFF ACIONADO — Motivo: {motivoSilencio ?? "não informado"}. Bot
						em silêncio até você assumir.
					</span>
					{onAssumir !== undefined ? (
						<button
							type="button"
							onClick={onAssumir}
							className="flex h-9 items-center rounded border border-handoff/60 px-sm text-handoff hover:bg-handoff/20"
						>
							Assumir conversa
						</button>
					) : null}
				</div>
			) : null}

			<MessageHistory mensagens={mensagens} carregando={carregando} />

			{children}
		</section>
	);
}
