import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * Diálogo de confirmação reutilizável (UI-SPEC §Component Inventory).
 *
 * `<dialog>` NATIVO com `showModal()`: focus-trap e `Esc` são do próprio
 * elemento do navegador (UI-SPEC §Accessibility & Keyboard). Duas variantes:
 *
 *   - **simples**: só confirmar/cancelar;
 *   - **type-to-confirm**: o botão destrutivo só habilita quando o texto
 *     digitado é EXATAMENTE a string exigida (case-sensitive). É a barreira
 *     de cliente do opt-out (T-03-41) — o servidor exige o mesmo literal.
 *
 * O diálogo de kill switch do 03-04 NÃO é este componente e não foi
 * refatorado: ele já foi aceito no plano dele. Este é o primitivo dos usos
 * novos.
 */

export interface ConfirmDialogProps {
	/** Aberto? O componente cuida de `showModal()`/`close()`. */
	readonly aberto: boolean;
	readonly titulo: string;
	readonly descricao: string;
	/**
	 * Texto EXATO exigido para confirmar. `null` (ou ausente) = variante
	 * simples, sem campo de texto.
	 */
	readonly textoExigido?: string | null;
	readonly rotuloConfirmar: string;
	/** Rótulo do botão de cancelamento (padrão: "Cancelar"). */
	readonly rotuloCancelar?: string;
	/** Confirmação destrutiva — botão em vermelho. */
	readonly destrutivo?: boolean;
	/** Operação em andamento — o botão confirmar mostra spinner e trava. */
	readonly ocupado?: boolean;
	/** Erro a exibir dentro do diálogo. */
	readonly erro?: string | null;
	readonly onConfirmar: () => void;
	readonly onCancelar: () => void;
}

export function ConfirmDialog({
	aberto,
	titulo,
	descricao,
	textoExigido = null,
	rotuloConfirmar,
	rotuloCancelar = "Cancelar",
	destrutivo = false,
	ocupado = false,
	erro = null,
	onConfirmar,
	onCancelar,
}: ConfirmDialogProps) {
	const dialogoRef = useRef<HTMLDialogElement | null>(null);
	const idTitulo = useId();
	const idCampo = useId();
	const [valor, setValor] = useState("");

	// `showModal()`/`close()` são efeito do estado `aberto`. O guard
	// `!dialogo.open` evita o `InvalidStateError` de chamar `showModal()` em
	// um diálogo já aberto (StrictMode monta duas vezes em dev).
	useEffect(() => {
		const dialogo = dialogoRef.current;
		if (dialogo === null) return;
		if (aberto && !dialogo.open) dialogo.showModal();
		if (!aberto && dialogo.open) dialogo.close();
	}, [aberto]);

	// Cada abertura começa sem texto digitado: uma confirmação anterior não
	// pode "pré-aprovar" a próxima.
	useEffect(() => {
		if (!aberto) setValor("");
	}, [aberto]);

	const aoFechar = useCallback(() => {
		onCancelar();
	}, [onCancelar]);

	const aoMudarValor = useCallback(
		(evento: { target: { value: string } }) => setValor(evento.target.value),
		[],
	);

	const exigeTexto = textoExigido !== null;
	const confirmacaoValida = exigeTexto ? valor === textoExigido : true;

	return (
		<dialog
			ref={dialogoRef}
			aria-labelledby={idTitulo}
			onClose={aoFechar}
			className="m-auto w-[420px] rounded-lg border border-borda bg-superficie p-lg text-texto backdrop:bg-black/60"
		>
			<h2 id={idTitulo} className="text-base font-semibold">
				{titulo}
			</h2>
			<p className="mt-sm text-sm text-suave">{descricao}</p>

			{exigeTexto ? (
				<>
					<label
						htmlFor={idCampo}
						className="mt-md block text-xs font-semibold uppercase tracking-wide text-suave"
					>
						Digite {textoExigido} para confirmar
					</label>
					<input
						id={idCampo}
						value={valor}
						onChange={aoMudarValor}
						autoComplete="off"
						aria-label={`Digite ${textoExigido} para confirmar`}
						className="mt-xs w-full rounded border border-borda bg-fundo px-sm py-xs text-sm outline-none focus-visible:ring-2 focus-visible:ring-acento"
					/>
				</>
			) : null}

			{erro !== null ? (
				<div
					role="alert"
					className="mt-md rounded border border-perigo/40 bg-perigo/10 px-sm py-xs text-sm"
				>
					{erro}
				</div>
			) : null}

			<div className="mt-md flex justify-end gap-sm">
				<button
					type="button"
					onClick={aoFechar}
					disabled={ocupado}
					className="h-9 rounded border border-borda px-md hover:bg-superficie-alta disabled:opacity-40"
				>
					{rotuloCancelar}
				</button>
				<button
					type="button"
					disabled={!confirmacaoValida || ocupado}
					onClick={onConfirmar}
					className={`flex h-9 items-center gap-xs rounded px-md font-semibold text-slate-50 disabled:cursor-not-allowed disabled:opacity-40 ${
						destrutivo ? "bg-perigo" : "bg-acento"
					}`}
				>
					{ocupado ? (
						<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
					) : null}
					{rotuloConfirmar}
				</button>
			</div>
		</dialog>
	);
}
