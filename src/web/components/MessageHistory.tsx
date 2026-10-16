import { Ban, Sparkles } from "lucide-react";
import type { Mensagem } from "../api";

/**
 * Histórico imutável da conversa (R-043, D-23) — **somente leitura**.
 *
 * Nunca há botão de editar/excluir: a tabela `messages` é append-only e a UI
 * reflete isso (a verificação do plano conta zero rótulos de edição). Cada
 * linha mostra remetente (Você/Lead), timestamp tabular, origem, estado de
 * entrega e marca sugestões da IA e mensagens bloqueadas pelo gate.
 */
export interface MessageHistoryProps {
	readonly mensagens: readonly Mensagem[];
	readonly carregando: boolean;
}

const formatarHora = (iso: string): string => {
	const data = new Date(iso);
	if (Number.isNaN(data.getTime())) return "--:--";
	return data.toLocaleTimeString("pt-BR", {
		hour: "2-digit",
		minute: "2-digit",
	});
};

const REMETENTE: Record<string, string> = {
	in: "Lead",
	out: "Você",
};

const ROTULO_STATUS: Record<string, string> = {
	sent: "enviada",
	delivered: "entregue",
	read: "lida",
	failed: "falhou",
	suggested: "sugerida",
	blocked: "bloqueada",
	queued: "na fila",
	pending: "pendente",
};

export function MessageHistory({ mensagens, carregando }: MessageHistoryProps) {
	if (carregando && mensagens.length === 0) {
		return (
			<div className="flex flex-1 flex-col gap-sm p-lg" aria-hidden="true">
				{[0, 1, 2, 3].map((n) => (
					<div
						key={n}
						className={`h-10 animate-pulse rounded bg-superficie-alta ${n % 2 === 0 ? "mr-xl" : "ml-xl"}`}
					/>
				))}
			</div>
		);
	}

	return (
		<ol
			role="log"
			aria-label="Histórico da conversa"
			className="rolagem-fina flex min-h-0 flex-1 flex-col gap-sm overflow-y-auto p-lg"
		>
			{mensagens.map((mensagem) => {
				const entrada = mensagem.direction === "in";
				const sugerida =
					mensagem.status === "suggested" ||
					mensagem.origin === "ai_suggestion";
				const bloqueada = mensagem.status === "blocked";
				return (
					<li
						key={mensagem.id}
						className={`flex flex-col gap-xs ${entrada ? "items-start" : "items-end"}`}
					>
						<div
							className={`max-w-[75%] rounded-lg px-md py-sm text-sm ${
								entrada ? "bg-msg-entrada" : "bg-msg-saida text-slate-50"
							}`}
						>
							{mensagem.body}
						</div>
						<div className="flex items-center gap-xs text-sm text-suave">
							<span>{REMETENTE[mensagem.direction] ?? mensagem.direction}</span>
							<span aria-hidden="true">·</span>
							<span className="tabular-nums">
								{formatarHora(mensagem.createdAt)}
							</span>
							<span aria-hidden="true">·</span>
							<span>{ROTULO_STATUS[mensagem.status] ?? mensagem.status}</span>
							{sugerida ? (
								<span className="flex items-center gap-xs text-pausa">
									<Sparkles className="size-3.5" aria-hidden="true" />
									Sugestão do copiloto
								</span>
							) : null}
							{bloqueada ? (
								<span className="flex items-center gap-xs text-perigo">
									<Ban className="size-3.5" aria-hidden="true" />
									Bloqueada pelo gate
								</span>
							) : null}
						</div>
					</li>
				);
			})}
		</ol>
	);
}
