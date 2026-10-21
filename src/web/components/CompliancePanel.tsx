import { ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useState } from "react";
import {
	type LeadDetalhe,
	registrarOptOutManual,
	rotuloBaseLegal,
	rotuloFinalidade,
} from "../api";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Painel de compliance do lead (R-064, R-024/AR-005).
 *
 * Mostra o registro de origem, base legal e finalidade — os três campos que
 * a LGPD exige registrar (AGENTS.md regra 10) — e oferece o opt-out MANUAL,
 * que é IRREVERSÍVEL (R-024: opt-out pedido = bloqueio permanente).
 *
 * Anti-requisitos respeitados aqui:
 *   - **não** existe botão para reverter o opt-out (o servidor não tem rota);
 *   - **não** existe botão de remoção do lead (AR-005: histórico imutável, e o
 *     lead precisa continuar auditável);
 *   - a confirmação exige digitar o literal `OPTOUT` — a mesma barreira de
 *     cliente que o servidor exige (`confirm` exato).
 */

/**
 * Converte a recusa do servidor em uma mensagem utilizável. `apiPost` NÃO
 * lança em erro HTTP: devolve o corpo (`{erro, detalhes}`), então é aqui que
 * o 400 do servidor vira texto na tela.
 */
const mensagemDaRecusa = (resposta: unknown): string => {
	const erro = (resposta as { erro?: unknown }).erro;
	if (erro === "confirmacao invalida") {
		return "O servidor recusou a confirmação. Digite OPTOUT exatamente.";
	}
	if (typeof erro === "string" && erro !== "") return erro;
	return "Não foi possível registrar o opt-out.";
};

export interface CompliancePanelProps {
	readonly lead: LeadDetalhe;
	/** Chamado depois que o opt-out foi gravado — o App re-sincroniza o lead. */
	readonly onRegistrado?: (leadId: string) => void;
}

const formatarDataHora = (iso: string | null): string => {
	if (iso === null || iso === "") return "Não solicitada";
	const data = new Date(iso);
	if (Number.isNaN(data.getTime())) return "Não solicitada";
	return data.toLocaleString("pt-BR", {
		dateStyle: "short",
		timeStyle: "short",
	});
};

export function CompliancePanel({ lead, onRegistrado }: CompliancePanelProps) {
	// Estado local do opt-out: o servidor é a fonte da verdade, mas o botão
	// precisa sumir no mesmo instante do clique (sem esperar o round-trip).
	// O par (id do lead) abaixo reinicia o estado local quando o painel passa
	// a mostrar OUTRO lead.
	const [leadIdAnterior, setLeadIdAnterior] = useState(lead.id);
	const [optOut, setOptOut] = useState(lead.optOut);
	const [optOutAt, setOptOutAt] = useState<string | null>(lead.optOutAt);
	if (lead.id !== leadIdAnterior) {
		setLeadIdAnterior(lead.id);
		setOptOut(lead.optOut);
		setOptOutAt(lead.optOutAt);
	}

	const [dialogoAberto, setDialogoAberto] = useState(false);
	const [ocupado, setOcupado] = useState(false);
	const [erro, setErro] = useState<string | null>(null);
	const [aviso, setAviso] = useState<string | null>(null);

	const aoAbrirDialogo = useCallback(() => {
		setErro(null);
		setAviso(null);
		setDialogoAberto(true);
	}, []);

	const aoCancelar = useCallback(() => {
		setDialogoAberto(false);
		setOcupado(false);
	}, []);

	const aoConfirmar = useCallback(async () => {
		setOcupado(true);
		setErro(null);
		try {
			const resposta = await registrarOptOutManual(lead.id);
			if (resposta.optOut !== true) {
				throw new Error(mensagemDaRecusa(resposta));
			}
			setOptOut(true);
			setOptOutAt(new Date().toISOString());
			setAviso(
				resposta.mudou
					? "Opt-out registrado. Este lead não mais receberá contato."
					: "Este lead já estava com opt-out registrado.",
			);
			setDialogoAberto(false);
			onRegistrado?.(lead.id);
		} catch (falha) {
			setErro(
				falha instanceof Error
					? falha.message
					: "Não foi possível registrar o opt-out.",
			);
		} finally {
			setOcupado(false);
		}
	}, [lead.id, onRegistrado]);

	return (
		<section
			aria-labelledby={`compliance-${lead.id}`}
			className="flex flex-col gap-sm"
		>
			<h3
				id={`compliance-${lead.id}`}
				className="flex items-center gap-xs text-sm font-semibold"
			>
				<ShieldCheck className="size-4 text-acento" aria-hidden="true" />
				Compliance e origem do dado
			</h3>

			<dl className="grid grid-cols-[auto_1fr] gap-x-md gap-y-xs text-sm">
				<dt className="text-suave">Origem do dado</dt>
				<dd>{lead.originSource}</dd>

				<dt className="text-suave">Base legal</dt>
				<dd>{rotuloBaseLegal(lead.compliance.legalBasis)}</dd>

				<dt className="text-suave">Finalidade</dt>
				<dd>{rotuloFinalidade(lead.compliance.purpose)}</dd>

				<dt className="text-suave">Registro da base legal</dt>
				<dd>{formatarDataHora(lead.compliance.legalRegisteredAt)}</dd>

				<dt className="text-suave">Primeiro contato feito por humano</dt>
				<dd>{lead.compliance.firstContactByHuman ? "Sim" : "Não"}</dd>

				<dt className="text-suave">Opt-out</dt>
				<dd>
					{optOut
						? `Solicitado em ${formatarDataHora(optOutAt)}`
						: "Não solicitado"}
				</dd>
			</dl>

			{aviso !== null ? (
				<div
					role="status"
					className="rounded border border-acento/40 bg-acento/10 px-sm py-xs text-sm"
				>
					{aviso}
				</div>
			) : null}

			{erro !== null ? (
				<div
					role="alert"
					className="flex items-start gap-xs rounded border border-perigo/40 bg-perigo/10 px-sm py-xs text-sm"
				>
					<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
					<span>{erro}</span>
				</div>
			) : null}

			{optOut ? null : (
				<button
					type="button"
					onClick={aoAbrirDialogo}
					className="w-fit rounded border border-perigo/60 px-sm py-xs text-sm font-semibold text-perigo hover:bg-perigo/10"
				>
					Marcar opt-out
				</button>
			)}

			<ConfirmDialog
				aberto={dialogoAberto}
				titulo="Registrar opt-out deste lead"
				descricao="Esta ação é permanente e não pode ser desfeita. O lead nunca mais receberá contato."
				textoExigido="OPTOUT"
				rotuloConfirmar="Registrar opt-out"
				destrutivo
				ocupado={ocupado}
				erro={erro}
				onConfirmar={() => {
					void aoConfirmar();
				}}
				onCancelar={aoCancelar}
			/>
		</section>
	);
}
