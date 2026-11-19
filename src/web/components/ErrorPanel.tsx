import {
	AlertCircle,
	AlertTriangle,
	CheckCircle2,
	Info,
	RefreshCw,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { buscarEventos, type EventoItem, type SeveridadeEvento } from "../api";

export interface ErrorPanelProps {
	readonly aberto: boolean;
	readonly onFechar: () => void;
}

const SEVERIDADES: Array<{
	valor: SeveridadeEvento | "todas";
	rotulo: string;
}> = [
	{ valor: "todas", rotulo: "Todas" },
	{ valor: "error", rotulo: "Erros" },
	{ valor: "critical", rotulo: "Críticos" },
	{ valor: "warn", rotulo: "Avisos" },
	{ valor: "info", rotulo: "Informativos" },
	{ valor: "debug", rotulo: "Depuração" },
];

const ICONES_SEVERIDADE: Record<
	SeveridadeEvento,
	{ icone: typeof Info; classe: string; rotulo: string }
> = {
	critical: { icone: AlertCircle, classe: "text-perigo", rotulo: "Crítico" },
	error: { icone: AlertCircle, classe: "text-perigo", rotulo: "Erro" },
	warn: { icone: AlertTriangle, classe: "text-aviso", rotulo: "Aviso" },
	info: { icone: Info, classe: "text-acento", rotulo: "Info" },
	debug: { icone: CheckCircle2, classe: "text-suave", rotulo: "Debug" },
};

export function ErrorPanel({ aberto, onFechar }: ErrorPanelProps) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [severidade, setSeveridade] = useState<SeveridadeEvento | "todas">(
		"todas",
	);
	const [eventos, setEventos] = useState<EventoItem[]>([]);
	const [carregando, setCarregando] = useState(false);
	const [erroMsg, setErroMsg] = useState<string | null>(null);
	const [pagina, setPagina] = useState(1);
	const [temMais, setTemMais] = useState(false);

	const carregar = useCallback(
		async (p: number, sev: SeveridadeEvento | "todas", anexar = false) => {
			setCarregando(true);
			setErroMsg(null);
			try {
				const params = {
					page: p,
					pageSize: 50,
					severity: sev === "todas" ? undefined : sev,
				};
				const res = await buscarEventos(params);
				if (res && Array.isArray(res.itens)) {
					setEventos((anteriores) =>
						anexar ? [...anteriores, ...res.itens] : res.itens,
					);
					setTemMais(res.itens.length === 50);
				}
			} catch (_err) {
				setErroMsg(
					"Banco de dados indisponível. O painel está em modo somente leitura.",
				);
			} finally {
				setCarregando(false);
			}
		},
		[],
	);

	useEffect(() => {
		const el = dialogRef.current;
		if (!el) return;
		if (aberto && !el.open) {
			el.showModal();
			setPagina(1);
			carregar(1, severidade, false);
		} else if (!aberto && el.open) {
			el.close();
		}
	}, [aberto, carregar, severidade]);

	const handleMudarSeveridade = (nova: SeveridadeEvento | "todas") => {
		setSeveridade(nova);
		setPagina(1);
		carregar(1, nova, false);
	};

	const handleCarregarMais = () => {
		const prox = pagina + 1;
		setPagina(prox);
		carregar(prox, severidade, true);
	};

	const formatarData = (iso: string) => {
		try {
			const d = new Date(iso);
			return d.toLocaleString("pt-BR", {
				dateStyle: "short",
				timeStyle: "medium",
			});
		} catch {
			return iso;
		}
	};

	return (
		<dialog
			ref={dialogRef}
			onClose={onFechar}
			className="fixed inset-0 m-auto flex h-[85vh] w-[90vw] max-w-5xl flex-col rounded-lg border border-borda bg-superficie text-texto shadow-2xl backdrop:bg-black/60"
		>
			<header className="flex items-center justify-between border-b border-borda p-md">
				<div>
					<h2 className="text-lg font-semibold">Eventos e falhas</h2>
					<p className="text-xs text-suave">
						Trilha de auditoria estruturada (somente leitura)
					</p>
				</div>
				<div className="flex items-center gap-sm">
					<button
						type="button"
						onClick={() => carregar(1, severidade, false)}
						disabled={carregando}
						className="flex size-8 items-center justify-center rounded border border-borda hover:bg-superficie-alta"
						title="Recarregar"
						aria-label="Recarregar eventos"
					>
						<RefreshCw
							className={`size-4 ${carregando ? "animate-spin" : ""}`}
							aria-hidden="true"
						/>
					</button>
					<button
						type="button"
						onClick={onFechar}
						className="flex size-8 items-center justify-center rounded border border-borda hover:bg-superficie-alta"
						title="Fechar"
						aria-label="Fechar painel de eventos"
					>
						<X className="size-4" aria-hidden="true" />
					</button>
				</div>
			</header>

			{/* Filtro por Chips */}
			<div className="flex flex-wrap gap-xs border-b border-borda px-md py-sm">
				{SEVERIDADES.map((s) => {
					const ativo = severidade === s.valor;
					return (
						<button
							key={s.valor}
							type="button"
							onClick={() => handleMudarSeveridade(s.valor)}
							className={`rounded-full px-sm py-xs text-xs font-medium transition-colors ${
								ativo
									? "bg-primaria text-texto-em-primaria"
									: "bg-superficie-alta text-suave hover:text-texto"
							}`}
						>
							{s.rotulo}
						</button>
					);
				})}
			</div>

			{/* Conteúdo / Tabela */}
			<div className="flex-1 overflow-y-auto p-md">
				{erroMsg ? (
					<div
						className="rounded border border-perigo/40 bg-perigo/10 p-md text-sm text-perigo"
						role="alert"
					>
						{erroMsg}
					</div>
				) : eventos.length === 0 && !carregando ? (
					<div className="py-xl text-center text-sm text-suave">
						Nenhum evento registrado.
					</div>
				) : (
					<div className="flex flex-col gap-sm">
						{eventos.map((ev) => {
							const info =
								ICONES_SEVERIDADE[ev.severity] ?? ICONES_SEVERIDADE.info;
							const Icone = info.icone;
							return (
								<div
									key={ev.id}
									className="flex flex-col gap-xs rounded border border-borda bg-superficie-alta/40 p-sm text-xs"
								>
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-xs font-medium">
											<Icone
												className={`size-3.5 ${info.classe}`}
												aria-hidden="true"
											/>
											<span className={info.classe}>{info.rotulo}</span>
											<span className="text-suave">•</span>
											<span className="font-mono text-texto">
												{ev.eventType}
											</span>
											<span className="text-suave">({ev.entityType})</span>
										</div>
										<span className="font-mono text-suave tabular-nums">
											{formatarData(ev.createdAt)}
										</span>
									</div>
									<pre className="overflow-x-auto rounded bg-fundo p-xs font-mono text-[11px] text-texto/90">
										{JSON.stringify(ev.payload, null, 2)}
									</pre>
								</div>
							);
						})}

						{temMais ? (
							<div className="pt-sm text-center">
								<button
									type="button"
									onClick={handleCarregarMais}
									disabled={carregando}
									className="rounded border border-borda px-md py-xs text-xs font-medium hover:bg-superficie-alta"
								>
									{carregando ? "Carregando…" : "Carregar mais"}
								</button>
							</div>
						) : null}
					</div>
				)}
			</div>
		</dialog>
	);
}
