import { LoaderCircle, ShieldAlert } from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { rotulo } from "../domain/pipeline";
import type {
	ConversaDetalhe,
	DesfechoDispatch,
	ItemFilaHandoff,
	LeadDetalhe,
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
	buscarLead,
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
import { CopilotPanel } from "./components/CopilotPanel";
import { ErrorPanel } from "./components/ErrorPanel";
import { HandoffQueue } from "./components/HandoffQueue";
import { ImportModal } from "./components/ImportModal";
import { LeadDetailDrawer } from "./components/LeadDetailDrawer";
import { LeadHistoryPanel } from "./components/LeadHistoryPanel";
import { LeadList } from "./components/LeadList";
import { LeadNotes } from "./components/LeadNotes";
import type {
	ConversaCrm,
	EntradaHistoricoStatus,
} from "./components/PipelineBoard";
import { HistoricoStatus, PipelineBoard } from "./components/PipelineBoard";
import { SystemHeader } from "./components/SystemHeader";
import { TaskList } from "./components/TaskList";
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

const abaAtiva =
	"rounded border border-acento bg-acento/10 px-md py-xs text-sm font-semibold";
const abaInativa =
	"rounded border border-transparent px-md py-xs text-sm text-suave hover:bg-superficie-alta";

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

/** Conversa do CRM → resumo de lead, para abrir a conversa na vista Painel. */
const leadDoCrm = (conversa: ConversaCrm): ResumoLead => ({
	id: conversa.leadId,
	name: conversa.name,
	phoneNumber: conversa.phoneNumber,
	originSource: "—",
	optOut: conversa.optOut,
	conversationId: conversa.conversationId,
	state: conversa.state,
	engagementMode: conversa.engagementMode,
	handoffActive: conversa.handoffActive,
	lastInboundAt: conversa.lastInboundAt,
	lastOutboundAt: conversa.lastOutboundAt,
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

	// --- Task 2 (03-06): gaveta de detalhe do lead -------------------------
	/**
	 * Lead em detalhe na GAVETA (botão "Ver detalhe" da lista). É um slot
	 * separado do lead da COLUNA DIREITA porque o lead aberto na gaveta pode
	 * não ser o lead selecionado no chat.
	 */
	const [leadGaveta, setLeadGaveta] = useState<LeadDetalhe | null>(null);
	const [detalheAberto, setDetalheAberto] = useState(false);
	const [carregandoGaveta, setCarregandoGaveta] = useState(false);
	const [erroGaveta, setErroGaveta] = useState<string | null>(null);
	const [painelErrosAberto, setPainelErrosAberto] = useState(false);
	const [importacaoAberta, setImportacaoAberta] = useState(false);

	/**
	 * Lead em detalhe do lead SELECIONADO — alimenta o `LeadHistoryPanel` da
	 * coluna direita (R-064: origem, base legal, finalidade, opt-out).
	 */
	const [leadDetalhe, setLeadDetalhe] = useState<LeadDetalhe | null>(null);
	const [carregandoDetalhe, setCarregandoDetalhe] = useState(false);
	const [erroDetalhe, setErroDetalhe] = useState<string | null>(null);

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

	// --- Task 4 (03-08): vista CRM, histórico de status e detalhe do lead ----
	const [vista, setVista] = useState<"painel" | "crm">("painel");
	/** Histórico de mudanças de status — append-only, só cresce. */
	const [historicoStatus, setHistoricoStatus] = useState<
		readonly EntradaHistoricoStatus[]
	>([]);
	const [leadCrm, setLeadCrm] = useState<ConversaCrm | null>(null);
	const [abaLead, setAbaLead] = useState<"notas" | "tarefas" | "historico">(
		"notas",
	);
	const leadRef = useRef<HTMLDialogElement | null>(null);
	const idLeadDrawer = useId();

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

	/**
	 * Detalhe do lead SELECIONADO (coluna direita — R-064): origem, base legal,
	 * finalidade, etiquetas, status do funil e o instante do opt-out.
	 */
	const carregarDetalhe = useCallback(async (leadId: string): Promise<void> => {
		setCarregandoDetalhe(true);
		try {
			setLeadDetalhe(await buscarLead(leadId));
			setErroDetalhe(null);
		} catch (causa) {
			if (tratarTokenInvalido(causa)) setTokenPresente(false);
			setErroDetalhe(mensagemDeErro(causa));
			setLeadDetalhe(null);
		} finally {
			setCarregandoDetalhe(false);
		}
	}, []);

	/** Detalhe do lead aberto na GAVETA — mesma rota, slot próprio. */
	const carregarGaveta = useCallback(async (leadId: string): Promise<void> => {
		setCarregandoGaveta(true);
		try {
			setLeadGaveta(await buscarLead(leadId));
			setErroGaveta(null);
		} catch (causa) {
			if (tratarTokenInvalido(causa)) setTokenPresente(false);
			setErroGaveta(mensagemDeErro(causa));
			setLeadGaveta(null);
		} finally {
			setCarregandoGaveta(false);
		}
	}, []);

	/** Abre a gaveta de detalhe do lead (botão "Ver detalhe" da lista). */
	const aoAbrirDetalhe = useCallback(
		(lead: ResumoLead): void => {
			setDetalheAberto(true);
			void carregarGaveta(lead.id);
		},
		[carregarGaveta],
	);

	const aoFecharDetalhe = useCallback((): void => {
		setDetalheAberto(false);
	}, []);

	/** "Ver conversa completa": fecha a gaveta e leva o lead ao chat principal. */
	const aoAbrirConversaCompleta = useCallback((lead: LeadDetalhe): void => {
		setSelecionado(lead);
		setLeadDetalhe(lead);
		setDetalheAberto(false);
	}, []);

	/**
	 * Opt-out manual registrado na aba Compliance: re-sincroniza a gaveta (o
	 * lead otimizado É o da gaveta), a coluna direita (só se for o mesmo lead)
	 * e a lista (o ponto de opt-out). A COLUNA DIREITA e a GAVETA são slots
	 * separados de propósito — um nunca sobrescreve o outro.
	 */
	const aoRegistrarOptOut = useCallback(
		(leadId: string): void => {
			void carregarGaveta(leadId);
			if (leadDetalhe?.id === leadId) void carregarDetalhe(leadId);
			void carregarLeads(buscaAplicada);
		},
		[
			carregarGaveta,
			carregarDetalhe,
			carregarLeads,
			buscaAplicada,
			leadDetalhe?.id,
		],
	);

	/** Re-sync completo por GET — chamado no boot e a cada sinal SSE. */
	const recarregarTudo = useCallback((): void => {
		void carregarSistema();
		void carregarLeads(buscaAplicada);
		if (selecionado !== null && selecionado.conversationId !== null) {
			void carregarConversa(selecionado.conversationId);
		}
		// O resumo R-064 do lead selecionado também é re-sincronizado: um
		// opt-out detectado automaticamente (gate) precisa aparecer na coluna
		// direita sem recarregar a página.
		if (selecionado !== null) void carregarDetalhe(selecionado.id);
	}, [
		carregarSistema,
		carregarLeads,
		carregarConversa,
		carregarDetalhe,
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
		(item: ItemFilaHandoff) => {
			setSelecionado(leadDoHandoff(item));
			void carregarDetalhe(item.leadId);
		},
		[carregarDetalhe],
	);

	/**
	 * Clique simples no item da lista: seleciona o lead para o chat (comportamento
	 * do 03-04 preservado) e atualiza o resumo da coluna direita.
	 */
	const aoSelecionarLead = useCallback(
		(lead: ResumoLead): void => {
			setSelecionado(lead);
			void carregarDetalhe(lead.id);
		},
		[carregarDetalhe],
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

	// --- Task 4 handlers (03-08) --------------------------------------------

	/**
	 * O histórico de status é APPEND-ONLY: cada correção do painel vira uma
	 * entrada nova no topo. Nada reescreve nem remove uma entrada (R-022/R-043).
	 */
	const aoRegistrarHistorico = useCallback(
		(entrada: EntradaHistoricoStatus): void => {
			setHistoricoStatus((atual) => [entrada, ...atual].slice(0, 200));
		},
		[],
	);

	const aoAbrirLeadCrm = useCallback((conversa: ConversaCrm): void => {
		setLeadCrm(conversa);
		setAbaLead("notas");
		leadRef.current?.showModal();
	}, []);

	const fecharLeadCrm = useCallback((): void => {
		leadRef.current?.close();
		setLeadCrm(null);
	}, []);

	/** Abre a conversa do lead no Painel (mesma sessão, sem recarregar a página). */
	const abrirLeadNoPainel = useCallback((): void => {
		if (leadCrm === null) return;
		setSelecionado(leadDoCrm(leadCrm));
		void carregarDetalhe(leadCrm.leadId);
		fecharLeadCrm();
		setVista("painel");
	}, [leadCrm, fecharLeadCrm, carregarDetalhe]);

	/** O gate confirmou o envio feito pelo copiloto: limpa e re-sincroniza. */
	const aoEnviarPeloCopiloto = useCallback((): void => {
		setTexto("");
		if (conversa === null) return;
		void carregarConversa(conversa.id);
		void carregarSistema();
	}, [conversa, carregarConversa, carregarSistema]);

	const aoEscolherAba = useCallback(
		(aba: "notas" | "tarefas" | "historico"): void => setAbaLead(aba),
		[],
	);

	const historicoDoLead = useMemo(
		() =>
			leadCrm === null
				? []
				: historicoStatus.filter(
						(entrada) => entrada.conversationId === leadCrm.conversationId,
					),
		[historicoStatus, leadCrm],
	);

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
				onAbrirEventos={() => setPainelErrosAberto(true)}
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

			<nav
				aria-label="Áreas do painel"
				className="flex items-center gap-xs border-b border-borda bg-superficie px-md py-xs"
			>
				<button
					type="button"
					onClick={() => setVista("painel")}
					aria-current={vista === "painel" ? "page" : undefined}
					className={vista === "painel" ? abaAtiva : abaInativa}
				>
					Painel
				</button>
				<button
					type="button"
					onClick={() => setVista("crm")}
					aria-current={vista === "crm" ? "page" : undefined}
					className={vista === "crm" ? abaAtiva : abaInativa}
				>
					CRM
				</button>
			</nav>

			{vista === "crm" ? (
				<PipelineBoard
					historico={historicoStatus}
					onAbrirLead={aoAbrirLeadCrm}
					onCorrecaoAplicada={aoRegistrarHistorico}
				/>
			) : (
				<main className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)_360px] divide-x divide-borda">
					<LeadList
						leads={leads}
						selecionadoId={selecionado?.id ?? null}
						busca={busca}
						carregando={carregandoLeads}
						erro={erroLeads}
						onBusca={setBusca}
						onSelecionar={aoSelecionarLead}
						onRecarregar={aoRecarregarLeads}
						onAbrirDetalhe={aoAbrirDetalhe}
						onAbrirImportacao={() => setImportacaoAberta(true)}
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
						<CopilotPanel
							sugestao={sugestao}
							conversationId={conversa?.id ?? null}
							texto={texto}
							onAplicar={aoAplicar}
							onIgnorar={aoIgnorar}
							onEnviado={aoEnviarPeloCopiloto}
						/>
						<LeadHistoryPanel
							lead={leadDetalhe}
							carregando={carregandoDetalhe}
							erro={erroDetalhe}
						/>
						<HandoffQueue
							itens={resumo?.handoffQueue ?? []}
							onSelecionar={aoSelecionarHandoff}
						/>
					</div>
				</main>
			)}

			<LeadDetailDrawer
				lead={leadGaveta}
				aberto={detalheAberto}
				carregando={carregandoGaveta}
				erro={erroGaveta}
				onFechar={aoFecharDetalhe}
				onAbrirConversaCompleta={aoAbrirConversaCompleta}
				onRegistrarOptOut={aoRegistrarOptOut}
			/>

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

			<dialog
				ref={leadRef}
				aria-labelledby={idLeadDrawer}
				className="m-auto max-h-[85vh] w-[560px] rounded-lg border border-borda bg-superficie p-lg text-texto backdrop:bg-black/60"
			>
				{leadCrm !== null ? (
					<>
						<div className="flex items-start gap-sm">
							<div className="flex flex-col">
								<h2 id={idLeadDrawer} className="text-base font-semibold">
									{leadCrm.name ?? leadCrm.phoneNumber}
								</h2>
								<span className="text-xs text-suave">
									{leadCrm.phoneNumber} · {rotulo(leadCrm.pipelineStatus)}
								</span>
							</div>
							<button
								type="button"
								onClick={fecharLeadCrm}
								className="ml-auto rounded border border-borda px-sm py-xs text-sm hover:bg-superficie-alta"
							>
								Fechar
							</button>
						</div>

						<nav
							aria-label="Abas do lead"
							className="mt-md flex gap-xs border-b border-borda pb-xs"
						>
							{(
								[
									["notas", "Notas"],
									["tarefas", "Tarefas"],
									["historico", "Histórico"],
								] as const
							).map(([aba, rotuloAba]) => (
								<button
									key={aba}
									type="button"
									onClick={() => aoEscolherAba(aba)}
									aria-current={abaLead === aba ? "page" : undefined}
									className={abaLead === aba ? abaAtiva : abaInativa}
								>
									{rotuloAba}
								</button>
							))}
						</nav>

						<div className="mt-md max-h-[52vh] overflow-y-auto">
							{abaLead === "notas" ? (
								<LeadNotes leadId={leadCrm.leadId} />
							) : null}
							{abaLead === "tarefas" ? (
								<TaskList leadId={leadCrm.leadId} />
							) : null}
							{abaLead === "historico" ? (
								<HistoricoStatus
									entradas={historicoDoLead}
									className="w-full border-l-0"
								/>
							) : null}
						</div>

						<div className="mt-md flex justify-end">
							<button
								type="button"
								onClick={abrirLeadNoPainel}
								className="h-9 rounded border border-borda px-md text-sm hover:bg-superficie-alta"
							>
								Abrir conversa no painel
							</button>
						</div>
					</>
				) : null}
			</dialog>

			<ErrorPanel
				aberto={painelErrosAberto}
				onFechar={() => setPainelErrosAberto(false)}
			/>

			<ImportModal
				aberto={importacaoAberta}
				onFechar={() => setImportacaoAberta(false)}
				onSucesso={() => {
					void carregarLeads(busca);
					void carregarSistema();
				}}
			/>
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
