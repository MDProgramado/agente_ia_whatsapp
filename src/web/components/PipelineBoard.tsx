import {
	AlertTriangle,
	History,
	LayoutGrid,
	LoaderCircle,
	Pencil,
	RefreshCw,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	exigeJustificativa,
	isMotivo,
	isPipelineStatus,
	MOTIVOS,
	type Motivo,
	PIPELINE_STATUS,
	type PipelineStatus,
	rotulo,
	rotuloMotivo,
} from "../../domain/pipeline";
import { ApiError, apiGet, apiPost } from "../api";

/**
 * Quadro do funil de vendas (CRM-01/RN-078) — as 9 colunas de `pipeline.ts`.
 *
 * Três responsabilidades, nenhuma delas reescreve o histórico:
 *
 *  1. **Listagem** — a busca é SERVER-SIDE (`q` em `GET /api/crm/conversations`),
 *     o painel nunca baixa a base inteira para filtrar no cliente (T-03-18).
 *  2. **Correção manual de status** (D-14/D-15/RN-080) — o Admin move o lead no
 *     funil; status terminal (`fechado`/`perdido`) exige justificativa e
 *     `perdido` exige MOTIVO do vocabulário de D-15. O erro de 4xx (ex.:
 *     `opt_out_irreversivel`, `transicao_invalida`) aparece INLINE no diálogo —
 *     nunca é engolido.
 *  3. **Histórico de mudanças** — SOMENTE LEITURA. A lista append-only vive no
 *     `App` (estado da sessão) e este componente só a desenha. Não existe, e não
 *     pode existir, controle que reescreva ou apague um registro de histórico
 *     (R-022/R-043).
 */

const tempoDaBusca = 250;
const TAMANHO_DA_PAGINA = 200;

export interface TagCrm {
	readonly id: string;
	readonly name: string;
}

/** Conversa como o CRM a devolve — `Date` do servidor já serializado em ISO. */
export interface ConversaCrm {
	readonly conversationId: string;
	readonly leadId: string;
	readonly name: string | null;
	readonly phoneNumber: string;
	readonly pipelineStatus: PipelineStatus;
	readonly state: string;
	readonly engagementMode: string;
	readonly handoffActive: boolean;
	readonly optOut: boolean;
	readonly responsibleUserId: string | null;
	readonly lastInboundAt: string | null;
	readonly lastOutboundAt: string | null;
	readonly createdAt: string;
	readonly tags: readonly TagCrm[];
}

/**
 * Uma mudança de status registrada pelo painel. É a linha que o `App` guarda
 * em memória: append-only, sem remoção, sem correção.
 */
export interface EntradaHistoricoStatus {
	readonly id: string;
	readonly conversationId: string;
	readonly de: PipelineStatus;
	readonly para: PipelineStatus;
	readonly em: string;
	readonly por: "admin";
}

interface CorrecaoResposta {
	readonly ok?: boolean;
	readonly de?: string;
	readonly para?: string;
	readonly statusHistoryId?: string;
	readonly erro?: string;
	readonly mensagem?: string;
	readonly detalhes?: readonly string[];
}

interface AlvoCorrecao {
	readonly conversationId: string;
	readonly leadId: string;
	readonly nome: string;
	readonly de: PipelineStatus;
}

const mensagemDeErro = (causa: unknown): string => {
	if (causa instanceof ApiError) return causa.message;
	return causa instanceof Error ? causa.message : String(causa);
};

/** Rótulo pt-BR de um status vindo do servidor (pode ser valor fora do domínio). */
const rotuloSeguro = (valor: string): string =>
	isPipelineStatus(valor) ? rotulo(valor) : valor;

const formatarData = (iso: string): string => {
	const data = new Date(iso);
	if (Number.isNaN(data.getTime())) return iso;
	return data.toLocaleString("pt-BR", {
		dateStyle: "short",
		timeStyle: "short",
	});
};

const nomeDoLead = (conversa: ConversaCrm): string =>
	conversa.name ?? conversa.phoneNumber;

const descreverErro = (resposta: CorrecaoResposta): string => {
	if (resposta.detalhes !== undefined && resposta.detalhes.length > 0) {
		return resposta.detalhes.join(" ");
	}
	if (resposta.mensagem !== undefined && resposta.mensagem !== "") {
		return resposta.mensagem;
	}
	if (resposta.erro !== undefined && resposta.erro !== "") return resposta.erro;
	return "Não foi possível corrigir o status do lead.";
};

export interface PipelineBoardProps {
	/** Histórico append-only da sessão (mantido pelo `App`). */
	readonly historico: readonly EntradaHistoricoStatus[];
	/** Abre o detalhe do lead (notas, tarefas, histórico). */
	readonly onAbrirLead: (conversa: ConversaCrm) => void;
	/** Recebe a mudança aplicada para que o `App` a registre no histórico. */
	readonly onCorrecaoAplicada: (entrada: EntradaHistoricoStatus) => void;
}

export function PipelineBoard({
	historico,
	onAbrirLead,
	onCorrecaoAplicada,
}: PipelineBoardProps) {
	const [conversas, setConversas] = useState<readonly ConversaCrm[]>([]);
	const [total, setTotal] = useState(0);
	const [carregando, setCarregando] = useState(false);
	const [erro, setErro] = useState<string | null>(null);
	const [termo, setTermo] = useState("");
	const [termoAplicado, setTermoAplicado] = useState("");

	const [alvo, setAlvo] = useState<AlvoCorrecao | null>(null);
	const [novoStatus, setNovoStatus] = useState<PipelineStatus | null>(null);
	const [motivo, setMotivo] = useState("");
	const [erroCorrecao, setErroCorrecao] = useState<string | null>(null);
	const [enviando, setEnviando] = useState(false);

	const dialogoRef = useRef<HTMLDialogElement | null>(null);
	const idDialogo = useId();
	const idStatus = useId();
	const idMotivo = useId();
	const idJustificativa = useId();

	const carregar = useCallback(async (): Promise<void> => {
		setCarregando(true);
		try {
			const busca = new URLSearchParams();
			if (termoAplicado !== "") busca.set("q", termoAplicado);
			busca.set("pageSize", String(TAMANHO_DA_PAGINA));
			const resposta = await apiGet<{
				itens: readonly ConversaCrm[];
				total: number;
			}>(`/api/crm/conversations?${busca.toString()}`);
			setConversas(resposta.itens);
			setTotal(resposta.total);
			setErro(null);
		} catch (causa) {
			setErro(mensagemDeErro(causa));
		} finally {
			setCarregando(false);
		}
	}, [termoAplicado]);

	// Debounce da busca server-side (mesmo padrão do `App`).
	useEffect(() => {
		const t = setTimeout(() => setTermoAplicado(termo), tempoDaBusca);
		return () => clearTimeout(t);
	}, [termo]);

	useEffect(() => {
		void carregar();
	}, [carregar]);

	const porStatus = useMemo(() => {
		const mapa = new Map<PipelineStatus, ConversaCrm[]>();
		for (const status of PIPELINE_STATUS) mapa.set(status, []);
		for (const conversa of conversas) {
			if (!isPipelineStatus(conversa.pipelineStatus)) continue;
			mapa.get(conversa.pipelineStatus)?.push(conversa);
		}
		return mapa;
	}, [conversas]);

	const abrirCorrecao = useCallback((conversa: ConversaCrm): void => {
		setAlvo({
			conversationId: conversa.conversationId,
			leadId: conversa.leadId,
			nome: nomeDoLead(conversa),
			de: conversa.pipelineStatus,
		});
		setNovoStatus(null);
		setMotivo("");
		setErroCorrecao(null);
		dialogoRef.current?.showModal();
	}, []);

	const fecharCorrecao = useCallback((): void => {
		dialogoRef.current?.close();
		setAlvo(null);
		setNovoStatus(null);
		setMotivo("");
		setErroCorrecao(null);
	}, []);

	const confirmarCorrecao = useCallback(async (): Promise<void> => {
		if (alvo === null || novoStatus === null) return;
		const motivoLimpo = motivo.trim();
		if (novoStatus === "perdido" && !isMotivo(motivoLimpo)) {
			setErroCorrecao("Escolha o motivo de Perdido (D-15).");
			return;
		}
		if (exigeJustificativa(novoStatus) && motivoLimpo === "") {
			setErroCorrecao(`${rotulo(novoStatus)} exige justificativa (RN-080).`);
			return;
		}
		setEnviando(true);
		setErroCorrecao(null);
		try {
			const resposta = await apiPost<CorrecaoResposta>(
				`/api/crm/conversations/${encodeURIComponent(alvo.conversationId)}/status`,
				{
					para: novoStatus,
					...(motivoLimpo === "" ? {} : { motivo: motivoLimpo }),
					manual: true,
				},
			);
			if (resposta.ok !== true) {
				// 4xx do servidor (ex.: `opt_out_irreversivel`): exibido inline.
				setErroCorrecao(descreverErro(resposta));
				return;
			}
			onCorrecaoAplicada({
				id: resposta.statusHistoryId ?? `${alvo.conversationId}-${Date.now()}`,
				conversationId: alvo.conversationId,
				de: isPipelineStatus(resposta.de) ? resposta.de : alvo.de,
				para: isPipelineStatus(resposta.para) ? resposta.para : novoStatus,
				em: new Date().toISOString(),
				por: "admin",
			});
			fecharCorrecao();
			await carregar();
		} catch (causa) {
			setErroCorrecao(mensagemDeErro(causa));
		} finally {
			setEnviando(false);
		}
	}, [alvo, novoStatus, motivo, onCorrecaoAplicada, fecharCorrecao, carregar]);

	const aoMudarTermo = useCallback(
		(evento: { target: { value: string } }) => setTermo(evento.target.value),
		[],
	);
	const aoMudarStatus = useCallback((evento: { target: { value: string } }) => {
		const valor = evento.target.value;
		setNovoStatus(isPipelineStatus(valor) ? valor : null);
		setMotivo("");
		setErroCorrecao(null);
	}, []);
	const aoMudarMotivo = useCallback(
		(evento: { target: { value: string } }) => setMotivo(evento.target.value),
		[],
	);
	const aoRecarregar = useCallback(() => void carregar(), [carregar]);
	const aoConfirmar = useCallback(
		() => void confirmarCorrecao(),
		[confirmarCorrecao],
	);

	return (
		<section
			aria-label="Pipeline de vendas"
			className="flex min-h-0 flex-1 flex-col bg-fundo"
		>
			<div className="flex flex-wrap items-center gap-sm border-b border-borda bg-superficie px-lg py-sm">
				<LayoutGrid className="size-4 text-acento" aria-hidden="true" />
				<h2 className="text-sm font-semibold">Pipeline</h2>
				<span className="text-xs tabular-nums text-suave">
					{total} {total === 1 ? "conversa" : "conversas"}
				</span>
				<input
					value={termo}
					onChange={aoMudarTermo}
					placeholder="Buscar por nome ou telefone"
					aria-label="Buscar lead por nome ou telefone"
					className="ml-auto h-8 w-[260px] rounded border border-borda bg-fundo px-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-acento"
				/>
				<button
					type="button"
					onClick={aoRecarregar}
					className="flex h-8 items-center gap-xs rounded border border-borda px-sm text-sm hover:bg-superficie-alta"
				>
					{carregando ? (
						<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
					) : (
						<RefreshCw className="size-4" aria-hidden="true" />
					)}
					Atualizar
				</button>
			</div>

			{erro !== null ? (
				<div
					role="alert"
					className="border-b border-perigo/40 bg-perigo/10 px-lg py-sm text-sm"
				>
					{erro}
				</div>
			) : null}

			<div className="flex min-h-0 flex-1">
				<div className="flex min-h-0 flex-1 overflow-x-auto">
					{PIPELINE_STATUS.map((status) => {
						const itens = porStatus.get(status) ?? [];
						return (
							<div
								key={status}
								className="flex w-[240px] shrink-0 flex-col border-r border-borda"
							>
								<div className="flex items-center justify-between border-b border-borda bg-superficie-alta px-sm py-xs">
									<span className="text-xs font-semibold uppercase tracking-wide">
										{rotulo(status)}
									</span>
									<span className="text-xs tabular-nums text-suave">
										{itens.length}
									</span>
								</div>
								<ul className="min-h-0 flex-1 overflow-y-auto p-xs">
									{itens.length === 0 ? (
										<li className="px-xs py-sm text-xs text-suave">
											Nenhum lead neste status.
										</li>
									) : null}
									{itens.map((conversa) => (
										<li
											key={conversa.conversationId}
											className="mb-xs rounded border border-borda bg-superficie p-xs"
										>
											<button
												type="button"
												onClick={() => onAbrirLead(conversa)}
												className="w-full text-left"
											>
												<span className="block truncate text-sm font-semibold">
													{nomeDoLead(conversa)}
												</span>
												<span className="block truncate text-xs text-suave">
													{conversa.phoneNumber}
												</span>
											</button>
											<div className="mt-xs flex flex-wrap items-center gap-xs">
												{conversa.optOut ? (
													<span className="rounded border border-perigo/50 px-xs text-[11px] text-perigo">
														Opt-out
													</span>
												) : null}
												{conversa.handoffActive ? (
													<span className="rounded border border-handoff/50 px-xs text-[11px] text-handoff">
														Handoff
													</span>
												) : null}
												{conversa.tags.map((tag) => (
													<span
														key={tag.id}
														className="rounded border border-borda px-xs text-[11px] text-suave"
													>
														{tag.name}
													</span>
												))}
												<button
													type="button"
													onClick={() => abrirCorrecao(conversa)}
													className="ml-auto flex items-center gap-xs rounded border border-borda px-xs text-[11px] hover:bg-superficie-alta"
												>
													<Pencil className="size-3" aria-hidden="true" />
													Corrigir status
												</button>
											</div>
										</li>
									))}
								</ul>
							</div>
						);
					})}
				</div>

				<HistoricoStatus entradas={historico} />
			</div>

			<dialog
				ref={dialogoRef}
				aria-labelledby={idDialogo}
				className="m-auto w-[440px] rounded-lg border border-borda bg-superficie p-lg text-texto backdrop:bg-black/60"
			>
				<h2 id={idDialogo} className="text-base font-semibold">
					Corrigir status do lead
				</h2>
				{alvo !== null ? (
					<p className="mt-sm text-sm text-suave">
						{alvo.nome} está em{" "}
						<span className="text-texto">{rotulo(alvo.de)}</span>.
					</p>
				) : null}

				<label
					htmlFor={idStatus}
					className="mt-md block text-xs font-semibold uppercase tracking-wide text-suave"
				>
					Novo status
				</label>
				<select
					id={idStatus}
					value={novoStatus ?? ""}
					onChange={aoMudarStatus}
					aria-label="Novo status do lead"
					className="mt-xs h-9 w-full rounded border border-borda bg-fundo px-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-acento"
				>
					<option value="">Selecione o status</option>
					{PIPELINE_STATUS.filter(
						(status) => alvo === null || status !== alvo.de,
					).map((status) => (
						<option key={status} value={status}>
							{rotulo(status)}
						</option>
					))}
				</select>

				{novoStatus === "perdido" ? (
					<>
						<label
							htmlFor={idMotivo}
							className="mt-md block text-xs font-semibold uppercase tracking-wide text-suave"
						>
							Motivo do encerramento
						</label>
						<select
							id={idMotivo}
							value={isMotivo(motivo) ? motivo : ""}
							onChange={aoMudarMotivo}
							aria-label="Motivo do encerramento"
							className="mt-xs h-9 w-full rounded border border-borda bg-fundo px-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-acento"
						>
							<option value="">Selecione o motivo</option>
							{MOTIVOS.map((valor: Motivo) => (
								<option key={valor} value={valor}>
									{rotuloMotivo(valor)}
								</option>
							))}
						</select>
					</>
				) : (
					<>
						<label
							htmlFor={idJustificativa}
							className="mt-md block text-xs font-semibold uppercase tracking-wide text-suave"
						>
							{novoStatus !== null && exigeJustificativa(novoStatus)
								? "Justificativa"
								: "Observação (opcional)"}
						</label>
						<input
							id={idJustificativa}
							value={motivo}
							onChange={aoMudarMotivo}
							aria-label={
								novoStatus !== null && exigeJustificativa(novoStatus)
									? "Justificativa da mudança de status"
									: "Observação da mudança de status"
							}
							className="mt-xs h-9 w-full rounded border border-borda bg-fundo px-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-acento"
						/>
					</>
				)}

				{erroCorrecao !== null ? (
					<div
						role="alert"
						className="mt-md flex items-start gap-xs rounded border border-perigo/50 bg-perigo/10 px-sm py-xs text-sm"
					>
						<AlertTriangle
							className="mt-0.5 size-4 shrink-0 text-perigo"
							aria-hidden="true"
						/>
						<span>{erroCorrecao}</span>
					</div>
				) : null}

				<div className="mt-lg flex justify-end gap-sm">
					<button
						type="button"
						onClick={fecharCorrecao}
						className="h-9 rounded border border-borda px-md hover:bg-superficie-alta"
					>
						Cancelar
					</button>
					<button
						type="button"
						disabled={novoStatus === null || enviando}
						onClick={aoConfirmar}
						className="flex h-9 items-center gap-xs rounded bg-acento px-md font-semibold text-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{enviando ? (
							<LoaderCircle
								className="size-4 animate-spin"
								aria-hidden="true"
							/>
						) : null}
						Salvar status
					</button>
				</div>
			</dialog>
		</section>
	);
}

/**
 * Histórico de mudanças de status — SOMENTE LEITURA (R-022/R-043).
 *
 * Não há, e não pode haver, controle que reescreva ou apague um registro: a
 * lista é append-only e nasce das correções aplicadas pelo próprio painel.
 */
export function HistoricoStatus({
	entradas,
	className,
}: {
	readonly entradas: readonly EntradaHistoricoStatus[];
	/** Ajuste de largura quando o histórico é embutido em outro painel. */
	readonly className?: string;
}) {
	return (
		<aside
			aria-label="Histórico de status"
			className={`flex w-[300px] shrink-0 flex-col border-l border-borda bg-superficie ${className ?? ""}`}
		>
			<div className="flex items-center gap-xs border-b border-borda bg-superficie-alta px-sm py-xs">
				<History className="size-4 text-suave" aria-hidden="true" />
				<span className="text-xs font-semibold uppercase tracking-wide">
					Histórico de status
				</span>
			</div>
			<p className="px-sm py-xs text-[11px] text-suave">
				Registro imutável das mudanças aplicadas pelo painel (somente leitura).
			</p>
			<ul className="min-h-0 flex-1 overflow-y-auto px-sm pb-sm">
				{entradas.length === 0 ? (
					<li className="text-xs text-suave">
						Nenhuma mudança de status registrada nesta sessão.
					</li>
				) : null}
				{entradas.map((entrada) => (
					<li
						key={entrada.id}
						className="mb-xs rounded border border-borda bg-fundo px-sm py-xs text-xs"
					>
						<span className="block">
							<span className="text-suave">{rotuloSeguro(entrada.de)}</span>
							<span aria-hidden="true"> → </span>
							<span className="font-semibold">
								{rotuloSeguro(entrada.para)}
							</span>
						</span>
						<span className="mt-0.5 block text-[11px] text-suave">
							{formatarData(entrada.em)} · Admin
						</span>
					</li>
				))}
			</ul>
		</aside>
	);
}
