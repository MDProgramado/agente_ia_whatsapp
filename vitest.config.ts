import { defineConfig } from "vitest/config";

// As seeds do fast-check vao em cada fc.assert, nao aqui (a mesma seed em todos
// os testes, para que a falha seja reproduzivel).
export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		globals: false,
		// Os testes de `tests/application/outbox*.test.ts` e
		// `dispatcher-choke-point.test.ts` abrem conexão e aplicam `migrate()`.
		// Rodar arquivos em paralelo faria várias sessões executarem DDL de
		// migration ao mesmo tempo no mesmo banco (corrida em
		// `__drizzle_migrations`). Serializar os arquivos elimina a corrida sem
		// custo de correção — o volume de testes é pequeno.
		fileParallelism: false,
	},
});
