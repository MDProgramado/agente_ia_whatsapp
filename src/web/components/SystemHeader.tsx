import {
	AlertCircle,
	Bot,
	Inbox,
	MicOff,
	Pause,
	RefreshCw,
	ShieldAlert,
	UserCheck,
} from "lucide-react";
import type { ConversaDetalhe, ResumoSistema } from "../api";
import type { EstadoConexao } from "../useSse";
import { ConnectionIndicator } from "./ConnectionIndicator";

export interface SystemHeaderProps {
	readonly resumo: ResumoSistema | null;
	readonly conexao: EstadoConexao;
	readonly conversa: ConversaDetalhe | null;
	readonly motivoSilencio: string | null;
	readonly carregando: boolean;
	readonly onAtualizar: () => void;
	readonly onAbrirKillSwitch: () => void;
	readonly onAbrirEventos?: () => void;
}

type ModoPainel = "auto" | "copiloto" | "pausado" | "silencio";

/** Deriva o modo exibido da conversa selecionada, com o modo global como base. */
const modoDoPainel = (
	resumo: ResumoSistema | null,
	conversa: ConversaDetalhe | null,
): ModoPainel => {
	const modo = conversa?.engagementMode;
	if (
		conversa?.handoffActive === true ||
		modo === "human" ||
		modo === "awaiting_human"
	) {
		return "silencio";
	}
	if (modo === "copilot") return "copiloto";
	if (resumo?.mode === "paused") return "pausado";
	return "auto";
};

const ROTULOS: Record<
	ModoPainel,
	{ texto: string; classe: string; Icone: typeof Bot }
> = {
	auto: { texto: "BOT ATIVO", classe: "text-acento", Icone: Bot },
	copiloto: {
		texto: "COPILOTO — BOT NÃO ENVIA",
		classe: "text-pausa",
		Icone: UserCheck,
	},
	pausado: { texto: "BOT PAUSADO", classe: "text-suave", Icone: Pause },
	silencio: {
		texto: "MÃO HUMANA ATIVA — BOT EM SILÊNCIO",
		classe: "text-perigo",
		Icone: MicOff,
	},
};

/** Hora `HH:00` a partir do inteiro da janela (7 → "07:00"). */
const horaDaJanela = (hora: number): string =>
	`${String(hora).padStart(2, "0")}:00`;

const formatarProximaAbertura = (iso: string | null): string => {
	if (iso === null) return "próximo dia útil";
	const data = new Date(iso);
	if (Number.isNaN(data.getTime())) return "próximo dia útil";
	return data.toLocaleString("pt-BR", {
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
};

export function SystemHeader({
	resumo,
	conexao,
	conversa,
	motivoSilencio,
	carregando,
	onAtualizar,
	onAbrirKillSwitch,
	onAbrirEventos,
}: SystemHeaderProps) {
	const modo = modoDoPainel(resumo, conversa);
	const rotulo = ROTULOS[modo];
	const limiteAtingido =
		resumo !== null && resumo.counters.sent >= resumo.counters.sentLimit;
	const handoffs = resumo?.handoffQueue.length ?? 0;

	return (
		<header className="flex h-14 items-center gap-md border-b border-borda bg-superficie px-lg">
			<div className="flex items-center gap-xs">
				<Bot className="size-5 text-acento" aria-hidden="true" />
				<span className="text-sm font-semibold tracking-wide">
					AUTOMAÇÃO WHATSAPP
				</span>
			</div>

			<div
				className={`flex items-center gap-xs ${rotulo.classe}`}
				aria-live="polite"
				role="status"
			>
				<rotulo.Icone className="size-5" aria-hidden="true" />
				<span className="text-base font-semibold">{rotulo.texto}</span>
				{modo === "silencio" && motivoSilencio !== null ? (
					<span className="text-sm text-suave">Motivo: {motivoSilencio}</span>
				) : null}
			</div>

			<div className="ml-auto flex items-center gap-md text-sm">
				<span className="tabular-nums text-texto">
					Mensagens hoje: {resumo?.counters.sent ?? 0} /{" "}
					{resumo?.counters.sentLimit ?? 0}
				</span>
				<span className="tabular-nums text-suave">
					Contatos novos: {resumo?.counters.newContacts ?? 0}
				</span>
				<span className={limiteAtingido ? "text-pausa" : "text-ativo"}>
					{limiteAtingido
						? "Limite atingido — fila espera o próximo dia útil"
						: resumo?.window.aberta === true
							? `Janela aberta (fecha ${horaDaJanela(resumo.window.fim)})`
							: `Janela fechada (abre ${formatarProximaAbertura(resumo?.window.proximaAbertura ?? null)})`}
				</span>
				<span
					className={
						handoffs > 0
							? "flex items-center gap-xs text-handoff"
							: "flex items-center gap-xs text-suave"
					}
					title="Handoffs pendentes"
				>
					<Inbox className="size-4" aria-hidden="true" />
					<span className="tabular-nums">{handoffs}</span>
				</span>
				<ConnectionIndicator conexao={conexao} />
				{onAbrirEventos ? (
					<button
						type="button"
						onClick={onAbrirEventos}
						className="flex h-9 items-center gap-xs rounded border border-borda px-sm text-xs font-medium hover:bg-superficie-alta"
						title="Visualizar eventos e falhas do sistema"
					>
						<AlertCircle className="size-4" aria-hidden="true" />
						Eventos e falhas
					</button>
				) : null}
				<button
					type="button"
					onClick={onAtualizar}
					className="flex size-8 items-center justify-center rounded border border-borda hover:bg-superficie-alta"
					title="Atualizar dados"
					aria-label="Atualizar dados"
				>
					<RefreshCw
						className={`size-4 ${carregando ? "animate-spin" : ""}`}
						aria-hidden="true"
					/>
				</button>
				<button
					type="button"
					onClick={onAbrirKillSwitch}
					className="flex h-9 items-center gap-xs rounded border border-perigo/60 px-sm text-perigo hover:bg-perigo/10"
					title="Pausar toda a automação"
				>
					<ShieldAlert className="size-4" aria-hidden="true" />
					Pausar tudo
				</button>
			</div>

			<span className="sr-only" aria-live="assertive">
				{modo === "silencio" ? "Handoff ativo: mão humana no comando." : ""}
			</span>
		</header>
	);
}
