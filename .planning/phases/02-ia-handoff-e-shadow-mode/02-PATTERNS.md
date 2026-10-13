# Phase 2: IA, Handoff e Shadow Mode - Pattern Map

**Mapped:** 2026-10-13
**Files analyzed:** 20 (novos + modificados)
**Analogs found:** 18 / 20 (2 sem análogo exato: `LlmPort` e harness de bake-off)

> **Regra-mestra que governa TODOS os padrões abaixo (herdada da Fase 1):**
> `evaluatePolicy` roda **antes** de qualquer fiação de LLM; `sendText` só existe no
> choke-point `src/application/dispatcher.ts`. Em shadow, o caminho de "envio"
> resolve para *persistir rascunho*, nunca para o dispatcher. **Nenhum arquivo novo
> desta fase pode chamar `sendText`.**

---

## File Classification

| Novo/Modificado | Papel | Data Flow | Análogo mais próximo | Match |
|-----------------|-------|-----------|----------------------|-------|
| `src/domain/ports/LlmPort.ts` | port | request-response | `src/domain/ports/NotifyPort.ts` (+ `LeadSourcePort.ts`) | exact (porta) |
| `src/domain/orchestrator/transitions.ts` | domain (FSM) | transform (puro) | `src/domain/gate/evaluate-policy.ts` | role-match |
| `src/domain/llm/envelope.ts` | schema/validation | transform | `src/config/env.ts` + `src/domain/gate/types.ts` | role-match |
| `src/domain/llm/prompt-builder.ts` | utility (choke-point PII) | transform | `src/domain/gate/patterns/automation-disclosure.ts` | role-match |
| `src/application/optout-matcher.ts` | domain util (classificador) | transform | `src/domain/gate/patterns/price-workaround.ts` | exact |
| `src/application/handoff-service.ts` | service | CRUD (transação) | `src/application/inbound-handler.ts` (`registrarMidiaRecebida`) | exact |
| `src/application/shadow.ts` | service | CRUD (append) | `src/application/dispatcher.ts` (INSERT `messages`) | role-match |
| `src/application/inbound-handler.ts` **(MOD)** | handler | request-response | ele mesmo | exact |
| `src/infra/llm/ai-sdk-adapter.ts` | adapter | request-response | `src/infra/notifier.ts` + `src/infra/http-lead-source.ts` | role-match |
| `src/infra/llm/scripted-adapter.ts` | adapter (dublê) | determinístico | `src/infra/fake-channel.ts` + `src/infra/fake-lead-source.ts` | exact |
| `src/infra/db/schema.ts` **(MOD)** | model | CRUD | ele mesmo | exact |
| `src/infra/db/migrations/0006_*.sql` | migration | DDL | `0003_phase01_02_tabelas.sql` + `0004_guards_and_audit.sql` | exact |
| `src/infra/db/queries/llm-runs.ts` | query | CRUD (append) | `src/infra/db/queries/blocked-attempts.ts` | exact |
| `src/infra/db/queries/review-events.ts` | query | CRUD (append) | `src/infra/db/queries/blocked-attempts.ts` | exact |
| `src/infra/db/queries/llm-context.ts` (leitura de contexto) | query | read | `src/infra/db/queries/snapshot.ts` | role-match |
| `src/cli/shadow.ts` | CLI | request-response | `scripts/apply-migrations.ts` + `src/index.ts` | role-match |
| `scripts/shadow-report.ts` (`npm run shadow:report`) | script | batch/transform | `src/infra/db/queries/daily-report.ts` | role-match |
| `tests/adversarial/corpus.ts` + harness de bake-off | test/fixture | — | `tests/gate/fixtures.ts` | role-match |
| `tests/gate/*.test.ts` (novos) | test | — | `tests/gate/order.test.ts`, `ar-005.test.ts` | exact |
| `tests/lint/choke-point.grep.test.ts` **(MOD/estender)** | test (lint) | — | ele mesmo | exact |
| `tests/gate/fixtures.ts` **(MOD)** | test fixture | — | ele mesmo | exact |

---

## Pattern Assignments

### `src/domain/ports/LlmPort.ts` (port, request-response)

**Análogo:** `src/domain/ports/NotifyPort.ts` (interface + tipo de entrada, sem import de infra) e `src/domain/ports/LeadSourcePort.ts` (métodos assíncronos + capabilities opcionais).

Duas chamadas em tiers distintos (D-08): `extract()` (modelo barato) e `generate()`
(modelo forte). A porta **não** importa `ai` nem SDK de provider — quem faz isso é o
adaptador em `src/infra/llm/`.

**Padrão de porta (interface + tipo de entrada) — `NotifyPort.ts:9-25`:**
```typescript
export interface NotifyInput {
	readonly title: string;
	readonly message: string;
	readonly urgent: boolean;
	readonly sound?: boolean;
	readonly filePath?: string;
}

export interface NotifyPort {
	notify(input: NotifyInput): Promise<void>;
}
```

**Padrão de retorno discriminado / capabilities opcionais — `LeadSourcePort.ts:46-62`** (espelhar para o retorno tipado de `extract()`/`generate()`):
```typescript
export interface LeadSourcePort {
	fetchNewLeads(opts?: FetchNewLeadsOpts): Promise<Lead[]>;
	markValidNewLead(e164: string): void | Promise<void>;
	fetchNewChatMessageCap?(): Promise<number | null>;
	fetchAccountReachoutTimelock?(): Promise<Date | null>;
}
```
> A porta é `LlmPort` com um método por camada; a implementação real fica atrás de
> `ScriptedLlmAdapter` primeiro (RESEARCH §Summary) e o provider real só entra após o
> bake-off.

---

### `src/domain/orchestrator/transitions.ts` (domain FSM, transform puro)

**Análogo:** `src/domain/gate/evaluate-policy.ts` (função pura, mapa tipado, **falha-fechada**) e `src/domain/gate/guard-order.ts` (contrato plano vs execução).

`resolveNextState(prev, hint, ctx)` é código puro: as guardas locais **vencem a hint**;
a hint só é aceita se constar do mapa `ALLOWED[prev]`. Nada de banco, nada de rede.

**Padrão de função pura com `try/catch` fail-closed — `evaluate-policy.ts:105-121`:**
```typescript
export function evaluatePolicy(input: GateInput) {
	const checkedAt = input.context.now.toISOString();
	try {
		const bloqueio = primeiroBloqueio(input);
		if (bloqueio) {
			return { action: "block" as const, ...bloqueio, checkedAt };
		}
		return { action: "send" as const, messageId: "", checkedAt };
	} catch (erro) {
		return {
			action: "block" as const,
			reason: "erro_nao_mapeado" as const,
			detail: `erro ao avaliar o gate: ${String(erro)}`,
			checkedAt,
		};
	}
}
```

**Padrão de mapa canônico imutável + "vence o menor índice" — `guard-order.ts:45-89`** (o mapa `ALLOWED` do FSM é o mesmo formato: `readonly`, `as const`, uma fonte só):
```typescript
export const GUARD_SLOTS: readonly GuardSlot[] = [
	{ reason: "kill_switch_ativo", guard: killSwitch, owner: "[01-01]" },
	{ reason: "r001_primeiro_contato_nao_humano", guard: primeiroContato, owner: "[01-01]" },
	// ...
] as const;
```
> Esqueleto de `resolveNextState` exato em `02-RESEARCH.md` §Pattern 1 (linhas 266-292).
> O mapa `ALLOWED` deve casar com o CHECK `conversations_state_check`
> (`schema.ts:188-191`) — `novo, aquecimento, qualificando, aquecido, awaiting_human,
> human, copilot, pausado, encerrado`.

---

### `src/domain/llm/envelope.ts` (schema/validation, transform)

**Análogos:** `src/config/env.ts` (schema Zod com superRefine/preprocess e mensagens em pt-BR) e `src/domain/gate/types.ts` (união fechada como contrato).

Os schemas Zod `Output.object` (Camada 1 extração + Camada 3 geração), com
**campos-canário** que provam aderência ao schema (D-08) e o enum que separa
`pedido_preco` de `objecao_preco` (D-09).

**Padrão de schema Zod do projeto — `env.ts:63-103`:**
```typescript
export const envSchema = z.object({
	DATA_ROOT: z.string().min(1).default(DATA_ROOT_DEFAULT),
	DAILY_MESSAGE_LIMIT: z.coerce
		.number()
		.int()
		.default(25)
		.refine(
			(v) => v > 0 && v <= 30,
			"DAILY_MESSAGE_LIMIT tem de estar em 1..30 (teto fisico do banco)",
		),
	CHANNEL_PHONE_E164: phoneE164,
	// ...
});
export type Env = z.infer<typeof envSchema>;
```

**Padrão de união fechada como contrato — `types.ts:11-31`:**
```typescript
export type GateReason =
	| "kill_switch_ativo"
	| "r001_primeiro_contato_nao_humano"
	// ... (verbatim da doc)
	| "ar008_limite_diario";
```
> O enum de intenção do envelope segue o mesmo estilo — nomes em pt-BR, união
> fechada, citados verbatim na doc. Esqueleto em `02-RESEARCH.md` §Pattern 2 (linhas 304-323).

---

### `src/domain/llm/prompt-builder.ts` (utility choke-point PII, transform)

**Análogo:** `src/domain/gate/patterns/automation-disclosure.ts` (o "único lugar do projeto onde estes termos são escritos") + `src/application/humanize.ts` (funções puras exportadas para testar isoladamente).

**Choke-point único de mascaramento (D-16).** Ele mascara **todo** o payload de
egresso (contexto + histórico + última mensagem + 1ª msg do Admin), não só
`leadContext` (Pitfall 4). Nenhum outro arquivo formata prompt.

**Padrão de módulo-ponto-único com doc da decisão — `automation-disclosure.ts:1-15`:**
```typescript
/**
 * Vocabulário de conteúdo — o **único** lugar onde estes termos são escritos
 * (acceptance da task 5). `AUTOMATION_TERM` (AR-006) mora aqui; os demais ...
 */
export const CURRENCY_TERM =
	/\br\$\s*\d|[$€£]\s*\d|\breais?\b|\bdinheiro\b|\bvalor\b|\bor[çc]amento\b/i;
```

**Padrão de função pura exportada para teste isolado — `humanize.ts:76-86`:**
```typescript
export const humanDelayMs = (kind: HumanKind, seed: string): number => {
	const base = kind === "first"
		? FIRST_MIN_MS + unitario(`first:${seed}`) * (FIRST_MAX_MS - FIRST_MIN_MS)
		: FOLLOWUP_MIN_MS + unitario(`followup:${seed}`) * (FOLLOWUP_MAX_MS - FOLLOWUP_MIN_MS);
	// ...
};
```
> `maskPii(payload)` deve devolver um payload tipado equivalente; o telefone já vive
> em coluna separada (`leads.phone_number`, `leads.address_line`) — mascarar é
> substituir por placeholder antes de montar o prompt.

---

### `src/application/optout-matcher.ts` (classificador determinístico, transform)

**Análogo exato:** `src/domain/gate/patterns/price-workaround.ts` (duas listas: forte dispara sozinho, contextual exige co-ocorrência + `primeiroTermoQueCasa`).

**Matcher pt-BR é a AUTORIDADE** (D-14); o `llm_signal` só reforça. Distingue
explícito, implícito definido, e ambíguo (→ handoff, sem auto-opt-out).

**Padrão de duas listas + função de decisão — `price-workaround.ts:33-70`:**
```typescript
export const PRICE_WORKAROUND_TERM: readonly RegExp[] = [
	/\bconsigo ver com\b/i,
	/\bdepois a gente negocia\b/i,
	// ...
];
export const PRICE_WORKAROUND_CONTEXTUAL: readonly RegExp[] = [ /\bno m[áa]ximo\b/i, /* ... */ ];

export const contemContornoDePreco = (texto: string): boolean => {
	if (primeiroTermoQueCasa(texto, PRICE_WORKAROUND_TERM) !== null) return true;
	const contextual = primeiroTermoQueCasa(texto, PRICE_WORKAROUND_CONTEXTUAL);
	return contextual !== null && PRICE_TERM.test(texto);
};
```

**Helper reutilizável — `automation-disclosure.ts:110-118`** (importar em vez de reimplementar):
```typescript
export const primeiroTermoQueCasa = (
	texto: string,
	termos: readonly RegExp[],
): string | null => {
	for (const t of termos) {
		const achado = texto.match(t);
		if (achado) return achado[0];
	}
	return null;
};
```
> Regra de fronteira de palavra (`\b`) documentada em `automation-disclosure.ts:7-15`:
> acento vira classe `[áa]`, nunca normalização. Vale para todo termo pt-BR novo.

---

### `src/application/handoff-service.ts` (service, CRUD transacional)

**Análogo exato:** `src/application/inbound-handler.ts` → `registrarMidiaRecebida` (grava `handoff_events` + `conversations` na mesma rota) e `src/application/outbox.ts:137-176` (padrão `db.transaction`).

**D-11:** `HandoffService.trigger()` grava, **numa transação**: `handoff_events` +
`mode_changes` + `conversations.engagement_mode='awaiting_human'` +
`handoff_active=TRUE`. `sendIntent = NENHUMA` — o silêncio é **efeito**.

**INSERT de handoff + UPDATE de conversa (padrão existente) — `inbound-handler.ts:174-195`:**
```typescript
await db.execute(sql`
	insert into handoff_events (
		conversation_id, lead_id, channel_account_id, triggered_by,
		trigger_detail, excerpt, simultaneous_send_blocked, bot_stopped_at
	)
	values (
		${conversa.id}, ${leadId}, ${conversa.channel_account_id},
		'message_type', ${`midia recebida (${excerpt})`}, ${excerpt}, true, now()
	)
`);
await db.execute(sql`
	update conversations set pending_media_block = true where id = ${conversa.id}
`);
```
> `conversations` **aceita** UPDATE (só `messages`/`event_log`/`optout_ledger` são
> append-only). `INSERT mode_changes` com `actor='bot'` casa o CHECK
> `mode_changes_actor_check` (`schema.ts:478`).

**Padrão de transação — `dispatcher.ts:257-311`** (usar quando `HandoffService` precisa de atomicidade estrita):
```typescript
resultado = await db.transaction(async (txBruto) => {
	const tx = txBruto as unknown as Db;
	const reserva = await reserveMessageQuota(tx, dia, ctx.dailyMessageLimit, ctx.dailyMessageCap);
	// ...
});
```

---

### `src/application/shadow.ts` (service, CRUD append)

**Análogo:** `src/application/dispatcher.ts` (o INSERT em `messages`) e `src/application/inbound-handler.ts:119-143` (`gravarMensagem`).

**A rota de shadow NÃO importa o dispatcher** (Anti-Pattern; RESEARCH §Anti-Patterns
"Rota de shadow que importa o dispatcher"). Ela grava o rascunho em
`messages(origin='ai_suggestion', status='suggested')` + `llm_runs`, e **para**.

**INSERT em `messages` com status final — `inbound-handler.ts:126-142`:**
```typescript
await db.execute(sql`
	insert into messages (
		conversation_id, direction, origin, kind, body,
		status, provider_msg_id, idempotency_key
	)
	values (
		${conversaId}, ${deMim ? "out" : "in"}, ${deMim ? "admin" : "lead"},
		${kind}, ${evt.body}, 'sent', ${evt.providerMsgId ?? null}, ${chaveIdempotente(evt)}
	)
	on conflict (idempotency_key) do nothing
`);
```

**INSERT via Drizzle + `onConflictDoNothing` + `.returning` — `dispatcher.ts:280-293`:**
```typescript
const inseridos = await tx
	.insert(messages)
	.values({
		conversationId, direction: "out",
		origin: ORIGEM_DA_MENSAGEM[input.origin ?? "bot"],
		kind: "text", body: pedaco, status: "sent",
		idempotencyKey: chavePedaco, createdAt: agora,
	})
	.onConflictDoNothing({ target: messages.idempotencyKey })
	.returning({ id: messages.id });
```
> O rascunho usa `status:'suggested'` e `origin:'ai_suggestion'` — ambos **já aceitos**
> pelos CHECKs `messages_status_check` (`schema.ts:240-243`) e `messages_origin_check`
> (`schema.ts:235-238`). **Nunca** `UPDATE messages` para promover (Pitfall 1).

---

### `src/application/inbound-handler.ts` (MOD, handler)

**Análogo:** ele mesmo. É o ponto de acoplamento da Camada 1 (extração) + Camada 2 (resolução/registro).

**Ordem inegociável já implementada** (`inbound-handler.ts:1-22`): resolve E.164 →
mídia → `messages` → `first_contact_by_human` → watermark. A Camada 1/2 entra **depois**
de (c) e antes de (e), guardada pelos guardas locais em código (opt-out ativo,
`pending_media_block`, `engagement_mode != bot_active`).

**Padrão de guarda local em código, antes de tudo — ver `inbound-handler.ts:238-246`:**
```typescript
const ehMidia =
	evt.isMedia === true ||
	(evt.kind !== undefined && evt.kind !== "text" && evt.kind !== "link");
if (ehMidia) {
	const conversa = await pegarOuCriarConversa(db, lead.id);
	await registrarMidiaRecebida(db, conversa, lead.id, evt);
	return;
}
```
> **Não** reconstruir `registrarMidiaRecebida` — ela já grava o negativo AR-009 +
handoff. A Fase 2 só acrescenta o ramo "camada 1 → camada 2" para texto/link.

---

### `src/infra/llm/ai-sdk-adapter.ts` (adapter, request-response)

**Análogos:** `src/infra/notifier.ts` (implementa `NotifyPort` sobre recurso externo, **nunca lança** em caminho crítico) e `src/infra/http-lead-source.ts` (implementa `LeadSourcePort`).

Implementa `LlmPort` sobre `ai@7` (`generateText({ output: Output.object({ schema }) })`),
trata `NoObjectGeneratedError`/`NoOutputGeneratedError`, faz **1 reprompt** e, se
persistir, **falha-fechada** (D-10) — devolve um resultado de erro, nunca texto livre.

**Padrão de fábrica que implementa uma porta — `notifier.ts:23-86`:**
```typescript
export const criarNotifier = (scriptPath: string = SCRIPT): NotifyPort => ({
	notify(input: NotifyInput): Promise<void> {
		return new Promise<void>((resolva) => {
			// ... nunca rejeita, nunca lança
			const finalizar = (evento: string, detalhe: string) => {
				if (encerrado) return;
				encerrado = true;
				logger.warn({ event: evento }, detalhe);
				resolva();
			};
			// ...
		});
	},
});
```

**Erros tipados do `Output.object` (fail-closed) — `02-RESEARCH.md` §Code Examples (linhas 437-453):**
```typescript
import { generateText, Output, NoObjectGeneratedError, NoOutputGeneratedError } from 'ai';
try {
  const { output } = await generateText({ model, output: Output.object({ schema }), prompt });
  if (output.canary !== canaryEsperado) throw new Error('CANARIO_DIVERGENTE');
  return output;
} catch (erro) {
  if (NoObjectGeneratedError.isInstance(erro)) { /* 1 reprompt */ }
  else if (NoOutputGeneratedError.isInstance(erro)) { /* silêncio + notify */ }
}
```
> A escolha de provider/modelo é **injetada** (resultado do bake-off), não hard-coded
> no adaptador.

---

### `src/infra/llm/scripted-adapter.ts` (adapter dublê, determinístico)

**Análogos exatos:** `src/infra/fake-channel.ts` e `src/infra/fake-lead-source.ts` (adaptadores fake que implementam a porta sem rede). Primeiro artefato de LLM a construir (RESEARCH §Summary).

**Padrão de adaptador fake — `src/infra/fake-lead-source.ts`** (replicar a forma: implementa a interface, resposta determinística, sem I/O):
```typescript
// Implementa LeadSourcePort; a fonte fake é síncrona e a HTTP é assíncrona,
// e a diferença não vaza para o importador (LeadSourcePort.ts:50-55).
export const fakeLeadSource = (leads: Lead[]): LeadSourcePort => ({ /* ... */ });
```
> O `ScriptedLlmAdapter` devolve envelopes/envelopes-gerados pré-definidos por
> cenário, permitindo rodar a fase inteira em shadow **sem chave de API**
> (RESEARCH §Environment Availability).

---

### `src/infra/db/schema.ts` (MOD, model)

**Análogo:** ele mesmo. Acrescentar `llmRuns` (+ `reviewEvents`) e **alterar o CHECK de `engagement_mode`**.

**Padrão de tabela append-only com CHECK + FK — `schema.ts:343-392` (`optoutLedger`):**
```typescript
export const optoutLedger = pgTable(
	"optout_ledger",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		leadId: uuid("lead_id").notNull().references(() => leads.id),
		eventType: text("event_type").notNull(),
		// ...
	},
	(t) => [
		check("optout_ledger_event_type_check", sql`event_type IN ('opt_out', 'erasure_request', 'reinstate')`),
		check("optout_ledger_detected_by_check", sql`detected_by IS NULL OR detected_by IN ('deterministic', 'llm_signal')`),
		index("optout_ledger_lead_occurred_idx").on(t.leadId, sql`${t.occurredAt} DESC`),
	],
);
```
> `detected_by IN ('deterministic', 'llm_signal')` **já existe** (`schema.ts:381-384`)
> — o matcher pt-BR grava `'deterministic'`; o reforço LLM grava `'llm_signal'`.

**O CHECK a alterar — `schema.ts:188-195`:**
```typescript
check(
	"conversations_state_check",
	sql`state IN ('novo', 'aquecimento', 'qualificando', 'aquecido', 'awaiting_human', 'human', 'copilot', 'pausado', 'encerrado')`,
),
check(
	"conversations_engagement_mode_check",
	sql`engagement_mode IN ('bot_active', 'awaiting_human', 'human', 'copilot', 'pausado')`,
),  // ← FALTA 'shadow' (Pitfall 2)
```
> E também `mode_changes_to_mode_check`/`from_mode_check` (`schema.ts:469-477`) — ambos
> precisam receber `'shadow'` na migração 0006.

**FK `messages.id` para o `llmRuns` · padrão `outbox.messageId` — `schema.ts:262`:**
```typescript
messageId: uuid("message_id").references(() => messages.id),
```

---

### `src/infra/db/migrations/0006_*.sql` (migration, DDL)

**Análogos:** `0003_phase01_02_tabelas.sql` (DDL de tabela + CHECK + FK + índice) e `0004_guards_and_audit.sql` (função/trigger append-only + `REVOKE` + `COMMENT`).

**O que a 0006 precisa conter (Pitfall 2 é bloqueante):**
1. `ALTER TABLE conversations DROP CONSTRAINT conversations_engagement_mode_check; ADD ... CHECK (... IN (..., 'shadow'))`.
2. Idem para `mode_changes_to_mode_check` e `mode_changes_from_mode_check`.
3. `CREATE TABLE llm_runs (...)` com FK para `messages(id)`.
4. `CREATE TABLE review_events (...)` (Open Question 4) — append-only.
5. Triggers `trg_llm_runs_append_only` / `trg_review_events_append_only` + `REVOKE UPDATE, DELETE`.

**Padrão de DDL — `0003_phase01_02_tabelas.sql:40-54`:**
```sql
CREATE TABLE "handoff_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	-- ...
	"simultaneous_send_blocked" boolean NOT NULL,
	CONSTRAINT "handoff_events_triggered_by_check" CHECK (triggered_by IN ('keyword', 'intent', 'message_type', 'opt_out', 'validation_error', 'low_confidence', 'user_defined'))
);
```

**Padrão de append-only (função única reutilizada) — `0004_guards_and_audit.sql:41-49` + `:106-119`:**
```sql
CREATE OR REPLACE FUNCTION fn_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
begin
	raise exception 'tabela % e append-only (R-043): % proibido', TG_TABLE_NAME, TG_OP;
	return null;
end;
$$;

DROP TRIGGER IF EXISTS trg_llm_runs_append_only on llm_runs;
CREATE TRIGGER trg_llm_runs_append_only
	before update or delete on llm_runs
	for each row execute function fn_append_only();
```
> Reutilizar `fn_append_only` (não criar segunda função). Adicionar
> `REVOKE UPDATE, DELETE ON llm_runs FROM PUBLIC;` como em `0004:200-202`.
> Registrar a migration em `meta/_journal.json` e `meta/0005_snapshot.json` via
> `npm run db:generate` (padrão do projeto — ver `0005_seed_admin.sql`).

---

### `src/infra/db/queries/llm-runs.ts` · `review-events.ts` (query, CRUD append)

**Análogo exato:** `src/infra/db/queries/blocked-attempts.ts` (escrita com `RETURNING id` + leitura com narrowing explícito + teto de `limit`).

**Padrão de escrita que devolve id (correlaciona log ↔ auditoria) — `blocked-attempts.ts:107-150`:**
```typescript
export const recordBlockedAttempt = async (db: Db, input: NegativoDoGate): Promise<string> => {
	const resultado = await db.execute(sql`
		insert into ${blockedAttempts} ( conversation_id, lead_id, direction, guard, reason_code, rule_reference, excerpt, detail, window_at_event, created_at )
		values ( ${input.conversationId}, ${input.leadId ?? null}, ${input.direction ?? "out"}, ${input.guard ?? null}, ${input.ruleReference}, ${input.ruleReference}, ${input.excerpt ?? cortaExcerpt(input.detail)}, ${input.detail}, ${input.windowAtEvent ?? null}, ${coalesceCreatedAt(input.createdAt)} )
		returning id
	`);
	const rows = (resultado as unknown as { rows: { id: string }[] }).rows;
	const primeira = rows[0];
	if (!primeira) throw new Error("recordBlockedAttempt: o INSERT não devolveu id ...");
	return primeira.id;
};
```

**Padrão de leitura com teto duplo e narrowing — `blocked-attempts.ts:185-214`:**
```typescript
const teto = Math.min(Math.max(Math.trunc(limit), 1), 200);
const resultado = await db.execute(sql`
	select id, conversation_id, /* ... */ from ${blockedAttempts}
	where conversation_id = ${conversationId}
	order by blocked_at desc
	limit ${teto}
`);
return (resultado as unknown as { rows: Record<string, unknown>[] }).rows.map(paraNegativoLido);
```
> `llm_runs` guarda **metadados** (modelo, tokens, latência, custo, versão do prompt,
> versão da política) — **nunca** o corpo do prompt/resposta (R-045/Pitfall 4).
> `review_events(message_id, decision, actor, edited_text?, created_at)` é a decisão
> append-only (D-06).

---

### `src/infra/db/queries/llm-context.ts` (query, read)

**Análogo:** `src/infra/db/queries/snapshot.ts` (um único SELECT com joins; normalização de valores do banco para uniões fechadas; `null` declarado).

Monta o contexto da Camada 3 (histórico + 1ª msg do Admin + `conversations.state`/
`qualification`) num só SELECT — mesma disciplina de "um instantâneo".

**Padrão de snapshot único + narrowing de modo — `snapshot.ts:63-74` e `149-183`:**
```typescript
const MODOS = ["bot_active", "awaiting_human", "human", "copilot", "pausado"] as const;
type Modo = (typeof MODOS)[number];
const paraModo = (bruto: string): Modo => MODOS.find((m) => m === bruto) ?? "pausado";

export const loadGateSnapshot = async (db, conversationId, agora, ctx): Promise<GateInput | null> => {
	const resultado = await db.execute(sql`
		select l.id as lead_id, /* ... */ c.engagement_mode, c.handoff_active, c.pending_media_block, not coalesce(a.is_active, false) as kill_switch
		from ${conversations} c
		left join ${leads} l on l.id = c.lead_id
		left join ${channelAccounts} a on a.id = c.channel_account_id
		where c.id = ${conversationId}
	`);
	const row = (resultado as unknown as { rows: SnapshotRow[] }).rows[0];
	if (!row) return null;
	return paraGateInput(row, agora, ctx);
};
```
> **`paraModo` precisa aceitar `'shadow'`** — hoje ele cai em `"pausado"` para valores
> desconhecidos (`snapshot.ts:73-74`), o que silenciaria uma conversa em shadow. Ajustar
> a lista `MODOS` em sincronia com o CHECK da migração 0006.

---

### `src/cli/shadow.ts` (CLI, request-response)

**Análogos:** `scripts/apply-migrations.ts` (script `tsx` standalone) e `src/index.ts` (boot que abre `openDb`/`closeDb`). Não há `src/cli/` ainda.

**Padrão de comando `tsx` — `package.json:8-20`** (entrada a registrar: `shadow:list`, `shadow:approve|edit|discard`, `shadow:report`, `mode`):
```json
"scripts": {
	"dev": "tsx src/index.ts",
	"lint:verify": "node scripts/lint-verify-chains.mjs .planning/phases/01-funda-o-canal-e-gate-de-envio",
	"db:generate": "drizzle-kit generate",
	"notify": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/notify.ps1"
}
```

**Padrão de ciclo de vida DB (abre, usa, fecha) — `client.ts:31-47`:**
```typescript
export const openDb = async (connectionString: string): Promise<OpenDb> => { /* migrate() + pool max 5 */ };
export const closeDb = async ({ pool }: OpenDb): Promise<void> => { await pool.end(); };
```
> Revisão de shadow grava **evento append-only** (D-03/D-06), nunca `UPDATE` no
> rascunho. Kill switch (D-02) seta `settings.operational_mode='paused'` + registra em
> `mode_changes`; o gate já devolve `kill_switch_ativo`.

---

### `scripts/shadow-report.ts` (`npm run shadow:report`, script batch)

**Análogo:** `src/infra/db/queries/daily-report.ts` (consulta agregada a partir do banco) + gravação do relatório em `event_log` (`src/index.ts:391-419`).

**Padrão de relatório gerado do banco e gravado em `event_log` — `index.ts:391-402`:**
```typescript
const relatorio = await dailyReport(conn.db, diaEmSaoPaulo(new Date()));
await conn.db.execute(sql`
	insert into event_log (event_type, entity_type, payload, severity)
	values ('piloto_relatorio_diario', 'daily_report', ${JSON.stringify(relatorio)}::jsonb, 'info')
`);
```
> O relatório de shadow (D-17) conta aprovado/editado/descartado, alucinações,
> revelações de automação, latência e custo — todos **deriváveis** de `review_events`
> + `llm_runs` + `blocked_attempts` + `event_log`. É o **gate de saída da Fase 2**.

---

### Testes (`tests/**`, Vitest)

**Análogo exato:** `tests/gate/*.test.ts` + `tests/gate/fixtures.ts`.

**Padrão de fixture "um estado válido, varia UMA dimensão" — `fixtures.ts:114-162`:**
```typescript
export const validInbound = (overrides: GateInputOverrides = {}): GateInput => ({
	lead: { id: "11111111-...", phoneNumber: "+5511999999999", optOut: false,
		/* ... */ firstContactByHuman: true, waValidationState: "valid", ...overrides.lead },
	conversation: { id: "22222222-...", state: "bot_active", engagementMode: "bot_active",
		handoffActive: false, pendingMediaBlock: false, ...overrides.conversation },
	outbound: { ...validOutbound(TEXTO_NEUTRO), ...overrides.outbound },
	context: { killSwitch: false, now: new Date(DIA_UTIL_DENTRO_DA_JANELA), /* ... */ ...overrides.context },
});
```
> **`engagementMode`/`state` do fixture precisa passar a aceitar `'shadow'`** quando o
> CHECK mudar. Hoje a união de `GateInput["conversation"]["engagementMode"]`
> (`types.ts:58-63`) **não tem `'shadow'`** — estender tipo + fixture + `MODOS` em
> `snapshot.ts` na mesma migração.

**Padrão de property test com seed fixa — `ar-005.test.ts:16-29` e `order.test.ts:134-147`:**
```typescript
fc.assert(
	fc.property(fc.string(), (texto) => {
		const decisao = evaluatePolicy(validInbound({ lead: { optOut: true }, outbound: { text: texto } }));
		expect(decisao).toMatchObject({ action: "block", reason: "ar005_opt_out" });
	}),
	{ seed: 20260928, numRuns: 500 },
);
```
> Replicar para: idempotência do `HandoffService`, invariantes de `resolveNextState`
> (as guardas vencem a hint), e o matcher pt-BR (inclui o conjunto adversarial ~200).
> `fast-check` já está instalado (`package.json:26`).

**Padrão de teste de choke-point estrutural — `tests/lint/choke-point.grep.test.ts:30-63`:**
```typescript
const CHAMADA = /\.sendText\s*\(/;
const UNICO_PERMITIDO = "src/application/dispatcher.ts";
// ...
expect(infratores).toEqual([UNICO_PERMITIDO]);
```
> **Estender** este teste (ou criar `tests/lint/shadow-no-dispatch.grep.test.ts`) para
> afirmar que `src/application/shadow.ts` **não** importa `dispatcher` nem contém
> `sendText(` — é a barreira mecânica do Anti-Pattern "rota de shadow que importa o
> dispatcher".

---

## Shared Patterns

### Porta/Adaptador (toda integração externa)
**Fonte:** `src/domain/ports/NotifyPort.ts` (interface) + `src/infra/notifier.ts` (adapter) + `src/infra/fake-*.ts` (dublê).
**Aplicar a:** `LlmPort` + `ai-sdk-adapter` + `scripted-adapter`.
```typescript
// Interface no domínio, mecanismo na infra, dublê nos testes.
export interface NotifyPort { notify(input: NotifyInput): Promise<void>; }
export const criarNotifier = (scriptPath = SCRIPT): NotifyPort => ({ /* spawn, nunca lança */ });
```

### Fail-closed (erro → silêncio + evento, nunca envio não sanitizado)
**Fonte:** `src/domain/gate/evaluate-policy.ts:113-120` (try/catch → `erro_nao_mapeado`) e `src/application/dispatcher.ts:163-170`.
**Aplicar a:** `ai-sdk-adapter`, `shadow.ts`, `handoff-service.ts`, `inbound-handler`.
```typescript
} catch (erro) {
	return { action: "block" as const, reason: "erro_nao_mapeado" as const,
		detail: `erro ao avaliar o gate: ${String(erro)}`, checkedAt };
}
```

### SQL cru via `db.execute` + `linhasDe`/`.rows` (sem ORM na leitura de relatório)
**Fonte:** `src/application/inbound-handler.ts:37-39` e `src/infra/db/queries/*.ts`.
**Aplicar a:** todas as queries novas (`llm-runs.ts`, `review-events.ts`, `llm-context.ts`) e escritas de `handoff-service.ts`.
```typescript
const linhasDe = <T>(resultado: unknown): T[] =>
	(resultado as { rows: T[] }).rows;
```

### Transação atômica para estado + auditoria
**Fonte:** `src/application/dispatcher.ts:257-311` e `src/application/outbox.ts:137-176`.
**Aplicar a:** `HandoffService.trigger()` (D-11) e `shadow.ts` (rascunho + `llm_runs`).
```typescript
await db.transaction(async (txBruto) => {
	const tx = txBruto as unknown as Db;
	// inserts/updates na mesma transação
});
```

### Append-only (R-043): escrever com o estado final, nunca UPDATE
**Fonte:** `schema.ts:199-245` (comentário de `messages`) + `0004_guards_and_audit.sql:106-119` + `outbox.ts:179-205` (nota "não faz UPDATE messages.status").
**Aplicar a:** rascunhos, `llm_runs`, `review_events`.
> `UPDATE messages SET status='sent'` é **bloqueado no banco** (Pitfall 1). A decisão
> de revisão é evento append-only; `status` do rascunho nunca é mutado (D-06).

### Vocabulário regex em um único módulo pt-BR (fronteira `\b`, acento como classe)
**Fonte:** `src/domain/gate/patterns/automation-disclosure.ts` (`CURRENCY_TERM`, `SCHEDULE_TERM`, `AUTOMATION_TERM`, `primeiroTermoQueCasa`) e `price-workaround.ts`.
**Aplicar a:** `optout-matcher.ts` (novos termos de opt-out/irritação) e ao post-gate L4 de `shadow.ts`.

### Log estruturado com redact no logger (nunca corpo de conversa)
**Fonte:** `src/infra/logger.ts:23-71` + `src/infra/notifier.ts:71-79`.
**Aplicar a:** `ai-sdk-adapter` (logar tokens/latência/`zod_parse_ok`, nunca o transcript), `shadow.ts`, `handoff-service.ts`.
```typescript
logger.info({ event: "notify_sent", urgent: input.urgent },
	`notificacao local emitida (${input.title.length} chars)`); // comprimento, não conteúdo
```

### Notificação local via `NotifyPort` (som + pop-up)
**Fonte:** `src/infra/notifier.ts` → `scripts/notify.ps1` (testado, com AUMID/WinRT).
**Aplicar a:** `HandoffService` (FLUP-05, R-013) e qualquer falha fail-closed da LLM (D-10).
> Nesta fase **não** há chime Web Audio (deferido à Fase 3). O `NotifyPort.notify` **não lança**.

### Chave de idempotência (dedup de retry/reroll)
**Fonte:** `src/application/inbound-handler.ts:112-116` (`chaveIdempotente`) e `dispatcher.ts:273-274` (`chave#n`).
**Aplicar a:** INSERT de rascunho e de `llm_runs` para que um reprompt não duplique linha.
```typescript
const chaveIdempotente = (evt: EventoInbound): string =>
	createHash("sha256").update(evt.providerMsgId ?? `${evt.chatId}|${evt.timestamp}|${evt.body}`).digest("hex");
```

---

## Ajustes de contrato obrigatórios (Pitfalls → código)

Estes quatro pontos **não podem ser esquecidos** — cada um é uma armadilha verificada:

| Pitfall | Onde corrigir | Padrão |
|---------|---------------|--------|
| **1 — `messages` append-only** | `shadow.ts`, `review-events.ts` | Nada de `UPDATE messages SET status='sent'`. Decisão = evento (`review_events`), `status='suggested'` fica imutável (D-06; `0004:106-109`). |
| **2 — CHECK não conhece `'shadow'`** | `0006_*.sql` + `schema.ts` + `snapshot.ts` + `types.ts` + `fixtures.ts` | `ALTER TABLE ... DROP CONSTRAINT ... ADD CHECK (... 'shadow')` em `conversations`, `mode_changes.from_mode`, `mode_changes.to_mode`. |
| **3 — três interruptores de shadow** | decisão de arquitetura | Fonte única = `conversations.engagement_mode='shadow'` (por conversa). `settings.operational_mode` é **só** kill switch global (D-02). Flag global `shadowMode` do ADR-010 **superseded**. |
| **4 — PII no histórico** | `prompt-builder.ts` | Mascarar **todo** o payload de egresso (contexto + histórico + última msg + 1ª msg do Admin), não só `leadContext` (D-16). |

---

## No Analog Found

| Arquivo | Papel | Data Flow | Razão |
|---------|-------|-----------|-------|
| `src/domain/ports/LlmPort.ts` | port | request-response | Não há análogo de LLM; usar `NotifyPort.ts`/`LeadSourcePort.ts` como **forma** (interface + tipos + fake), não como conteúdo. |
| Harness de bake-off de provedor (`scripts/bake-off.ts` ou `tests/bake-off/*`) | script/test | batch | Não há precedente no repo; usar `tests/gate/fixtures.ts` (corpus/cenários) + `02-RESEARCH.md` §Open Questions 3 (corpus ~200 + rubrica). |

---

## Arquivos Referenciados que NÃO Existem (a criar — confirmado por varredura)

Todos os caminhos abaixo foram verificados em disco e **não existem** hoje (a varredura
listou `src/**` e `tests/**`; os diretórios `src/domain/orchestrator/`, `src/domain/llm/`,
`src/infra/llm/` e `src/cli/` não existem):

- `src/domain/ports/LlmPort.ts`
- `src/domain/orchestrator/transitions.ts` — **nota:** `CONTEXT.md:39` e `ARCHITECTURE`
  citam `core/orchestrator/transitions.ts`; o layout real deste repo é `src/domain/orchestrator/`.
- `src/domain/llm/envelope.ts`
- `src/domain/llm/prompt-builder.ts`
- `src/application/handoff-service.ts`
- `src/application/optout-matcher.ts`
- `src/application/shadow.ts`
- `src/infra/llm/ai-sdk-adapter.ts`
- `src/infra/llm/scripted-adapter.ts`
- `src/infra/db/migrations/0006_*.sql` (`_journal.json` termina em `0005_seed_admin`)
- `src/infra/db/queries/llm-runs.ts`, `review-events.ts`, `llm-context.ts`
- `src/cli/shadow.ts`
- `scripts/shadow-report.ts`
- Tabelas `llm_runs` e `review_events` (15 tabelas atuais em `schema.ts`)
- `tests/**` novos (transitions, handoff-service, optout-matcher, llm, adversarial, lint shadow)

**Duas supersessions a registrar no plano:**
- Tabela `suggestions` do ADR-010 → substituída por `messages(origin='ai_suggestion', status='suggested')` + `llm_runs` (D-04/D-05).
- Flag global `settings.shadowMode` do ADR-010 → substituída por `conversations.engagement_mode='shadow'` (Pitfall 3).
- Chime Web Audio (ROADMAP 02-02) → **fora de escopo** (Fase 3); notificação da Fase 2 = `notify.ps1`.

---

## Metadata

**Escopo de busca de análogos:** `src/domain/**`, `src/application/**`, `src/infra/**`,
`src/infra/db/{schema.ts,migrations,queries}`, `tests/**`, `scripts/**`, `biome.json`,
`package.json`. `src/domain/gate/**` completo (evaluate-policy, guard-order, types,
kill-switch, patterns).

**Arquivos escaneados:** ~30 (leitura direta); varredura de existência em `src/**` +
`tests/**` + `scripts/**`.

**Data de extração:** 2026-10-13.

**Confiança:** HIGH — os dois pitfalls críticos (append-only em `messages` e CHECK sem
`'shadow'`) foram confirmados no código em disco (`schema.ts:188-195`,
`0004_guards_and_audit.sql:106-119`).
