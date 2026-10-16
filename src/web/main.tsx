import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

/**
 * Ponto de entrada do SPA (NFRQ-05).
 *
 * O painel é servido pelo mesmo processo Fastify da API, em `127.0.0.1`
 * (contexto seguro — Web Notifications e clipboard funcionam). Não há roteador:
 * é uma única tela de 4 áreas (R-046).
 */
const raiz = document.getElementById("root");

if (raiz === null) {
	throw new Error("Elemento #root não encontrado em index.html");
}

createRoot(raiz).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
