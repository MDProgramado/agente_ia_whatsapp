import { Wifi, WifiOff } from "lucide-react";
import type { EstadoConexao } from "../useSse";

export interface ConnectionIndicatorProps {
	readonly conexao: EstadoConexao;
}

const ROTULOS: Record<EstadoConexao, { texto: string; classe: string }> = {
	"ao-vivo": { texto: "Ao vivo", classe: "text-acento" },
	conectando: { texto: "Conectando…", classe: "text-aviso" },
	reconectando: { texto: "Reconectando…", classe: "text-aviso" },
	"sem-conexao": { texto: "Sem conexão", classe: "text-perigo" },
};

/**
 * Indicador de conexão do cabeçalho (UI-SPEC §Component Inventory / 03-07).
 *
 * Ícone + rótulo + cor (nunca só cor) para acessibilidade.
 */
export function ConnectionIndicator({ conexao }: ConnectionIndicatorProps) {
	const config = ROTULOS[conexao] ?? ROTULOS["sem-conexao"];

	return (
		<span
			className={`flex items-center gap-xs text-sm ${config.classe}`}
			role="status"
			aria-live="polite"
		>
			{conexao === "ao-vivo" ? (
				<Wifi className="size-4" aria-hidden="true" />
			) : (
				<WifiOff className="size-4" aria-hidden="true" />
			)}
			<span>{config.texto}</span>
		</span>
	);
}
