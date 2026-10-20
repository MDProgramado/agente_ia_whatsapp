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
	DesfechoDispatch,
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
	enviarMensagem,
	lerToken,
	limparTokenDaUrl,
} from "./api";
import type { AcaoRapida } from "./components/ActionBar";
import { ActionBar } from "./components/ActionBar";
import { ChatPane } from "./components/ChatPane";
import { HandoffQueue } from "./components/HandoffQueue";
import { LeadList } from "./components/LeadList";
import { SuggestionCard } from "./components/SuggestionCard";
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

/**
 * Chime Web Audio (D-21): redundância da notificação do `notify.ps1`, que
 * continua sendo a notificação PRIMÁRIA. Toca um bip curto de dois tons quando
 * um handoff chega via SSE. Degrada em silêncio se o Web Audio não estiver
 * disponível ou bloqueado.
 */
const tocarChime = (): void => {
	try {
		const contexto = globalThis as {
			AudioContext?: typeof AudioContext;
			webkitAudioContext?: typeof AudioContext;
		};
		const Ctx = contexto.AudioContext ?? contexto.webkitAudioContext;
		if (Ctx === undefined) return;
		const ctx = new Ctx();
		const agora = ctx.currentTime;
		[880, 1174.7].forEach((frequencia, i) => {
			const osc = ctx.createOscillator();
			const ganho = ctx.createGain();
			osc.type = "sine";
			osc.frequency.value = frequencia;
			const inicio = agora + i * 0.18;
			ganho.gain.setValueAtTime(0.0001, inicio);
			ganho.gain.exponentialRampToValueAtTime(0.18, inicio + 0.02);
			ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + 0.35);
			osc.connect(ganho);
			ganho.connect(ctx.destination);
			osc.start(inicio);
			osc.stop(inicio + 0.4);
		});
		setTimeout(() => {
			void ctx.close();
		}, 1200);
	} catch {
		// degrada em silêncio (D-21)
	}
};

/**
 * Notificação de handoff. `notify.ps1` é a notificação primária; aqui é só a
 * redundância do navegador. Pede permissão APENAS quando há um handoff (contexto)
 * — nunca no load. Se negada ou indisponível, degrada em silêncio.
 */
const notificarHandoff = (): void => {
	try {
		if (typeof Notification === "undefined") return;
		if (Notification.permission === "denied") return;
		const corpo =
			"Um lead aguarda atendimento humano. Abra o painel para assumir.";
		if (Notification.permission === "default") {
			void Notification.requestPermission()
				.then((permissao) => {
					if (permissao === "granted") {
						new Notification("Handoff pendente", { body: corpo });
					}
				})
				.catch(() => {
					// degrada em silêncio
				});
			return;
		}
		new Notification("Handoff pendente", { body: corpo });
	} catch {
		// degrada em silêncio (D-21)
	}
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

	// --- Task 3: compositor, sugestões, resultado do gate ------------------
	const [texto, setTexto] = useState("");
	const [enviando, setEnviando] = useState(false);
	const [resultado, setResultado] = useState<DesfechoDispatch | null>(null);
	const [sugestoesIgnoradas, setSugestoesIgnoradas] = useState<
		readonly string[]
	>([]);
	const campoRef = useRef<HTMLTextAreaElement | null>(null);

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

	// --- Task 3 handlers ---------------------------------------------------

	/** Sugestão ativa: a última `ai_suggestion`/`suggested` ainda não ignorada. */
	const sugestao = useMemo(() => {
		const candidatas = mensagens.filter(
			(m) =>
				m.origin === "ai_suggestion" &&
				m.status === "suggested" &&
				!sugestoesIgnoradas.includes(m.id),
		);
		return candidatas.at(-1) ?? null;
	}, [mensagens, sugestoesIgnoradas]);

	/** Aceitar/Editar só preenchem o campo — NUNCA enviam (T-03-22). */
	const aoAplicar = useCallback((conteudo: string, focar: boolean) => {
		setTexto(conteudo);
		setResultado(null);
		if (focar) campoRef.current?.focus();
	}, []);

	const aoIgnorar = useCallback(() => {
		if (sugestao === null) return;
		setSugestoesIgnoradas((atual) => [...atual, sugestao.id]);
	}, [sugestao]);

	/** Envio sempre pelo gate: o servidor decide sent/blocked/deferred. */
	const enviar = useCallback(async (): Promise<void> => {
		if (conversa === null || texto.trim() === "") return;
		setEnviando(true);
		try {
			const desfecho = await enviarMensagem(conversa.id, texto.trim());
			setResultado(desfecho);
			if (desfecho.action === "sent") {
				setTexto("");
				await carregarConversa(conversa.id);
				await carregarSistema();
			}
		} catch (causa) {
			setErroSistema(mensagemDeErro(causa));
		} finally {
			setEnviando(false);
		}
	}, [conversa, texto, carregarConversa, carregarSistema]);

	const aoEnviar = useCallback(() => void enviar(), [enviar]);

	const aoAcao = useCallback(
		(acao: AcaoRapida) => {
			void (async () => {
				if (conversa === null) return;
				try {
					await acionarAcao(conversa.id, acao);
					await carregarConversa(conversa.id);
					await carregarSistema();
				} catch (causa) {
					setErroSistema(mensagemDeErro(causa));
				}
			})();
		},
		[conversa, carregarConversa, carregarSistema],
	);

	// Chime + notificação (D-21) quando a fila de handoff cresce via SSE.
	// A primeira carga (boot) não notifica.
	const filaAnteriorRef = useRef<number | null>(null);
	useEffect(() => {
		const atual = resumo?.handoffQueue.length ?? 0;
		const anterior = filaAnteriorRef.current;
		filaAnteriorRef.current = atual;
		if (anterior === null || atual <= anterior) return;
		tocarChime();
		notificarHandoff();
	}, [resumo]);

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
				>
					<ActionBar
						conversa={conversa}
						resumo={resumo}
						texto={texto}
						enviando={enviando}
						resultado={resultado}
						campoRef={campoRef}
						onTexto={setTexto}
						onEnviar={aoEnviar}
						onAcao={aoAcao}
					/>
				</ChatPane>

				<div className="flex min-h-0 flex-col divide-y divide-borda">
					<SuggestionCard
						sugestao={sugestao}
						onAplicar={aoAplicar}
						onIgnorar={aoIgnorar}
					/>
					<HandoffQueue
						itens={resumo?.handoffQueue ?? []}
						onSelecionar={aoSelecionarHandoff}
					/>
				</div>
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
