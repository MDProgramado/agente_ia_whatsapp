import { LoaderCircle, ShieldAlert } from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	ConversaDetalhe,
	ItemFilaHandoff,
	Mensagem,
	ResumoLead,
	ResumoSistema,
} from "./api";
import {
	ApiError,
	acionarAcao,
	acionarKillSwitch,
	buscarConversa,
	buscarHistorico,
	buscarLeads,
	buscarResumoSistema,
	definirToken,
	lerToken,
	limparTokenDaUrl,
} from "./api";
import { ChatPane } from "./components/ChatPane";
import { HandoffQueue } from "./components/HandoffQueue";
import { LeadList } from "./components/LeadList";
import { SystemHeader } from "./components/SystemHeader";
import { useSse } from "./useSse";

/**
 * Painel único (NFRQ-05 / R-046) — composição de estado e layout.
 *
 * Quatro áreas: cabeçalho de estado em tempo real (`SystemHeader`), lista de
 * leads (`LeadList`), conversa + histórico (`ChatPane`) e fila de handoff
 * (`HandoffQueue`). O SSE é só aviso: cada sinal (`onSinal`) reexecuta os GETs
 * REST — nunca é a fonte de verdade (D-23).
 *
 * O token vem de `?token=<PANEL_TOKEN>` (limpo da URL ao entrar) ou do
 * `localStorage` — nunca é logado (T-03-21).
 */
const tempoDaBusca = 250;

const leadDoHandoff = (item: ItemFilaHandoff): ResumoLead => ({
	id: item.leadId,
	name: item.leadName,
	phoneNumber: item.phoneNumber,
	originSource: "—",
	optOut: false,
	conversationId: item.conversationId,
	state: null,
	engagementMode: null,
	handoffActive: true,
	lastInboundAt: null,
	lastOutboundAt: null,
});

const mensagemDeErro = (causa: unknown): string => {
	if (causa instanceof ApiError) return causa.message;
	return causa instanceof Error ? causa.message : String(causa);
};

const tratarTokenInvalido = (causa: unknown): boolean => {
	if (causa instanceof ApiError && causa.kind === "token_invalido") return true;
	return false;
};

export function App() {
	const [tokenPresente, setTokenPresente] = useState<boolean>(
		() => lerToken() !== null,
	);
	const [resumo, setResumo] = useState<ResumoSistema | null>(null);
	const [leads, setLeads] = useState<readonly ResumoLead[]>([]);
	const [busca, setBusca] = useState("");
	const [buscaAplicada, setBuscaAplicada] = useState("");
	const [selecionado, setSelecionado] = useState<ResumoLead | null>(null);
	const [conversa, setConversa] = useState<ConversaDetalhe | null>(null);
	const [mensagens, setMensagens] = useState<readonly Mensagem[]>([]);

	const [carregandoSistema, setCarregandoSistema] = useState(false);
	const [carregandoLeads, setCarregandoLeads] = useState(false);
	const [carregandoConversa, setCarregandoConversa] = useState(false);
	const [erroSistema, setErroSistema] = useState<string | null>(null);
	const [erroLeads, setErroLeads] = useState<string | null>(null);

	const dialogoRef = useRef<HTMLDialogElement | null>(null);
	const [confirmacao, setConfirmacao] = useState("");
	const [pausandoTudo, setPausandoTudo] = useState(false);

	// id estável e único (evita duplicar `id` no DOM quando o painel renderiza
	// mais de um dialog) — regra `useUniqueElementIds`.
	const idKillSwitch = useId();

	const carregarSistema = useCallback(async (): Promise<void> => {
		setCarregandoSistema(true);
		try {
			setResumo(await buscarResumoSistema());
			setErroSistema(null);
		} catch (causa) {
			if (tratarTokenInvalido(causa)) setTokenPresente(false);
			setErroSistema(mensagemDeErro(causa));
		} finally {
			setCarregandoSistema(false);
		}
	}, []);

	const carregarLeads = useCallback(async (termo: string): Promise<void> => {
		setCarregandoLeads(true);
		try {
			const lista = await buscarLeads({ q: termo });
			setLeads(lista.itens);
			setErroLeads(null);
		} catch (causa) {
			if (tratarTokenInvalido(causa)) setTokenPresente(false);
			setErroLeads(mensagemDeErro(causa));
		} finally {
			setCarregandoLeads(false);
		}
	}, []);

	const carregarConversa = useCallback(
		async (conversationId: string): Promise<void> => {
			setCarregandoConversa(true);
			try {
				const [det, hist] = await Promise.all([
					buscarConversa(conversationId),
					buscarHistorico(conversationId),
				]);
				setConversa(det);
				setMensagens(hist.itens);
			} catch (causa) {
				if (tratarTokenInvalido(causa)) setTokenPresente(false);
			} finally {
				setCarregandoConversa(false);
			}
		},
		[],
	);

	/** Re-sync completo por GET — chamado no boot e a cada sinal SSE. */
	const recarregarTudo = useCallback((): void => {
		void carregarSistema();
		void carregarLeads(buscaAplicada);
		if (selecionado !== null && selecionado.conversationId !== null) {
			void carregarConversa(selecionado.conversationId);
		}
	}, [
		carregarSistema,
		carregarLeads,
		carregarConversa,
		buscaAplicada,
		selecionado,
	]);

	// SSE: o sinal só diz "olha de novo"; quem lê o estado é o REST acima.
	const { conexao } = useSse({ ativo: tokenPresente, onSinal: recarregarTudo });

	// Ao entrar com token na URL, limpa a barra de endereço.
	useEffect(() => {
		limparTokenDaUrl();
	}, []);

	// Debounce da busca server-side (D-22).
	useEffect(() => {
		const t = setTimeout(() => setBuscaAplicada(busca), tempoDaBusca);
		return () => clearTimeout(t);
	}, [busca]);

	useEffect(() => {
		if (tokenPresente) void carregarSistema();
	}, [tokenPresente, carregarSistema]);

	useEffect(() => {
		if (tokenPresente) void carregarLeads(buscaAplicada);
	}, [tokenPresente, buscaAplicada, carregarLeads]);

	useEffect(() => {
		if (!tokenPresente) return;
		if (selecionado === null || selecionado.conversationId === null) {
			setConversa(null);
			setMensagens([]);
			return;
		}
		void carregarConversa(selecionado.conversationId);
	}, [tokenPresente, selecionado, carregarConversa]);

	const motivoSilencio = useMemo(() => {
		if (conversa === null || resumo === null) return null;
		const item = resumo.handoffQueue.find(
			(h) => h.conversationId === conversa.id,
		);
		if (item === undefined) return null;
		return item.triggerDetail ?? item.excerpt ?? item.triggeredBy;
	}, [conversa, resumo]);

	const abrirKillSwitch = useCallback((): void => {
		setConfirmacao("");
		dialogoRef.current?.showModal();
	}, []);

	const fecharKillSwitch = useCallback((): void => {
		dialogoRef.current?.close();
		setConfirmacao("");
	}, []);

	const confirmarKillSwitch = useCallback(async (): Promise<void> => {
		if (confirmacao !== "PAUSAR") return;
		setPausandoTudo(true);
		try {
			await acionarKillSwitch();
			fecharKillSwitch();
			await carregarSistema();
		} catch (causa) {
			setErroSistema(mensagemDeErro(causa));
		} finally {
			setPausandoTudo(false);
		}
	}, [confirmacao, fecharKillSwitch, carregarSistema]);

	// Handlers estáveis para as props de evento do dialog (evita recriar a
	// função a cada render).
	const aoMudarConfirmacao = useCallback(
		(evento: { target: { value: string } }) =>
			setConfirmacao(evento.target.value),
		[],
	);
	const aoFecharDialogo = useCallback(() => setConfirmacao(""), []);
	const aoConfirmar = useCallback(
		() => void confirmarKillSwitch(),
		[confirmarKillSwitch],
	);

	const assumir = useCallback(async (): Promise<void> => {
		if (conversa === null) return;
		try {
			await acionarAcao(conversa.id, "assumir");
			await carregarConversa(conversa.id);
			await carregarSistema();
		} catch (causa) {
			setErroSistema(mensagemDeErro(causa));
		}
	}, [conversa, carregarConversa, carregarSistema]);

	const aoAssumir = useCallback(() => void assumir(), [assumir]);
	const aoRecarregarLeads = useCallback(
		() => void carregarLeads(buscaAplicada),
		[carregarLeads, buscaAplicada],
	);
	const aoSelecionarHandoff = useCallback(
		(item: ItemFilaHandoff) => setSelecionado(leadDoHandoff(item)),
		[],
	);
	const aoEntrarNoPainel = useCallback(() => setTokenPresente(true), []);

	if (!tokenPresente) {
		return <TelaToken onEntrar={aoEntrarNoPainel} />;
	}

	return (
		<div className="flex h-full flex-col bg-fundo text-texto">
			<SystemHeader
				resumo={resumo}
				conexao={conexao}
				conversa={conversa}
				motivoSilencio={motivoSilencio}
				carregando={carregandoSistema}
				onAtualizar={recarregarTudo}
				onAbrirKillSwitch={abrirKillSwitch}
			/>

			{resumo?.mode === "paused" ? (
				<div className="flex items-center gap-sm border-b border-perigo/40 bg-perigo/10 px-lg py-sm text-sm">
					<ShieldAlert className="size-4 text-perigo" aria-hidden="true" />
					<span className="flex-1">
						AUTOMAÇÃO PAUSADA — nenhuma mensagem sai até você retomar.
					</span>
				</div>
			) : null}

			{erroSistema !== null ? (
				<div className="border-b border-perigo/40 bg-perigo/10 px-lg py-sm text-sm">
					{erroSistema}
				</div>
			) : null}

			<main className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)_360px] divide-x divide-borda">
				<LeadList
					leads={leads}
					selecionadoId={selecionado?.id ?? null}
					busca={busca}
					carregando={carregandoLeads}
					erro={erroLeads}
					onBusca={setBusca}
					onSelecionar={setSelecionado}
					onRecarregar={aoRecarregarLeads}
				/>

				<ChatPane
					conversa={conversa}
					mensagens={mensagens}
					carregando={carregandoConversa}
					motivoSilencio={motivoSilencio}
					onAssumir={aoAssumir}
				/>

				<HandoffQueue
					itens={resumo?.handoffQueue ?? []}
					onSelecionar={aoSelecionarHandoff}
				/>
			</main>

			<dialog
				ref={dialogoRef}
				onClose={aoFecharDialogo}
				aria-labelledby={idKillSwitch}
				className="m-auto w-[420px] rounded-lg border border-borda bg-superficie p-lg text-texto backdrop:bg-black/60"
			>
				<h2 id={idKillSwitch} className="text-base font-semibold">
					Pausar toda a automação
				</h2>
				<p className="mt-sm text-sm text-suave">
					Digite PAUSAR para confirmar. Nenhuma mensagem automática sairá até
					você retomar.
				</p>
				<input
					value={confirmacao}
					onChange={aoMudarConfirmacao}
					aria-label="Digite PAUSAR para confirmar"
					className="mt-md w-full rounded border border-borda bg-fundo px-sm py-xs text-sm outline-none focus-visible:ring-2 focus-visible:ring-acento"
				/>
				<div className="mt-md flex justify-end gap-sm">
					<button
						type="button"
						onClick={fecharKillSwitch}
						className="h-9 rounded border border-borda px-md hover:bg-superficie-alta"
					>
						Cancelar
					</button>
					<button
						type="button"
						disabled={confirmacao !== "PAUSAR" || pausandoTudo}
						onClick={aoConfirmar}
						className="flex h-9 items-center gap-xs rounded bg-perigo px-md font-semibold text-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{pausandoTudo ? (
							<LoaderCircle
								className="size-4 animate-spin"
								aria-hidden="true"
							/>
						) : null}
						Pausar automação
					</button>
				</div>
			</dialog>
		</div>
	);
}

/** Tela de entrada quando não há token (estado "sem-permissão"). */
function TelaToken({ onEntrar }: { onEntrar: () => void }) {
	const [valor, setValor] = useState("");
	return (
		<div className="flex h-full items-center justify-center bg-fundo p-xl text-texto">
			<form
				onSubmit={(evento) => {
					evento.preventDefault();
					if (valor.trim() === "") return;
					definirToken(valor.trim());
					onEntrar();
				}}
				className="flex w-[380px] flex-col gap-md rounded-lg border border-borda bg-superficie p-lg"
			>
				<h1 className="text-base font-semibold">Automação WhatsApp — Painel</h1>
				<p className="text-sm text-suave">
					Informe o token do painel. Você também pode abrir o painel com{" "}
					<code className="text-suave">?token=&lt;PANEL_TOKEN&gt;</code>.
				</p>
				<input
					type="password"
					value={valor}
					onChange={(evento) => setValor(evento.target.value)}
					placeholder="Token do painel"
					aria-label="Token do painel"
					className="rounded border border-borda bg-fundo px-sm py-xs text-sm outline-none focus-visible:ring-2 focus-visible:ring-acento"
				/>
				<button
					type="submit"
					disabled={valor.trim() === ""}
					className="h-9 rounded bg-acento px-md font-semibold text-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
				>
					Entrar
				</button>
			</form>
		</div>
	);
}
