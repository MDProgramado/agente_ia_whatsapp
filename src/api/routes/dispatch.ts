/**
 * `POST /api/dispatch` — o ÚNICO caminho de envio do painel (NFRQ-05).
 *
 * A rota não envia nada por conta própria: ela chama o `dispatcher`, que é onde
 * o gate (todas as travas) e a única chamada efetiva de envio ao canal vivem. O
 * `origin` é fixado aqui como `"admin"` e NUNCA vem do cliente — a assinatura do
 * `dispatchBody` não tem esse campo, então um cliente não consegue forjar
 * `origin`.
 *
 * Mapa de resposta → status HTTP:
 *   - `sent`     → 201 (mensagem de fato saiu);
 *   - `deferred` → 202 (fora da janela/cota — reprogramada, não é erro);
 *   - `blocked`  → 409 (o gate recusou: opt-out, handoff, kill switch, etc.);
 *   - `silencio` → 200 (erro interno mapeado: o bot ficou em silêncio, correto
 *                  por padrão).
 */
import type { FastifyInstance } from "fastify";
import { dispatch } from "../../application/dispatcher.js";
import { dispatchBody } from "../schemas.js";
import type { PanelCore } from "../server.js";

export const registrarDispatch = (
	app: FastifyInstance,
	core: PanelCore,
): void => {
	app.post("/api/dispatch", async (req, reply) => {
		const body = dispatchBody.safeParse(req.body);
		if (!body.success) {
			return reply.code(400).send({
				erro: "corpo invalido",
				detalhes: body.error.issues.map((i) => i.message),
			});
		}

		const agora = core.agora !== undefined ? core.agora() : new Date();
		const resultado = await dispatch(core.dispatchDeps, {
			conversationId: body.data.conversationId,
			text: body.data.text,
			now: agora,
			origin: "admin",
		});

		switch (resultado.action) {
			case "sent":
				return reply
					.code(201)
					.send({ action: "sent", messageId: resultado.messageId });
			case "deferred":
				return reply.code(202).send({
					action: "deferred",
					scheduledFor: resultado.scheduledFor.toISOString(),
				});
			case "blocked":
				return reply.code(409).send({
					action: "blocked",
					reason: resultado.reason,
					detail: resultado.detail,
				});
			case "silencio":
				return reply.code(200).send({
					action: "silencio",
					reason: resultado.reason,
					detail: resultado.detail,
				});
		}
	});
};
