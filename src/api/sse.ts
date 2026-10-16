/**
 * Canal de eventos do painel (SSE) — `GET /api/events`.
 *
 * O SSE é um **aviso**, não a fonte de verdade: ele só diz "olha de novo" e o
 * cliente refaz o GET REST. Isso mantém o Postgres como a única leitura
 * auditável (D-23) e evita um segundo modelo de dados no canal.
 *
 * Cada conexão recebe:
 *   - um `hello` inicial (o cliente marca "conectado" na UI);
 *   - um `hint` por evento dos canais do `BarramentoEventos` (`inbound`, `signal`,
 *     `clock`) — sem payload de conversa (PII nunca cruza o canal);
 *   - um comentário `: ping` a cada `HEARTBEAT_MS` para manter a conexão viva
 *     através de proxies/navegadores que fecham streams ociosos.
 *
 * A autenticação e a guarda de `Host` NÃO são reimplementadas aqui: o hook
 * `onRequest` de `server.ts` já barra `/api/*` antes de o handler rodar.
 */
import type { FastifyInstance } from "fastify";
import type { PanelCore } from "./server.js";

/** Intervalo do keep-alive do SSE. */
const HEARTBEAT_MS = 15_000;

interface ClienteSse {
	enviar(evento: string, dados: unknown): void;
}

/**
 * Registra a rota SSE e assina os canais do barramento. Uma única assinatura por
 * `buildServer` difunde para todas as conexões abertas.
 */
export const registrarSse = (app: FastifyInstance, core: PanelCore): void => {
	const clientes = new Set<ClienteSse>();

	const difundir = (canal: string): void => {
		for (const cliente of clientes) {
			cliente.enviar("hint", { canal });
		}
	};

	core.bus.on("inbound", () => {
		difundir("inbound");
	});
	core.bus.on("signal", () => {
		difundir("signal");
	});
	core.bus.on("clock", () => {
		difundir("clock");
	});

	app.get("/api/events", (req, reply) => {
		// `hijack` tira a resposta das mãos do Fastify: a partir daqui quem
		// escreve é o stream cru, e a conexão permanece aberta (ao contrário de
		// uma rota normal, que encerraria a resposta ao retornar).
		reply.hijack();
		const res = reply.raw;

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			// Desliga o buffering de proxies reversos (mesmo local, mas barato).
			"X-Accel-Buffering": "no",
		});

		let contador = 0;
		const enviar = (evento: string, dados: unknown): void => {
			contador += 1;
			res.write(
				`id: ${contador}\nevent: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`,
			);
		};

		enviar("hello", {
			ts: (core.agora !== undefined ? core.agora() : new Date()).toISOString(),
		});

		const heartbeat = setInterval(() => {
			// Comentário SSE: mantém a conexão viva sem disparar evento no cliente.
			res.write(": ping\n\n");
		}, HEARTBEAT_MS);
		// Não segurar o event loop do processo por causa do keep-alive.
		heartbeat.unref();

		const cliente: ClienteSse = { enviar };
		clientes.add(cliente);

		const limpar = (): void => {
			clearInterval(heartbeat);
			clientes.delete(cliente);
			if (!res.writableEnded) res.end();
		};
		req.raw.on("close", limpar);
		req.raw.on("error", limpar);
	});
};
