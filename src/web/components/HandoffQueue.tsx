import { ChevronRight, Inbox } from "lucide-react";
import type { ItemFilaHandoff } from "../api";

/**
 * Fila de handoffs pendentes (coluna direita, UI-SPEC §Component Inventory).
 *
 * Prioridade preservada: a ordenação vem do servidor (`/api/system`, com
 * desempate FIFO). Cada item leva ao lead/conversa correspondente — clicar
 * seleciona a conversa. Vazia ⇒ estado vazio literal "Nenhum handoff pendente."
 */
export interface HandoffQueueProps {
	readonly itens: readonly ItemFilaHandoff[];
	readonly onSelecionar: (item: ItemFilaHandoff) => void;
}

const formatarQuando = (iso: string): string => {
	const data = new Date(iso);
	if (Number.isNaN(data.getTime())) return "";
	return data.toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit" });
};

/** Rótulo pt-BR do gatilho, a partir do `triggered_by` do servidor. */
const ROTULO_GATILHO: Record<string, string> = {
	opt_out: "Opt-out",
	keyword: "Palavra-chave",
	intent: "Intenção",
	message_type: "Mídia recebida",
	validation_error: "Falha de validação",
	low_confidence: "Baixa confiança",
	user_defined: "Definido pelo Admin",
};

export function HandoffQueue({ itens, onSelecionar }: HandoffQueueProps) {
	return (
		<section
			aria-label="Fila de handoff"
			className="flex min-h-0 flex-col bg-superficie"
		>
			<div className="flex items-center gap-xs border-b border-borda px-md py-sm text-sm font-medium text-suave">
				<Inbox className="size-4" aria-hidden="true" />
				Handoff pendente
			</div>

			{itens.length === 0 ? (
				<div className="flex flex-1 items-center justify-center p-lg text-center">
					<p className="text-sm text-suave">Nenhum handoff pendente.</p>
				</div>
			) : (
				<ul className="rolagem-fina min-h-0 flex-1 overflow-y-auto">
					{itens.map((item) => (
						<li key={item.id}>
							<button
								type="button"
								onClick={() => onSelecionar(item)}
								className="flex w-full items-center gap-sm border-b border-borda px-md py-sm text-left hover:bg-superficie-alta"
							>
								<span className="flex min-w-0 flex-1 flex-col gap-xs">
									<span className="truncate text-sm font-semibold">
										{item.leadName ?? item.phoneNumber}
									</span>
									<span className="flex items-center gap-xs text-sm text-handoff">
										{ROTULO_GATILHO[item.triggeredBy] ?? item.triggeredBy}
										{formatarQuando(item.createdAt) !== "" ? (
											<>
												<span aria-hidden="true">·</span>
												<span className="tabular-nums text-suave">
													{formatarQuando(item.createdAt)}
												</span>
											</>
										) : null}
									</span>
									{item.excerpt !== "" ? (
										<span className="truncate text-sm text-suave">
											{item.excerpt}
										</span>
									) : null}
								</span>
								<ChevronRight
									className="size-4 shrink-0 text-suave"
									aria-hidden="true"
								/>
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
