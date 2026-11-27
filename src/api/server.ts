/**
 * Borda HTTP local do painel (D-17/D-18, T-03-10..T-03-18).
 *
 * Uma única instância Fastify que:
 *   - derruba `Host` fora de `{127.0.0.1, localhost}` (anti-DNS-rebinding, T-03-11):
 *     um domínio malicioso que resolva para o loopback e aponte o browser do
 *     Admin para cá seria barrado aqui, antes de alcançar qualquer rota;
 *   - exige `Authorization: Bearer <PANEL_TOKEN>` em `/api/*` (T-03-12);
 *   - serve o SPA compilado (`dist/web`) sem token (asset público), MAS com o
 *     mesmo `Host` validado — e NUNCA aponta para `DATA_ROOT` (sessão/backups,
 *     path traversal, T-03-15);
 *   - derruba `app.listen` com bind LITERAL `127.0.0.1` (nunca bind em todas as
 *     interfaces, T-03-10) — R-033 aceita "sem criptografia" em dados repousados,
 *     não em rede.
 *
 * Sem CORS: o painel é mesma-origem (o SPA sai do mesmo processo/porta que a
 * API). Habilitar CORS aqui abriria a API para qualquer página, anulando o token.
 *
 * O token NUNCA vai para `settings` (D-18): `settings` é operacional e vive no
 * banco; segredo de acesso vai só em `.env`, fora do alcance de uma leitura de
 * tabela por outro caminho.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { DispatchDeps } from "../application/dispatcher.js";
import type { BarramentoEventos } from "../application/event-bus.js";
import { env } from "../config/env.js";
import type {
	ExtractionEnvelope,
	GenerationEnvelope,
} from "../domain/llm/envelope.js";
import type { LlmPort } from "../domain/ports/LlmPort.js";
import type { Db } from "../infra/db/client.js";
import { requireToken } from "./auth.js";
import { registrarConversations } from "./routes/conversations.js";
import { registrarCrm } from "./routes/crm.js";
import { registrarDispatch } from "./routes/dispatch.js";
import { registrarLeads } from "./routes/leads.js";
import { registrarMessages } from "./routes/messages.js";
import { registrarSystem } from "./routes/system.js";
import { registrarSse } from "./sse.js";

/** Hosts aceitos no header `Host`, sem a porta. Anti-DNS-rebinding (T-03-11). */
const HOSTS_PERMITIDOS = new Set(["127.0.0.1", "localhost"]);

/**
 * Limite de corpo (T-03-18): o painel envia texto de mensagem e comandos
 * pequenos. 256 KB é folga generosa e impede um corpo gigante derrubar o
 * processo (o Fastify responde 413 antes de alocar).
 */
const BODY_LIMIT_BYTES = 256 * 1024;

/** Diretório do SPA compilado pelo Vite (03-04). NUNCA `DATA_ROOT`. */
const SPA_DIST_DIR = fileURLToPath(new URL("../../dist/web", import.meta.url));

/** Extrai o host do header `Host`, descartando a porta (`127.0.0.1:8787` → `127.0.0.1`). */
const hostSemPorta = (hostHeader: string | undefined): string => {
	const bruto = typeof hostHeader === "string" ? hostHeader : "";
	// `[0]` de `split` é sempre definido em TS; `?? ""` só satisfação do
	// noUncheckedIndexedAccess, inalcançável em runtime.
	const semPorta = bruto.split(":")[0] ?? "";
	// Host IPv6 viraria `::1` ou `[::1]` — fora do conjunto permitido de propósito:
	// o painel é alcançado por `127.0.0.1`/`localhost`, não por IPv6 literal.
	return semPorta.toLowerCase();
};

/**
 * Núcleo do painel — as dependências que as rotas de leitura/ação usam.
 *
 * `dispatchDeps` carrega o `db`, o `channel` e o `ctx` (tz/janela/tetos). As
 * rotas de leitura reusam o `ctx` de lá (uma única fonte para o fuso e a
 * janela, nunca uma cópia paralela que possa divergir).
 */
export interface PanelCore {
	readonly db: Db;
	readonly bus: BarramentoEventos;
	readonly dispatchDeps: DispatchDeps;
	/** Feriados para o cálculo de janela/próxima janela (D-09). */
	readonly feriados: readonly string[];
	/** Relógio injetável (teste). Default `() => new Date()`. */
	readonly agora?: () => Date;
	/**
	 * Porta de geração da LLM para o copiloto (03-05). OPCIONAL de propósito:
	 * testes de borda montam o core sem IA e a rota de sugestão responde 503;
	 * produção (index.ts) injeta a porta de verdade.
	 */
	readonly llm?: LlmPort<ExtractionEnvelope, GenerationEnvelope>;
}

export type ServerDeps = {
	/** Porta a escutar. Default `env.PANEL_PORT`. */
	port?: number;
	/** Logger pino a usar. Se ausente, um child silencioso é criado. */
	logger?: unknown;
	/**
	 * Núcleo do painel. Ausente em teste de borda puro (só guarda Host/token e
	 * estático): sem ele nenhuma rota de API é registrada, e `app.inject()`
	 * devolve 404 para `/api/*` — que é o comportamento esperado antes de o
	 * boot (03-03 Task 3) injetar o core.
	 */
	core?: PanelCore;
};

/**
 * Monta o Fastify com a guarda de borda, mas NÃO escuta. Separar `buildServer`
 * de `startPanel` permite `app.inject()` nos testes sem abrir socket de rede.
 */
export const buildServer = (deps: ServerDeps = {}): FastifyInstance => {
	const app = Fastify({
		// O logger do Fastify é desligado: o projeto usa o `childLogger` do pino
		// central (com redact de PII). Com `logger: false` não há request logging
		// nativo a desligar — o logging de request viria junto, e é justamente o
		// que não se quer (URL/query sem a redação central).
		logger: false,
		bodyLimit: BODY_LIMIT_BYTES,
	});

	// Guarda de borda: Host + token, ANTES de qualquer rota ou estático.
	app.addHook("onRequest", async (req, reply) => {
		const host = hostSemPorta(req.headers.host);
		if (!HOSTS_PERMITIDOS.has(host)) {
			return reply.code(403).send({ erro: "host nao permitido" });
		}

		// Státicos (`/`, assets do SPA) ficam isentos de token — são públicos —
		// mas o Host acima já foi validado. A API (`/api/*`) exige token.
		const cru = (req.url.split("?")[0] ?? "").toLowerCase();
		let caminho = cru;
		try {
			caminho = decodeURIComponent(cru).toLowerCase();
		} catch {
			caminho = cru;
		}
		if (caminho === "/api" || caminho.startsWith("/api/")) {
			if (!requireToken(req.headers.authorization, env.PANEL_TOKEN)) {
				return reply.code(401).send({ erro: "token ausente ou invalido" });
			}
		}
	});

	// Rotas de API só existem com o núcleo injetado (boot real / teste de integração).
	if (deps.core !== undefined) {
		const core = deps.core;
		registrarLeads(app, core);
		registrarConversations(app, core);
		registrarCrm(app, core);
		registrarMessages(app, core);
		registrarSystem(app, core);
		registrarDispatch(app, core);
		registrarSse(app, core);
	}

	// SPA compilado: servido sem token, com Host já validado pelo hook acima.
	// Só registra se o diretório existir — antes do build (03-04) não há o que
	// servir, e `@fastify/static` lançaria se `root` não existisse.
	if (existsSync(SPA_DIST_DIR)) {
		app.register(fastifyStatic, {
			root: SPA_DIST_DIR,
			// Nunca seguir symlink para fora do diretório do SPA.
			allowedPath: (path) => !path.includes(".."),
		});
	}

	return app;
};

/**
 * Sobe o painel e escuta. Bind LITERAL `127.0.0.1` (T-03-10) — bind em todas as
 * interfaces estaria proibido. Devolve a instância para o boot fechar no
 * shutdown.
 */
export const startPanel = async (
	deps: ServerDeps = {},
): Promise<FastifyInstance> => {
	const app = buildServer(deps);
	// Literal, nunca variável derivada de env para o host: um bind em todas as
	// interfaces seria um bug de um caractere, e este é o lugar onde o literal o
	// torna impossível por construção.
	await app.listen({ host: "127.0.0.1", port: deps.port ?? env.PANEL_PORT });
	return app;
};
