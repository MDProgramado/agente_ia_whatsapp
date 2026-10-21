import { LoaderCircle, Send, ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";
import type { DesfechoDispatch, Mensagem } from "../api";
import { ApiError, apiPost } from "../api";
import { SuggestionCard } from "./SuggestionCard";

/**
 * Painel do copiloto (FLUP-06/CRM-03) — sugestão + ENVIO pelo gate.
 *
 * Duas garantias, nesta ordem:
 *
 *  1. **O copiloto NUNCA envia sozinho** (T-03-22). Aceitar e Editar só
 *     preenchem o campo do compositor; o envio é o clique explícito em
 *     **Enviar**, que é a ÚNICA chamada a `/api/dispatch` deste painel.
 *  2. **Um caminho de envio só** (NFRQ-05). O POST vai para o mesmo gate do
 *     resto do painel, com `origin='admin'` fixado pelo SERVIDOR — o cliente
 *     não forja origem. `blocked`/`deferred`/`silencio` são desfechos do gate,
 *     não erro de transporte: são exibidos, nunca engolidos.
 *
 * A `SuggestionCard` é REUTILIZADA (não reimplementada aqui): ela já é o
 * contrato visual do UI-SPEC e o teste de build do front garante que ela não
 * carrega caminho de envio.
 */

const mensagemDeErro = (causa: unknown): string => {
	if (causa instanceof ApiError) return causa.message;
	return causa instanceof Error ? causa.message : String(causa);
};

const descreverDesfecho = (desfecho: DesfechoDispatch): string => {
	switch (desfecho.action) {
		case "sent":
			return "Mensagem enviada pelo gate.";
		case "deferred":
			return `Envio adiado para ${desfecho.scheduledFor} — fora da janela operacional.`;
		case "blocked":
			return `Envio bloqueado pelo gate: ${desfecho.reason}. Nada foi enviado ao lead.`;
		case "silencio":
			return `O bot ficou em silêncio: ${desfecho.reason}.`;
	}
};

export interface CopilotPanelProps {
	readonly sugestao: Mensagem | null;
	readonly conversationId: string | null;
	/** Conteúdo atual do compositor. */
	readonly texto: string;
	readonly onAplicar: (texto: string, focar: boolean) => void;
	readonly onIgnorar: () => void;
	/** Disparado quando o gate confirma o envio. */
	readonly onEnviado: () => void;
}

export function CopilotPanel({
	sugestao,
	conversationId,
	texto,
	onAplicar,
	onIgnorar,
	onEnviado,
}: CopilotPanelProps) {
	const [enviando, setEnviando] = useState(false);
	const [erro, setErro] = useState<string | null>(null);
	const [resultado, setResultado] = useState<string | null>(null);

	const enviar = useCallback(async (): Promise<void> => {
		if (conversationId === null || texto.trim() === "") return;
		setEnviando(true);
		setErro(null);
		setResultado(null);
		try {
			// Único caminho de envio do painel — o gate decide.
			const desfecho = await apiPost<DesfechoDispatch>("/api/dispatch", {
				conversationId,
				text: texto.trim(),
			});
			setResultado(descreverDesfecho(desfecho));
			if (desfecho.action === "sent") onEnviado();
		} catch (causa) {
			setErro(mensagemDeErro(causa));
		} finally {
			setEnviando(false);
		}
	}, [conversationId, texto, onEnviado]);

	const aoEnviar = useCallback(() => void enviar(), [enviar]);

	return (
		<section
			aria-label="Copiloto"
			className="flex min-h-0 flex-col bg-superficie"
		>
			<SuggestionCard
				sugestao={sugestao}
				onAplicar={onAplicar}
				onIgnorar={onIgnorar}
			/>

			<div className="flex flex-col gap-xs border-t border-borda p-md">
				<div className="flex items-center gap-xs text-xs text-suave">
					<ShieldCheck className="size-4" aria-hidden="true" />O copiloto não
					envia sozinho: o envio é o seu clique em Enviar e passa pelo mesmo
					gate da automação.
				</div>
				<button
					type="button"
					disabled={conversationId === null || texto.trim() === "" || enviando}
					onClick={aoEnviar}
					className="flex h-9 items-center justify-center gap-xs rounded bg-acento px-md text-sm font-semibold text-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{enviando ? (
						<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
					) : (
						<Send className="size-4" aria-hidden="true" />
					)}
					Enviar
				</button>
				{erro !== null ? (
					<p
						role="alert"
						className="rounded border border-perigo/40 bg-perigo/10 px-sm py-xs text-sm"
					>
						{erro}
					</p>
				) : null}
				{resultado !== null ? (
					<p
						role="status"
						className="rounded border border-borda bg-fundo px-sm py-xs text-sm"
					>
						{resultado}
					</p>
				) : null}
			</div>
		</section>
	);
}
