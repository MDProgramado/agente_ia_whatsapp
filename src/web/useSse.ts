import { useCallback, useEffect, useRef, useState } from "react";
import { lerToken } from "./api";

/**
 * Sinal em tempo real do painel (SSE) — `GET /api/events`.
 *
 * ## Por que fetch, e não `EventSource`
 *
 * O contrato congelado no 03-03 exige `Authorization: Bearer <PANEL_TOKEN>` em
 * toda chamada `/api/*` (o hook `onRequest` de `server.ts` só lê o header
 * `authorization`). O `EventSource` nativo **não permite definir headers** e o
 * servidor não aceita token na query — então `EventSource` levaria 401 sempre.
 * Aqui lemos o stream com `fetch` + `ReadableStream`, preservando o contrato do
 * servidor (o token nunca vai para a URL — T-03-21).
 *
 * ## Semântica (D-23)
 *
 * O SSE é só um **aviso**: cada `hint` incrementa `versao`, e quem consome
 * refaz o GET REST da tela ativa. O SSE nunca é a fonte de verdade.
 *
 * ## Resiliência (T-03-24 / Pitfall 9)
 *
 * Em erro/fim de stream, reconecta com **backoff exponencial** (1s→30s, sem
 * polling agressivo). Ao reabrir, `hello` marca "ao-vivo" e `versao` é
 * incrementada para forçar re-sync dos dados que possam ter sido perdidos.
 */
export type EstadoConexao =
	| "conectando"
	| "ao-vivo"
	| "reconectando"
	| "sem-conexao";

export interface OpcoesSse {
	/** Disparado a cada sinal (`hello`/`hint`) — use para re-sync por GET. */
	onSinal?: (canal: string) => void;
	/** Quando false, a conexão fica desligada (ex.: sem token). */
	ativo?: boolean;
}

export interface ResultadoSse {
	conexao: EstadoConexao;
	/** Incrementa a cada sinal — use como dependência do re-sync. */
	versao: number;
	ultimoCanal: string | null;
}

const ATRASO_INICIAL_MS = 1_000;
const ATRASO_MAX_MS = 30_000;

interface Quadro {
	evento: string;
	dados: string;
}

/** Analisa um bloco SSE (separado por linha em branco). `null` = comentário/vazio. */
const analisarQuadro = (bloco: string): Quadro | null => {
	if (bloco === "" || bloco.trimStart().startsWith(":")) return null;
	let evento = "message";
	const linhasDados: string[] = [];
	for (const linha of bloco.split("\n")) {
		if (linha === "" || linha.startsWith(":")) continue;
		const separador = linha.indexOf(":");
		const campo = separador >= 0 ? linha.slice(0, separador) : linha;
		const valor =
			separador >= 0 ? linha.slice(separador + 1).replace(/^ /, "") : "";
		if (campo === "event") evento = valor;
		else if (campo === "data") linhasDados.push(valor);
	}
	if (evento === "message" && linhasDados.length === 0) return null;
	return { evento, dados: linhasDados.join("\n") };
};

export function useSse(opcoes: OpcoesSse = {}): ResultadoSse {
	const { ativo = true } = opcoes;
	const [conexao, setConexao] = useState<EstadoConexao>("conectando");
	const [versao, setVersao] = useState(0);
	const [ultimoCanal, setUltimoCanal] = useState<string | null>(null);

	// Mantém o callback fora das dependências do efeito (evita reconectar a cada
	// render do pai).
	const onSinalRef = useRef<OpcoesSse["onSinal"]>(opcoes.onSinal);
	useEffect(() => {
		onSinalRef.current = opcoes.onSinal;
	}, [opcoes.onSinal]);

	const sinalizar = useCallback((canal: string): void => {
		setVersao((v) => v + 1);
		setUltimoCanal(canal);
		onSinalRef.current?.(canal);
	}, []);

	useEffect(() => {
		if (!ativo) {
			setConexao("sem-conexao");
			return;
		}

		let encerrado = false;
		let controlador: AbortController | null = null;
		let temporizador: ReturnType<typeof setTimeout> | null = null;
		let atraso = ATRASO_INICIAL_MS;

		const agendarReconexao = (): void => {
			if (encerrado) return;
			setConexao(atraso >= ATRASO_MAX_MS ? "sem-conexao" : "reconectando");
			temporizador = setTimeout(() => {
				void conectar();
			}, atraso);
			atraso = Math.min(atraso * 2, ATRASO_MAX_MS);
		};

		const conectar = async (): Promise<void> => {
			if (encerrado) return;
			const token = lerToken();
			if (token === null) {
				setConexao("sem-conexao");
				return;
			}

			controlador = new AbortController();
			setConexao((atual) => (atual === "ao-vivo" ? atual : "conectando"));

			try {
				const resposta = await fetch("/api/events", {
					method: "GET",
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "text/event-stream",
					},
					signal: controlador.signal,
					cache: "no-store",
				});

				if (resposta.status === 401 || resposta.status === 403) {
					setConexao("sem-conexao");
					return; // token errado: reconectar não ajuda
				}
				if (!resposta.ok || resposta.body === null) {
					throw new Error(`SSE HTTP ${resposta.status}`);
				}

				const leitor = resposta.body.getReader();
				const decodificador = new TextDecoder();
				let buffer = "";

				for (;;) {
					const { value, done } = await leitor.read();
					if (done) break;
					if (encerrado) return;

					buffer += decodificador.decode(value, { stream: true });
					let corte = buffer.indexOf("\n\n");
					while (corte >= 0) {
						const bloco = buffer.slice(0, corte);
						buffer = buffer.slice(corte + 2);
						const quadro = analisarQuadro(bloco);
						if (quadro !== null) {
							if (quadro.evento === "hello") {
								atraso = ATRASO_INICIAL_MS;
								setConexao("ao-vivo");
								sinalizar("hello");
							} else if (quadro.evento === "hint") {
								setConexao("ao-vivo");
								sinalizar(lerCanal(quadro.dados));
							}
						} else if (bloco.trimStart().startsWith(":")) {
							// heartbeat: confirma que o stream está vivo
							setConexao((atual) => (atual === "ao-vivo" ? atual : "ao-vivo"));
						}
						corte = buffer.indexOf("\n\n");
					}
				}
				// Stream terminou (servidor fechou): reconecta.
				agendarReconexao();
			} catch (causa) {
				if (
					encerrado ||
					(causa instanceof Error && causa.name === "AbortError")
				) {
					return;
				}
				agendarReconexao();
			}
		};

		void conectar();

		return () => {
			encerrado = true;
			if (temporizador !== null) clearTimeout(temporizador);
			controlador?.abort();
		};
	}, [ativo, sinalizar]);

	return { conexao, versao, ultimoCanal };
}

/** Extrai o `canal` do payload de `hint`; tolerante a payload inesperado. */
const lerCanal = (dados: string): string => {
	try {
		const analisado: unknown = JSON.parse(dados);
		if (
			typeof analisado === "object" &&
			analisado !== null &&
			"canal" in analisado &&
			typeof (analisado as { canal?: unknown }).canal === "string"
		) {
			return (analisado as { canal: string }).canal;
		}
	} catch {
		// payload não-JSON: segue com rótulo genérico
	}
	return "evento";
};
