import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Build do painel (SPA React) — D-17.
 *
 * `root` é `src/web` (onde vive o `index.html`). O bundle sai em `dist/web`, que
 * é exatamente o diretório que o `@fastify/static` do painel serve: em
 * `src/api/server.ts`, `SPA_DIST_DIR = ../../dist/web`.
 *
 * `base: "/"` e mesma origem: o SPA é servido pelo MESMO processo/porta da API,
 * então não há CORS nem host alternativo (T-03-25).
 *
 * Sem a opção de caminho base do TS (nem aqui nem no tsconfig): é erro duro do
 * TypeScript 7 — imports são relativos/específicos.
 */
export default defineConfig({
	root: fileURLToPath(new URL("./src/web", import.meta.url)),
	base: "/",
	plugins: [react(), tailwindcss()],
	build: {
		outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
		// `dist/web` está fora do `root` do Vite; sem isto o Vite recusa limpar.
		emptyOutDir: true,
	},
});
