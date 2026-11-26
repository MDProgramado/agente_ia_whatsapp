/**
 * Script de teste de conectividade com a LLM (OpenRouter / Gemini / OpenAI).
 *
 * Executa: npm run test:llm
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { z } from "zod";
import { env } from "../config/env.js";

const main = async () => {
	console.log("==================================================");
	console.log("    TESTE DE CONECTIVIDADE DA IA (LLM CHECK)      ");
	console.log("==================================================\n");

	console.log(`Provedor configurado: ${env.LLM_PROVIDER}`);
	console.log(`Modelo selecionado:   ${env.LLM_MODEL}`);

	const CHAVE_ENV: Record<string, string> = {
		openai: "OPENAI_API_KEY",
		anthropic: "ANTHROPIC_API_KEY",
		google: "GOOGLE_GENERATIVE_AI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
	};

	const apiKey =
		env.LLM_API_KEY || process.env[CHAVE_ENV[env.LLM_PROVIDER] ?? ""] || "";

	if (!apiKey) {
		console.error("\n❌ ERRO: Nenhuma chave de API configurada no .env!");
		console.error("Defina a variável LLM_API_KEY no seu arquivo .env.");
		process.exit(1);
	}

	console.log(`Chave detectada:      ${apiKey.slice(0, 7)}...${apiKey.slice(-4)}\n`);
	console.log("Enviando requisição de teste para o modelo...");

	let modelInstance;
	if (env.LLM_PROVIDER === "openrouter") {
		modelInstance = createOpenRouter({ apiKey })(env.LLM_MODEL);
	} else if (env.LLM_PROVIDER === "google") {
		modelInstance = createGoogleGenerativeAI({ apiKey })(env.LLM_MODEL);
	} else if (env.LLM_PROVIDER === "anthropic") {
		modelInstance = createAnthropic({ apiKey })(env.LLM_MODEL);
	} else {
		modelInstance = createOpenAI({ apiKey })(env.LLM_MODEL);
	}

	const inicio = Date.now();
	try {
		// Simula uma resposta estruturada de SDR
		const resultado = await generateText({
			model: modelInstance,
			output: Output.object({
				schema: z.object({
					mensagemDeTeste: z.string(),
					classificacaoSimulada: z.enum(["interessado", "duvida", "outro"]),
				}),
			}),
			prompt:
				"Você é um SDR consultivo de serviços digitais. O cliente respondeu: 'Olá, gostaria de saber se vocês criam automações para empresas.' Retorne uma mensagem curta e simpática cumprimentando-o.",
		});

		const delta = Date.now() - inicio;
		console.log("\n✅ SUCESSO! A IA respondeu em", delta, "ms\n");
		console.log("Resposta estruturada obtida:");
		console.log("--------------------------------------------------");
		console.log(JSON.stringify(resultado.output, null, 2));
		console.log("--------------------------------------------------");
		console.log("\nSua integração com a OpenRouter/LLM está 100% pronta para uso.");
	} catch (erro: unknown) {
		console.error("\n❌ FALHA NA COMUNICAÇÃO COM O PROVEDOR:");
		console.error(erro instanceof Error ? erro.message : String(erro));
		process.exit(1);
	}
};

main();
