import {
	CalendarClock,
	CheckCircle2,
	LoaderCircle,
	RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { ApiError, apiGet, apiPatch, apiPost } from "../api";

/**
 * Tarefas e lembretes do lead (D-22) — `due_at`, status e responsável.
 *
 * A lista vem do servidor (`GET /api/crm/tasks?leadId=`) e a escrita passa
 * pelos mesmos endpoints do CRM (`POST` cria, `PATCH /api/crm/tasks/:id`
 * atualiza). O responsável é lido do payload da tarefa — o painel não tem
 * cadastro de usuários próprio.
 *
 * R-027: o piloto tem UM operador. Por isso a etiqueta é "Admin" quando há
 * responsável e "Sem responsável" quando `responsible_user_id` é nulo; o id
 * cru fica no `title` para conferência.
 */

export type StatusTarefa = "pending" | "done" | "cancelled";

export interface TarefaCrm {
	readonly id: string;
	readonly leadId: string;
	readonly title: string;
	readonly status: StatusTarefa;
	readonly dueAt: string | null;
	readonly responsibleUserId: string | null;
	readonly createdBy: string | null;
	readonly createdAt: string;
}

const ROTULO_STATUS: Record<StatusTarefa, string> = {
	pending: "Pendente",
	done: "Concluída",
	cancelled: "Cancelada",
};

const mensagemDeErro = (causa: unknown): string => {
	if (causa instanceof ApiError) return causa.message;
	return causa instanceof Error ? causa.message : String(causa);
};

const formatarData = (iso: string): string => {
	const data = new Date(iso);
	if (Number.isNaN(data.getTime())) return iso;
	return data.toLocaleString("pt-BR", {
		dateStyle: "short",
		timeStyle: "short",
	});
};

/** `datetime-local` → ISO UTC (o servidor grava `timestamptz`). */
const paraIso = (valor: string): string | null => {
	if (valor === "") return null;
	const data = new Date(valor);
	if (Number.isNaN(data.getTime())) return null;
	return data.toISOString();
};

/** Rótulo do responsável (R-027 — operador único). */
const rotuloResponsavel = (tarefa: TarefaCrm): string =>
	tarefa.responsibleUserId === null ? "Sem responsável" : "Admin";

export interface TaskListProps {
	/** Lead selecionado; `null` enquanto nada está selecionado. */
	readonly leadId: string | null;
}

export function TaskList({ leadId }: TaskListProps) {
	const idTitulo = useId();
	const idVencimento = useId();
	const [tarefas, setTarefas] = useState<readonly TarefaCrm[]>([]);
	const [carregando, setCarregando] = useState(false);
	const [erro, setErro] = useState<string | null>(null);
	const [titulo, setTitulo] = useState("");
	const [vencimento, setVencimento] = useState("");
	const [salvando, setSalvando] = useState(false);
	const [alterandoId, setAlterandoId] = useState<string | null>(null);

	const carregar = useCallback(async (): Promise<void> => {
		if (leadId === null) {
			setTarefas([]);
			return;
		}
		setCarregando(true);
		try {
			const busca = new URLSearchParams();
			busca.set("leadId", leadId);
			const resposta = await apiGet<{ itens: readonly TarefaCrm[] }>(
				`/api/crm/tasks?${busca.toString()}`,
			);
			setTarefas(resposta.itens);
			setErro(null);
		} catch (causa) {
			setErro(mensagemDeErro(causa));
		} finally {
			setCarregando(false);
		}
	}, [leadId]);

	useEffect(() => {
		void carregar();
	}, [carregar]);

	const criar = useCallback(async (): Promise<void> => {
		if (leadId === null || titulo.trim() === "") return;
		setSalvando(true);
		try {
			await apiPost("/api/crm/tasks", {
				leadId,
				title: titulo.trim(),
				dueAt: paraIso(vencimento),
			});
			setTitulo("");
			setVencimento("");
			await carregar();
		} catch (causa) {
			setErro(mensagemDeErro(causa));
		} finally {
			setSalvando(false);
		}
	}, [leadId, titulo, vencimento, carregar]);

	const mudarStatus = useCallback(
		async (tarefa: TarefaCrm, status: StatusTarefa): Promise<void> => {
			setAlterandoId(tarefa.id);
			try {
				await apiPatch(`/api/crm/tasks/${encodeURIComponent(tarefa.id)}`, {
					status,
				});
				await carregar();
			} catch (causa) {
				setErro(mensagemDeErro(causa));
			} finally {
				setAlterandoId(null);
			}
		},
		[carregar],
	);

	const aoMudarTitulo = useCallback(
		(evento: { target: { value: string } }) => setTitulo(evento.target.value),
		[],
	);
	const aoMudarVencimento = useCallback(
		(evento: { target: { value: string } }) =>
			setVencimento(evento.target.value),
		[],
	);
	const aoCriar = useCallback(() => void criar(), [criar]);
	const aoConcluir = useCallback(
		(tarefa: TarefaCrm) => void mudarStatus(tarefa, "done"),
		[mudarStatus],
	);
	const aoReabrir = useCallback(
		(tarefa: TarefaCrm) => void mudarStatus(tarefa, "pending"),
		[mudarStatus],
	);

	return (
		<section aria-label="Tarefas do lead" className="flex flex-col gap-sm">
			<form
				onSubmit={(evento) => {
					evento.preventDefault();
					aoCriar();
				}}
				className="flex flex-col gap-xs"
			>
				<label
					htmlFor={idTitulo}
					className="text-xs font-semibold uppercase tracking-wide text-suave"
				>
					Nova tarefa
				</label>
				<input
					id={idTitulo}
					value={titulo}
					onChange={aoMudarTitulo}
					placeholder="Ex.: retornar a proposta com o desconto"
					disabled={leadId === null}
					className="h-9 w-full rounded border border-borda bg-fundo px-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-acento disabled:opacity-50"
				/>
				<label
					htmlFor={idVencimento}
					className="text-xs font-semibold uppercase tracking-wide text-suave"
				>
					Vencimento (opcional)
				</label>
				<input
					id={idVencimento}
					type="datetime-local"
					value={vencimento}
					onChange={aoMudarVencimento}
					disabled={leadId === null}
					className="h-9 w-full rounded border border-borda bg-fundo px-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-acento disabled:opacity-50"
				/>
				<div className="flex justify-end">
					<button
						type="submit"
						disabled={leadId === null || titulo.trim() === "" || salvando}
						className="flex h-9 items-center gap-xs rounded bg-acento px-md text-sm font-semibold text-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{salvando ? (
							<LoaderCircle
								className="size-4 animate-spin"
								aria-hidden="true"
							/>
						) : null}
						Criar tarefa
					</button>
				</div>
			</form>

			{erro !== null ? (
				<div
					role="alert"
					className="rounded border border-perigo/40 bg-perigo/10 px-sm py-xs text-sm"
				>
					{erro}
				</div>
			) : null}

			{carregando ? (
				<p className="flex items-center gap-xs text-xs text-suave">
					<LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
					Carregando tarefas…
				</p>
			) : null}

			<ul className="flex flex-col gap-xs">
				{tarefas.length === 0 && !carregando ? (
					<li className="text-sm text-suave">Nenhuma tarefa ainda.</li>
				) : null}
				{tarefas.map((tarefa) => (
					<li
						key={tarefa.id}
						className="rounded border border-borda bg-superficie px-sm py-xs"
					>
						<span className="flex items-start gap-xs">
							<span className="text-sm font-semibold">{tarefa.title}</span>
							<span className="ml-auto shrink-0 rounded border border-borda px-xs text-[11px] text-suave">
								{ROTULO_STATUS[tarefa.status]}
							</span>
						</span>
						<span className="mt-0.5 flex flex-wrap items-center gap-xs text-[11px] text-suave">
							<span className="flex items-center gap-xs">
								<CalendarClock className="size-3" aria-hidden="true" />
								{tarefa.dueAt === null
									? "Sem vencimento"
									: `Vence em ${formatarData(tarefa.dueAt)}`}
							</span>
							<span aria-hidden="true">·</span>
							<span title={tarefa.responsibleUserId ?? undefined}>
								{rotuloResponsavel(tarefa)}
							</span>
						</span>
						{tarefa.status === "cancelled" ? null : (
							<div className="mt-xs flex justify-end">
								{tarefa.status === "pending" ? (
									<button
										type="button"
										disabled={alterandoId === tarefa.id}
										onClick={() => aoConcluir(tarefa)}
										className="flex items-center gap-xs rounded border border-borda px-xs text-[11px] hover:bg-superficie-alta disabled:opacity-40"
									>
										<CheckCircle2 className="size-3" aria-hidden="true" />
										Concluir
									</button>
								) : (
									<button
										type="button"
										disabled={alterandoId === tarefa.id}
										onClick={() => aoReabrir(tarefa)}
										className="flex items-center gap-xs rounded border border-borda px-xs text-[11px] hover:bg-superficie-alta disabled:opacity-40"
									>
										<RotateCcw className="size-3" aria-hidden="true" />
										Reabrir
									</button>
								)}
							</div>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}
