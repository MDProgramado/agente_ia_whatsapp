import { Bot, LoaderCircle, NotebookPen, User } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { ApiError, apiGet, apiPost } from "../api";

/**
 * Notas do lead (D-22/CRM-03) — as duas autorias na MESMA lista, distinguidas
 * por RÓTULO TEXTUAL ("Nota do Admin" × "Nota da IA"), nunca só por cor
 * (acessibilidade do UI-SPEC).
 *
 * A lista é APPEND-ONLY (R-043): o painel grava e lê, não reescreve nem apaga.
 * Nota escrita pelo painel nasce sempre com `authorType = "admin"` — a IA
 * grava a dela pelo copiloto do servidor.
 */

export interface NotaCrm {
	readonly id: string;
	readonly leadId: string;
	readonly conversationId: string | null;
	readonly body: string;
	readonly authorType: "admin" | "ia";
	readonly createdBy: string | null;
	readonly createdAt: string;
}

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

export interface LeadNotesProps {
	/** Lead selecionado; `null` enquanto nada está selecionado. */
	readonly leadId: string | null;
}

export function LeadNotes({ leadId }: LeadNotesProps) {
	const idCampo = useId();
	const [notas, setNotas] = useState<readonly NotaCrm[]>([]);
	const [carregando, setCarregando] = useState(false);
	const [erro, setErro] = useState<string | null>(null);
	const [texto, setTexto] = useState("");
	const [salvando, setSalvando] = useState(false);

	const carregar = useCallback(async (): Promise<void> => {
		if (leadId === null) {
			setNotas([]);
			return;
		}
		setCarregando(true);
		try {
			const resposta = await apiGet<{ itens: readonly NotaCrm[] }>(
				`/api/crm/leads/${encodeURIComponent(leadId)}/notes`,
			);
			setNotas(resposta.itens);
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

	const salvar = useCallback(async (): Promise<void> => {
		if (leadId === null || texto.trim() === "") return;
		setSalvando(true);
		try {
			await apiPost(`/api/crm/leads/${encodeURIComponent(leadId)}/notes`, {
				body: texto.trim(),
			});
			setTexto("");
			await carregar();
		} catch (causa) {
			setErro(mensagemDeErro(causa));
		} finally {
			setSalvando(false);
		}
	}, [leadId, texto, carregar]);

	const aoMudarTexto = useCallback(
		(evento: { target: { value: string } }) => setTexto(evento.target.value),
		[],
	);
	const aoSalvar = useCallback(() => void salvar(), [salvar]);

	return (
		<section aria-label="Notas do lead" className="flex flex-col gap-sm">
			<form
				onSubmit={(evento) => {
					evento.preventDefault();
					aoSalvar();
				}}
				className="flex flex-col gap-xs"
			>
				<label
					htmlFor={idCampo}
					className="text-xs font-semibold uppercase tracking-wide text-suave"
				>
					Nova nota
				</label>
				<textarea
					id={idCampo}
					value={texto}
					onChange={aoMudarTexto}
					rows={3}
					placeholder="Escreva o que precisa saber sobre este lead."
					disabled={leadId === null}
					className="w-full resize-y rounded border border-borda bg-fundo px-sm py-xs text-sm outline-none focus-visible:ring-2 focus-visible:ring-acento disabled:opacity-50"
				/>
				<div className="flex justify-end">
					<button
						type="submit"
						disabled={leadId === null || texto.trim() === "" || salvando}
						className="flex h-9 items-center gap-xs rounded bg-acento px-md text-sm font-semibold text-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{salvando ? (
							<LoaderCircle
								className="size-4 animate-spin"
								aria-hidden="true"
							/>
						) : (
							<NotebookPen className="size-4" aria-hidden="true" />
						)}
						Salvar nota
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
					Carregando notas…
				</p>
			) : null}

			<ul className="flex flex-col gap-xs">
				{notas.length === 0 && !carregando ? (
					<li className="text-sm text-suave">Nenhuma nota ainda.</li>
				) : null}
				{notas.map((nota) => {
					const daAdmin = nota.authorType === "admin";
					return (
						<li
							key={nota.id}
							className={`rounded border px-sm py-xs ${
								daAdmin
									? "border-l-4 border-l-acento border-borda bg-superficie"
									: "border-l-4 border-l-dashed border-l-suave border-borda bg-fundo"
							}`}
						>
							<span className="flex items-center gap-xs text-xs font-semibold">
								{daAdmin ? (
									<User className="size-3 text-acento" aria-hidden="true" />
								) : (
									<Bot className="size-3 text-suave" aria-hidden="true" />
								)}
								{daAdmin ? "Nota do Admin" : "Nota da IA"}
							</span>
							<span className="mt-0.5 block text-[11px] text-suave">
								{formatarData(nota.createdAt)}
							</span>
							<p className="mt-xs whitespace-pre-wrap text-sm">{nota.body}</p>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
