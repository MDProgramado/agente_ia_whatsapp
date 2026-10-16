import {
	Activity,
	Bot,
	MessageSquare,
	RefreshCw,
	TriangleAlert,
	Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ResumoSistema } from "./api";
import { ApiError, buscarResumoSistema } from "./api";

/**
 * Casca do painel (NFRQ-05 / R-046).
 *
 * Uma única tela, quatro áreas lado a lado (docs/06-wireframes.md):
 *   topo    — estado do sistema (modo, janela, contadores, kill switch)
 *   esquerda— lista de leads
 *   centro  — conversa + histórico + barra de ação
 *   direita — fila de handoff + sugestão de IA
 *
 * Esta é a versão de esqueleto: a Task 1 apenas prova o build e o cliente REST.
 * As áreas são preenchidas pelos componentes em `src/web/components` na Task 2.
 */
export function App() {
	const [resumo, setResumo] = useState<ResumoSistema | null>(null);
	const [carregando, setCarregando] = useState<boolean>(true);
	const [erro, setErro] = useState<string | null>(null);
	const [semToken, setSemToken] = useState<boolean>(false);

	const carregar = useCallback(async (): Promise<void> => {
		setCarregando(true);
		setErro(null);
		setSemToken(false);
		try {
			setResumo(await buscarResumoSistema());
		} catch (causa) {
			if (causa instanceof ApiError) {
				if (causa.kind === "sem_token" || causa.kind === "token_invalido") {
					setSemToken(true);
				}
				setErro(causa.message);
			} else {
				setErro(causa instanceof Error ? causa.message : String(causa));
			}
		} finally {
			setCarregando(false);
		}
	}, []);

	useEffect(() => {
		void carregar();
	}, [carregar]);

	return (
		<div className="flex h-full flex-col bg-fundo text-texto">
			<header className="flex items-center gap-sm border-b border-borda bg-superficie px-md py-sm">
				<Bot className="size-5 text-acento" aria-hidden="true" />
				<h1 className="text-sm font-semibold tracking-wide">
					Automação WhatsApp
				</h1>
				<div className="ml-auto flex items-center gap-md text-xs text-suave">
					{resumo !== null ? (
						<>
							<span
								className={
									resumo.mode === "active" ? "text-ativo" : "text-pausa"
								}
							>
								{resumo.mode === "active" ? "Ativo" : "Pausado"}
							</span>
							<span className="flex items-center gap-1">
								<Activity className="size-3.5" aria-hidden="true" />
								{resumo.counters.sent}/{resumo.counters.sentLimit}
							</span>
						</>
					) : (
						<span>{carregando ? "Carregando…" : "Sem dados"}</span>
					)}
					<button
						type="button"
						onClick={carregar}
						className="flex items-center gap-1 rounded border border-borda px-2 py-1 hover:bg-superficie-alta"
					>
						<RefreshCw className="size-3.5" aria-hidden="true" />
						Atualizar
					</button>
				</div>
			</header>

			{erro !== null ? (
				<div className="flex items-center gap-2 border-b border-perigo/40 bg-perigo/10 px-md py-sm text-xs">
					<TriangleAlert className="size-4 text-perigo" aria-hidden="true" />
					<span>{erro}</span>
					{semToken ? (
						<span className="text-suave">
							Informe o token com ?token=&lt;PANEL_TOKEN&gt;.
						</span>
					) : null}
				</div>
			) : null}

			<main className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)_360px] divide-x divide-borda">
				<section aria-label="Leads" className="flex min-h-0 flex-col">
					<div className="flex items-center gap-2 border-b border-borda px-md py-2 text-xs font-medium text-suave">
						<Users className="size-3.5" aria-hidden="true" />
						Leads
					</div>
					<div className="rolagem-fina flex-1 overflow-y-auto p-md text-xs text-suave">
						Lista de leads (Task 2).
					</div>
				</section>

				<section aria-label="Conversa" className="flex min-h-0 flex-col">
					<div className="flex items-center gap-2 border-b border-borda px-md py-2 text-xs font-medium text-suave">
						<MessageSquare className="size-3.5" aria-hidden="true" />
						Conversa
					</div>
					<div className="rolagem-fina flex-1 overflow-y-auto p-md text-xs text-suave">
						Conversa e histórico (Task 2).
					</div>
				</section>

				<section aria-label="Handoff" className="flex min-h-0 flex-col">
					<div className="flex items-center gap-2 border-b border-borda px-md py-2 text-xs font-medium text-suave">
						<Activity className="size-3.5" aria-hidden="true" />
						Handoff
					</div>
					<div className="rolagem-fina flex-1 overflow-y-auto p-md text-xs text-suave">
						Fila de handoff (Task 2).
					</div>
				</section>
			</main>
		</div>
	);
}
