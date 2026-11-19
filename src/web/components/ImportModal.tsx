import {
	AlertCircle,
	CheckCircle2,
	FileSpreadsheet,
	Upload,
	X,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import { importarPlanilhaCsv, type RespostaImportacaoPlanilha } from "../api";

export interface ImportModalProps {
	readonly aberto: boolean;
	readonly onFechar: () => void;
	readonly onSucesso: () => void;
}

export function ImportModal({ aberto, onFechar, onSucesso }: ImportModalProps) {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const idOrigem = useId();
	const idFileUpload = useId();
	const [origem, setOrigem] = useState("planilha_excel");
	const [carregando, setCarregando] = useState(false);
	const [erro, setErro] = useState<string | null>(null);
	const [resultado, setResultado] = useState<RespostaImportacaoPlanilha | null>(
		null,
	);
	const [nomeArquivo, setNomeArquivo] = useState<string | null>(null);
	const [conteudoCsv, setConteudoCsv] = useState<string | null>(null);

	if (!aberto) return null;

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;

		setNomeArquivo(file.name);
		setErro(null);
		setResultado(null);

		const reader = new FileReader();
		reader.onload = (event) => {
			const text = event.target?.result;
			if (typeof text === "string") {
				setConteudoCsv(text);
			}
		};
		reader.onerror = () => {
			setErro("Falha ao ler o arquivo selecionado.");
		};
		reader.readAsText(file, "UTF-8");
	};

	const handleImportar = async () => {
		if (!conteudoCsv) {
			setErro("Selecione um arquivo de planilha (.csv) primeiro.");
			return;
		}

		setCarregando(true);
		setErro(null);
		try {
			const res = await importarPlanilhaCsv(conteudoCsv, origem);
			setResultado(res);
			onSucesso();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Erro na importação.";
			setErro(msg);
		} finally {
			setCarregando(false);
		}
	};

	const handleReset = () => {
		setResultado(null);
		setConteudoCsv(null);
		setNomeArquivo(null);
		if (fileInputRef.current) fileInputRef.current.value = "";
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-md backdrop-blur-xs">
			<div className="flex w-full max-w-lg flex-col rounded-lg border border-borda bg-superficie p-lg shadow-2xl">
				<div className="flex items-center justify-between border-b border-borda pb-sm">
					<div className="flex items-center gap-xs text-base font-semibold">
						<FileSpreadsheet
							className="size-5 text-acento"
							aria-hidden="true"
						/>
						<span>Importar Leads via Planilha</span>
					</div>
					<button
						type="button"
						onClick={onFechar}
						className="rounded p-xs hover:bg-superficie-alta"
						aria-label="Fechar"
					>
						<X className="size-4" />
					</button>
				</div>

				<div className="mt-md flex flex-col gap-md text-sm">
					{!resultado ? (
						<>
							<p className="text-xs text-suave">
								Envie seu arquivo exportado do Excel ou Google Sheets (formato
								.csv). O sistema mapeia automaticamente colunas como{" "}
								<strong>Nome, Telefone/WhatsApp, Nicho e Cidade</strong>.
							</p>

							<div className="flex flex-col gap-xs">
								<label
									htmlFor={idOrigem}
									className="text-xs font-medium text-suave"
								>
									Identificador da Origem:
								</label>
								<input
									id={idOrigem}
									type="text"
									value={origem}
									onChange={(e) => setOrigem(e.target.value)}
									placeholder="ex: planilha_clinicas_novembro"
									className="rounded border border-borda bg-fundo px-sm py-xs text-xs outline-none focus:ring-1 focus:ring-acento"
								/>
							</div>

							<div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-borda p-lg text-center hover:border-acento">
								<input
									ref={fileInputRef}
									type="file"
									accept=".csv,.txt"
									onChange={handleFileChange}
									className="hidden"
									id={idFileUpload}
								/>
								<label
									htmlFor={idFileUpload}
									className="flex cursor-pointer flex-col items-center gap-xs"
								>
									<Upload className="size-8 text-suave" />
									<span className="font-medium text-acento">
										{nomeArquivo
											? nomeArquivo
											: "Clique para selecionar o arquivo (.csv)"}
									</span>
									<span className="text-[11px] text-suave">
										Delimitado por vírgula (,) ou ponto-e-vírgula (;)
									</span>
								</label>
							</div>

							{erro ? (
								<div className="flex items-center gap-xs rounded border border-perigo/40 bg-perigo/10 p-sm text-xs text-perigo">
									<AlertCircle className="size-4 shrink-0" />
									<span>{erro}</span>
								</div>
							) : null}

							<div className="flex justify-end gap-sm pt-sm">
								<button
									type="button"
									onClick={onFechar}
									className="rounded border border-borda px-md py-xs text-xs hover:bg-superficie-alta"
								>
									Cancelar
								</button>
								<button
									type="button"
									onClick={handleImportar}
									disabled={!conteudoCsv || carregando}
									className="rounded bg-acento px-md py-xs text-xs font-semibold text-slate-50 disabled:opacity-40"
								>
									{carregando ? "Processando lote…" : "Confirmar Importação"}
								</button>
							</div>
						</>
					) : (
						<div className="flex flex-col gap-sm py-sm">
							<div className="flex items-center gap-xs text-acento font-medium">
								<CheckCircle2 className="size-5" />
								<span>Lote processado com sucesso!</span>
							</div>

							<div className="grid grid-cols-2 gap-xs rounded border border-borda bg-superficie-alta/40 p-sm text-xs">
								<div>Total na planilha:</div>
								<div className="font-semibold">{resultado.totalNoArquivo}</div>

								<div>Importados com sucesso:</div>
								<div className="font-semibold text-acento">
									{resultado.importadosComSucesso}
								</div>

								<div>Duplicados (já existiam):</div>
								<div className="font-semibold text-suave">
									{resultado.duplicadosIgnorados}
								</div>

								<div>Telefone inválido:</div>
								<div className="font-semibold text-aviso">
									{resultado.invalidosNoFormato}
								</div>
							</div>

							{resultado.semCotaDisponivel ? (
								<p className="rounded border border-aviso/40 bg-aviso/10 p-xs text-xs text-aviso">
									Atenção: A cota diária de novos contatos atingiu o teto. Os
									leads restantes foram preservados para o próximo dia útil.
								</p>
							) : null}

							<div className="flex justify-end gap-sm pt-md">
								<button
									type="button"
									onClick={handleReset}
									className="rounded border border-borda px-md py-xs text-xs hover:bg-superficie-alta"
								>
									Importar Outro Arquivo
								</button>
								<button
									type="button"
									onClick={onFechar}
									className="rounded bg-acento px-md py-xs text-xs font-semibold text-slate-50"
								>
									Concluir
								</button>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
