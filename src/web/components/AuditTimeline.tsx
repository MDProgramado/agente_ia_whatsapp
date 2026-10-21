import { Ban, CircleAlert, Inbox, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { HistoricoMensagens, TrilhaAuditoria } from "../api";
import { ApiError, buscarAuditTrail, buscarHistorico } from "../api";

/**
 * Linha do tempo de auditoria do lead (D-23, R-022/R-043) — **somente leitura**.
 *
 * FUNDE as QUATRO fontes append-only do painel numa lista só:
 *   - `messages`       → o que foi dito;
 *   - `status_history` → as transições de estado;
 *   - `handoff_events` → os handoffs disparados;
 *   - `blocked_attempts` → os negativos do gate.
 *
 * Por que fundir: o Admin precisa da ORDEM dos fatos, não de quatro listas
 * para conferir de cabeça. Por que read-only: histórico que pode ser corrigido
 * depois não é histórico — nenhuma fonte deste arquivo é mutada, e não há
 * controle de mutação aqui (D-23).
 *
 * Cada linha marca a ORIGEM com ícone + rótulo textual (nunca só cor) e um
 * timestamp tabular, do mais recente para o mais antigo.
 */

/** De onde veio a linha — ícone + rótulo, nunca só cor (acessibilidade). */
type Origem = "mensagem" | "status" | "handoff" | "bloqueio";

interface LinhaDaLinhaDoTempo {
	readonly id: string;
	readonly origem: Origem;
	readonly titulo: string;
	readonly detalhe: string | null;
	readonly em: string | null;
}

export interface AuditTimelineProps {
	/** Conversa auditada; `null` enquanto o lead não tem conversa. */
	readonly conversationId: string | null;
}

/** Rótulo da origem — a fonte da verdade é textual, o ícone é reforço. */
const ROTULO_ORIGEM: Record<Origem, string> = {
	mensagem: "Mensagem",
	status: "Status",
	handoff: "Handoff",
	bloqueio: "Bloqueio",
};

/** Data + hora pt-BR; `null` quando o fato não tem instante conhecido. */
const formatarInstante = (iso: string | null): string => {
	if (iso === null) return "—";
	const data = new Date(iso);
	if (Number.isNaN(data.getTime())) return "—";
	return data.toLocaleString("pt-BR", {
		dateStyle: "short",
		timeStyle: "short",
	});
};

const mensagemDeErro = (causa: unknown): string => {
	if (causa instanceof ApiError) return causa.message;
	return causa instanceof Error ? causa.message : String(causa);
};

/** Recorte curto para a linha do tempo — o texto integral está no histórico. */
const CORTE = 140;
const cortar = (texto: string): string =>
	texto.length <= CORTE ? texto : `${texto.slice(0, CORTE)}…`;

/**
 * Chave de ordenação: o instante em epoch ms. `null` vai para o fim — um fato
 * sem instante é menos informativo, não mais recente.
 */
const instante = (iso: string | null): number => {
	if (iso === null) return Number.NEGATIVE_INFINITY;
	const t = new Date(iso).getTime();
	return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

export function AuditTimeline({ conversationId }: AuditTimelineProps) {
	const [trilha, setTrilha] = useState<TrilhaAuditoria | null>(null);
	const [historico, setHistorico] = useState<HistoricoMensagens | null>(null);
	const [carregando, setCarregando] = useState(false);
	const [erro, setErro] = useState<string | null>(null);

	const carregar = useCallback(async (): Promise<void> => {
		if (conversationId === null) {
			setTrilha(null);
			setHistorico(null);
			return;
		}
		setCarregando(true);
		try {
			// Sequencial: as duas leituras são locais e o ganho de paralelizar
			// não paga a duplicação de estado de erro.
			const trilhaLida = await buscarAuditTrail(conversationId);
			const historicoLido = await buscarHistorico(conversationId);
			setTrilha(trilhaLida);
			setHistorico(historicoLido);
			setErro(null);
		} catch (causa) {
			setErro(mensagemDeErro(causa));
		} finally {
			setCarregando(false);
		}
	}, [conversationId]);

	useEffect(() => {
		void carregar();
	}, [carregar]);

	const linhas = useMemo<LinhaDaLinhaDoTempo[]>(() => {
		if (trilha === null || historico === null) return [];

		const mensagens: LinhaDaLinhaDoTempo[] = historico.itens.map(
			(mensagem) => ({
				id: `mensagem:${mensagem.id}`,
				origem: "mensagem",
				titulo: mensagem.direction === "in" ? "Lead" : "Você",
				detalhe: cortar(mensagem.body),
				em: mensagem.createdAt,
			}),
		);

		const status: LinhaDaLinhaDoTempo[] = trilha.statusHistory.map(
			(entrada) => ({
				id: `status:${entrada.id}`,
				origem: "status",
				titulo: "Mudança de estado",
				detalhe: [
					entrada.fromState ?? "—",
					"→",
					entrada.toState ?? "—",
					entrada.reason === null ? null : `(${entrada.reason})`,
				]
					.filter((parte) => parte !== null)
					.join(" "),
				em: entrada.changedAt,
			}),
		);

		const handoffs: LinhaDaLinhaDoTempo[] = trilha.handoffEvents.map(
			(evento) => ({
				id: `handoff:${evento.id}`,
				origem: "handoff",
				titulo: evento.triggerDetail ?? "Handoff acionado",
				detalhe: evento.excerpt === null ? null : cortar(evento.excerpt),
				em: evento.createdAt,
			}),
		);

		const bloqueios: LinhaDaLinhaDoTempo[] = trilha.blockedAttempts.map(
			(negativo) => ({
				id: `bloqueio:${negativo.id}`,
				origem: "bloqueio",
				titulo: `Guard ${negativo.guard} bloqueou a mensagem`,
				detalhe:
					negativo.detail === null
						? negativo.ruleReference
						: `${negativo.ruleReference ?? negativo.guard}: ${cortar(negativo.detail)}`,
				em: negativo.blockedAt ?? negativo.createdAt,
			}),
		);

		return [...mensagens, ...status, ...handoffs, ...bloqueios].sort(
			(a, b) => instante(b.em) - instante(a.em),
		);
	}, [trilha, historico]);

	if (conversationId === null) {
		return (
			<p className="text-sm text-suave">
				Este lead ainda não tem conversa — não há histórico para auditar.
			</p>
		);
	}

	if (carregando && linhas.length === 0) {
		return (
			<div className="flex flex-col gap-sm" aria-hidden="true">
				{[0, 1, 2].map((n) => (
					<div
						key={n}
						className="h-10 animate-pulse rounded bg-superficie-alta"
					/>
				))}
			</div>
		);
	}

	if (erro !== null) {
		return (
			<div
				role="alert"
				className="rounded border border-perigo/40 bg-perigo/10 px-sm py-xs text-sm"
			>
				{erro}
			</div>
		);
	}

	if (linhas.length === 0) {
		return (
			<p className="text-sm text-suave">
				Nenhum registro de auditoria nesta conversa ainda.
			</p>
		);
	}

	return (
		<ol
			aria-label="Linha do tempo de auditoria"
			className="rolagem-fina flex max-h-[52vh] flex-col gap-xs overflow-y-auto"
		>
			{linhas.map((linha) => (
				<li
					key={linha.id}
					className="flex gap-sm rounded border border-borda bg-superficie px-sm py-xs"
				>
					<span className="shrink-0 pt-0.5">
						{linha.origem === "mensagem" ? (
							<MessageSquare
								className="size-3.5 text-suave"
								aria-hidden="true"
							/>
						) : linha.origem === "status" ? (
							<CircleAlert
								className="size-3.5 text-acento"
								aria-hidden="true"
							/>
						) : linha.origem === "handoff" ? (
							<Inbox className="size-3.5 text-handoff" aria-hidden="true" />
						) : (
							<Ban className="size-3.5 text-perigo" aria-hidden="true" />
						)}
					</span>
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="flex flex-wrap items-center gap-xs text-xs">
							<span className="font-semibold">
								{ROTULO_ORIGEM[linha.origem]}
							</span>
							<span aria-hidden="true">·</span>
							<span className="tabular-nums text-suave">
								{formatarInstante(linha.em)}
							</span>
						</span>
						<span className="truncate text-sm">{linha.titulo}</span>
						{linha.detalhe !== null ? (
							<span className="whitespace-pre-wrap text-xs text-suave">
								{linha.detalhe}
							</span>
						) : null}
					</span>
				</li>
			))}
		</ol>
	);
}
