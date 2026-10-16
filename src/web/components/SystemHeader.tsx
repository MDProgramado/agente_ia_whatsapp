import {
	Bot,
	Inbox,
	MicOff,
	Pause,
	RefreshCw,
	ShieldAlert,
	UserCheck,
	Wifi,
	WifiOff,
} from "lucide-react";
import type { ConversaDetalhe, ResumoSistema } from "../api";
import type { EstadoConexao } from "../useSse";

/**
 * Cabeçalho em tempo real do painel (UI-SPEC §Component Inventory / D-19).
 *
 * Mostra o MODO (com ícone + rótulo + cor — nunca só cor), o motivo do silêncio
 * quando houver, os contadores do dia, o estado da janela, a contagem de
 * handoffs pendentes, o estado da conexão SSE e o botão do kill switch.
 *
 * O modo combina o MODO GLOBAL (`/api/system.mode`: `active`/`paused`) com o
 * modo da CONVERSA selecionada (`engagement_mode`/`handoff_active`). O contrato
 * congelado no 03-03 só expõe o modo global; COPILOTO e SILÊNCIO são por
 * conversa. Os rótulos são exatamente os do Copywriting Contract.
 */
export interface SystemHeaderProps {
	readonly resumo: ResumoSistema | null;
	readonly conexao: EstadoConexao;
	readonly conversa: ConversaDetalhe | null;
	readonly motivoSilencio: string | null;
	readonly carregando: boolean;
	readonly onAtualizar: () => void;
	readonly onAbrirKillSwitch: () => void;
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

const CONEXAO: Record<EstadoConexao, { texto: string; classe: string }> = {
	"ao-vivo": { texto: "Ao vivo", classe: "text-acento" },
	conectando: { texto: "Conectando…", classe: "text-suave" },
	reconectando: { texto: "Reconectando…", classe: "text-pausa" },
	"sem-conexao": { texto: "Sem conexão", classe: "text-perigo" },
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
}: SystemHeaderProps) {
	const modo = modoDoPainel(resumo, conversa);
	const rotulo = ROTULOS[modo];
	const conn = CONEXAO[conexao];
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
				<span
					className={`flex items-center gap-xs ${conn.classe}`}
					role="status"
				>
					{conexao === "ao-vivo" ? (
						<Wifi className="size-4" aria-hidden="true" />
					) : (
						<WifiOff className="size-4" aria-hidden="true" />
					)}
					{conn.texto}
				</span>
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
