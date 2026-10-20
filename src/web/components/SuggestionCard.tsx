import { Check, Pencil, Sparkles, X } from "lucide-react";
import type { Mensagem } from "../api";

/**
 * Sugestão do copiloto (UI-SPEC §Interaction & State Contract / R-014, FLUP-06).
 *
 * Ciclo de vida da sugestão: `sugerida` → (`Aceitar` | `Editar` | `Ignorar`).
 *
 * **Nenhuma delas envia.** Aceitar e Editar apenas preenchem o campo do
 * compositor; o envio é SEMPRE o clique explícito em **Enviar**, que passa pelo
 * mesmo gate com `origin='admin'` (D-24, T-03-22). O bot nunca envia sozinho em
 * copiloto.
 */
export interface SuggestionCardProps {
	readonly sugestao: Mensagem | null;
	readonly onAplicar: (texto: string, focar: boolean) => void;
	readonly onIgnorar: () => void;
}

const rotuloBotao =
	"flex h-9 items-center gap-xs rounded border border-borda px-sm text-sm hover:bg-superficie-alta";

export function SuggestionCard({
	sugestao,
	onAplicar,
	onIgnorar,
}: SuggestionCardProps) {
	return (
		<section
			aria-label="Sugestão do copiloto"
			className="flex min-h-0 flex-col bg-superficie"
		>
			<div className="flex items-center gap-xs border-b border-borda px-md py-sm text-sm font-medium text-suave">
				<Sparkles className="size-4" aria-hidden="true" />
				Copiloto
			</div>

			{sugestao === null ? (
				<div className="flex flex-1 items-center justify-center p-md text-center">
					<p className="text-sm text-suave">Nenhuma sugestão no momento.</p>
				</div>
			) : (
				<div className="flex min-h-0 flex-1 flex-col gap-sm p-md">
					<p className="text-sm font-semibold">
						Sugestão do copiloto — revise antes de enviar
					</p>
					<p className="rolagem-fina max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-borda bg-fundo p-sm text-sm">
						{sugestao.body}
					</p>
					<div className="flex flex-wrap gap-xs">
						<button
							type="button"
							onClick={() => onAplicar(sugestao.body, false)}
							className={rotuloBotao}
						>
							<Check className="size-4" aria-hidden="true" />
							Aceitar
						</button>
						<button
							type="button"
							onClick={() => onAplicar(sugestao.body, true)}
							className={rotuloBotao}
						>
							<Pencil className="size-4" aria-hidden="true" />
							Editar
						</button>
						<button type="button" onClick={onIgnorar} className={rotuloBotao}>
							<X className="size-4" aria-hidden="true" />
							Ignorar
						</button>
					</div>
					<p className="text-sm text-suave">
						Aceitar e Editar só preenchem o campo — o envio é sempre pelo botão
						<b> Enviar</b>.
					</p>
				</div>
			)}
		</section>
	);
}
