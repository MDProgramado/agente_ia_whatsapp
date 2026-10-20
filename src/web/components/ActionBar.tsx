import {
	Bot,
	Check,
	CircleAlert,
	Clock,
	Hand,
	LoaderCircle,
	MicOff,
	Pause,
	Send,
	Undo2,
} from "lucide-react";
import type { RefObject } from "react";
import type { ConversaDetalhe, DesfechoDispatch, ResumoSistema } from "../api";

/**
 * Compositor + ações rápidas (UI-SPEC §Composer / §Component Inventory).
 *
 * O botão **Enviar** é a única forma de enviar texto do painel: ele chama
 * `POST /api/dispatch` (`origin='admin'` fixado pelo servidor) e o **gate
 * decide** `sent` / `blocked` / `deferred` / `silencio`. A UI nunca presume que
 * a mensagem saiu (D-24).
 *
 * As ações rápidas (Pausar / Assumir / Devolver ao bot / Copiloto) são overrides
 * explícitos auditados em `POST /api/conversations/:id/actions`.
 *
 * Motivos de desabilitação do Enviar com tooltip obrigatório (UI-SPEC).
 */
export type AcaoRapida = "pausar" | "assumir" | "devolver" | "copiloto";

export interface ActionBarProps {
	readonly conversa: ConversaDetalhe | null;
	readonly resumo: ResumoSistema | null;
	readonly texto: string;
	readonly enviando: boolean;
	readonly resultado: DesfechoDispatch | null;
	readonly campoRef: RefObject<HTMLTextAreaElement | null>;
	readonly onTexto: (texto: string) => void;
	readonly onEnviar: () => void;
	readonly onAcao: (acao: AcaoRapida) => void;
}

const emSilencio = (conversa: ConversaDetalhe | null): boolean => {
	if (conversa === null) return false;
	return (
		conversa.handoffActive ||
		conversa.engagementMode === "human" ||
		conversa.engagementMode === "awaiting_human"
	);
};

/** Motivo de desabilitação do Enviar, em ordem de prioridade. */
const motivoDesabilitado = (
	conversa: ConversaDetalhe | null,
	resumo: ResumoSistema | null,
	texto: string,
	enviando: boolean,
): string | null => {
	if (conversa === null) return "Selecione uma conversa para responder.";
	if (enviando) return "Enviando…";
	if (resumo?.mode === "paused") return "Automação pausada (kill switch)";
	if (emSilencio(conversa))
		return "Handoff ativo — assuma a conversa para responder";
	if (resumo !== null && !resumo.window.aberta)
		return "Fora da janela (dias úteis 7h–17h)";
	if (resumo !== null && resumo.counters.sent >= resumo.counters.sentLimit) {
		return "Cota diária atingida — a mensagem ficará na fila do próximo dia útil";
	}
	if (texto.trim() === "") return "Digite uma mensagem.";
	return null;
};

const ACOES: readonly {
	acao: AcaoRapida;
	texto: string;
	Icone: typeof Bot;
	destaque?: boolean;
}[] = [
	{ acao: "assumir", texto: "Assumir", Icone: Hand, destaque: true },
	{ acao: "devolver", texto: "Devolver ao bot", Icone: Undo2 },
	{ acao: "copiloto", texto: "Copiloto", Icone: Bot },
	{ acao: "pausar", texto: "Pausar", Icone: Pause },
];

const formatarData = (iso: string): string => {
	const data = new Date(iso);
	if (Number.isNaN(data.getTime())) return iso;
	return data.toLocaleString("pt-BR", {
		dateStyle: "short",
		timeStyle: "short",
	});
};

function Resultado({ desfecho }: { desfecho: DesfechoDispatch }) {
	if (desfecho.action === "sent") {
		return (
			<span className="flex items-center gap-xs text-sm text-ativo">
				<Check className="size-4" aria-hidden="true" />
				Mensagem enviada.
			</span>
		);
	}
	if (desfecho.action === "deferred") {
		return (
			<span className="flex items-center gap-xs text-sm text-pausa">
				<Clock className="size-4" aria-hidden="true" />
				Fila: será enviada em {formatarData(desfecho.scheduledFor)}.
			</span>
		);
	}
	if (desfecho.action === "blocked") {
		return (
			<span className="flex items-start gap-xs text-sm text-perigo">
				<CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				<span>
					Bloqueado pelo gate: {desfecho.reason}
					{desfecho.detail !== undefined && desfecho.detail !== ""
						? ` — ${desfecho.detail}`
						: ""}
				</span>
			</span>
		);
	}
	return (
		<span className="flex items-center gap-xs text-sm text-suave">
			<MicOff className="size-4" aria-hidden="true" />
			Silêncio: {desfecho.reason}
		</span>
	);
}

export function ActionBar({
	conversa,
	resumo,
	texto,
	enviando,
	resultado,
	campoRef,
	onTexto,
	onEnviar,
	onAcao,
}: ActionBarProps) {
	const motivo = motivoDesabilitado(conversa, resumo, texto, enviando);

	return (
		<div className="flex flex-col gap-sm border-t border-borda bg-superficie p-md">
			{resultado !== null ? <Resultado desfecho={resultado} /> : null}

			<div className="flex items-end gap-sm">
				<textarea
					ref={campoRef}
					value={texto}
					onChange={(evento) => onTexto(evento.target.value)}
					onKeyDown={(evento) => {
						if (evento.key === "Enter" && (evento.ctrlKey || evento.metaKey)) {
							evento.preventDefault();
							if (motivo === null) onEnviar();
						}
					}}
					disabled={conversa === null || enviando}
					rows={3}
					placeholder={
						conversa === null
							? "Selecione uma conversa para responder."
							: "Escreva a resposta…"
					}
					aria-label="Mensagem para o lead"
					title={motivo ?? "Ctrl+Enter envia"}
					className="rolagem-fina min-h-20 flex-1 resize-y rounded border border-borda bg-fundo p-sm text-sm outline-none placeholder:text-suave focus-visible:ring-2 focus-visible:ring-acento disabled:opacity-50"
				/>
				<button
					type="button"
					onClick={onEnviar}
					disabled={motivo !== null}
					title={motivo ?? "Enviar pelo gate"}
					className="flex h-10 items-center gap-xs rounded bg-acento px-md font-semibold text-slate-50 hover:bg-acento-suave disabled:cursor-not-allowed disabled:opacity-40"
				>
					{enviando ? (
						<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
					) : (
						<Send className="size-4" aria-hidden="true" />
					)}
					Enviar
				</button>
			</div>

			<div className="flex flex-wrap items-center gap-xs">
				<span className="mr-xs text-sm text-suave">Ações:</span>
				{ACOES.map(({ acao, texto: rotulo, Icone, destaque }) => (
					<button
						key={acao}
						type="button"
						onClick={() => onAcao(acao)}
						disabled={conversa === null || enviando}
						title={`Ação rápida: ${rotulo}`}
						className={`flex h-9 items-center gap-xs rounded border px-sm text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
							destaque === true
								? "border-handoff/60 text-handoff hover:bg-handoff/10"
								: "border-borda hover:bg-superficie-alta"
						}`}
					>
						<Icone className="size-4" aria-hidden="true" />
						{rotulo}
					</button>
				))}
			</div>
		</div>
	);
}
