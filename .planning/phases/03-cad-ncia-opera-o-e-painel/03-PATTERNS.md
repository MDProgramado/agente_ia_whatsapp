# Phase 3: Cadência, Operação e Painel - Pattern Map

**Mapped:** 2026-10-15
**Files analyzed:** 27 (new + modified; frontend grouped)
**Analogs found:** 21 / 27 — **o SPA React (`src/web/`) é inteiramente novo neste codebase (nenhum `.tsx/.jsx/.html/.css` existe); flagado abaixo**

> Regra-mestra herdada (invariante de ordem): `evaluatePolicy` é o único gate e roda antes de qualquer envio; `sendText` existe **só** em `src/application/dispatcher.ts` (provado por `tests/lint/choke-point.grep.test.ts`). Nenhum arquivo novo desta fase pode importar `channel.sendText` — o painel envia **pelo gate**, via `dispatch`, com `origin='admin'`.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/domain/feriados-br.ts` | domain | transform (puro) | `src/domain/business-hours.ts` | exact |
| `src/domain/cadence.ts` | domain | transform (puro) | `src/domain/business-hours.ts` + `src/domain/orchestrator/transitions.ts` | role-match |
| `src/domain/pipeline.ts` | domain | transform (puro) | `src/domain/orchestrator/transitions.ts` | exact (role) |
| `src/application/scheduler.ts` | service | event-driven (tick 30s) | `src/infra/health-monitor.ts` (Cron) + `src/application/outbox-worker.ts` (laço) | role-match |
| `src/application/catchup-drain.ts` | service | batch (dreno limitado) | `src/application/outbox-worker.ts` + `src/application/humanize.ts` | role-match |
| `src/application/copilot.ts` | service | request-response (LLM→sugestão) | `src/application/shadow.ts` | exact (role) |
| `src/application/appointment.ts` | service | CRUD (agendar) + event-driven (handoff) | `src/application/outbox.ts` + `src/application/handoff-service.ts` | role-match |
| `src/api/server.ts` | config/server | request-response | **sem análogo direto** — 1ª superfície HTTP do projeto; wiring parcial: `src/index.ts` | no-analog (ver §No Analog) |
| `src/api/auth.ts` | middleware | request-response | **sem análogo** — esqueleto no RESEARCH §Pattern 4; env zod: `src/config/env.ts` | no-analog |
| `src/api/sse.ts` | middleware | streaming (server→browser) | **sem análogo direto** — fonte de eventos: `src/application/event-bus.ts` | no-analog (parcial) |
| `src/api/routes/*.ts` (leads, conversations, messages, crm, settings, dispatch) | controller | request-response | **sem análogo** — validação segue Zod (RESEARCH §Don't Hand-Roll) | no-analog |
| `src/infra/db/queries/crm.ts` | model/query | CRUD server-side | `src/infra/db/queries/status-history.ts` (par record+load) | role-match |
| `src/infra/db/queries/scheduler.ts` | model/query | batch (seleção + reconciliação) | `src/application/outbox.ts` (SELECT … FOR UPDATE SKIP LOCKED) | role-match |
| `src/infra/db/schema.ts` (modificado) | config | — | ele mesmo | exact |
| `src/infra/db/migrations/0007_*.sql` | migration | DDL | `src/infra/db/migrations/0006_shadow_and_llm_runs.sql` | exact |
| `src/config/env.ts` (modificado: `PANEL_TOKEN`, `PANEL_PORT`) | config | — | ele mesmo | exact |
| `src/index.ts` (modificado: boot scheduler + Fastify) | config/boot | — | ele mesmo (ordem de boot) | exact |
| `src/web/index.html`, `src/web/main.tsx`, `src/web/App.tsx` | component/entry | — | **NENHUM — codebase não tem frontend** | no-analog |
| `src/web/components/*` (~25 componentes do UI-SPEC §Component Inventory) | component | request-response (fetch + EventSource) | **NENHUM** — construir conforme `03-UI-SPEC.md` | no-analog |
| `vite.config.ts`, Tailwind entry CSS, `package.json` (deps UI) | config/build | — | **NENHUM** — Tailwind v4 muda a sintaxe (RESEARCH A1/Q2) | no-analog |
| `docs/08-adr/014-scheduler-cadencia.md`, `015-pipeline-crm-copiloto.md` | docs | — | `docs/08-adr/009-follow-up-conservador.md` | exact (role) |
| Edições em `docs/01-requisitos-funcionais.md`, `docs/03-regras-de-negocio.md` | docs | — | padrão de reconciliação já usado em fases anteriores | role-match |
| `tests/domain/feriados-br.test.ts` | test | transform | `tests/domain/business-hours.test.ts` | exact |
| `tests/domain/cadence.test.ts`, `tests/domain/pipeline.test.ts` | test | transform | `tests/domain/transitions.test.ts`, `tests/domain/business-hours.test.ts` | exact |
| `tests/application/scheduler.test.ts`, `tests/application/catchup-drain.test.ts` | test | batch/event-driven | `tests/application/outbox.test.ts`, `tests/application/outbox-worker-revalidation.test.ts` | role-match |
| `tests/lint/choke-point.grep.test.ts` (garantir verde) | test | lint | ele mesmo | exact |

---

## Pattern Assignments

### `src/domain/feriados-br.ts` (domain, transform puro)

**Analog:** `src/domain/business-hours.ts` — o próprio cabeçalho declara a regra de desenho: módulo sem I/O, funções puras, fuso por parâmetro.

**Padrão de cabeçalho/import — pure module, tz por parâmetro** (lines 1-11):
```ts
/**
 * A janela operacional (AR-007 / R-006 / R-058): dias úteis, 7h–17h.
 *
 * Módulo separado e sem I/O porque a mesma pergunta é feita em dois lugares: o
 * guard AR-007 decide, e a fila pergunta "quando reprocessar?".
 */
```

**Delta D-09/D-10 sobre `nextWindow`** (lines 139-172) — o loop `salto` só pula fim de semana; estender passando feriados como **dependência (parâmetro)**, mantendo a função pura:
```ts
export const nextWindow = (instante: Date, tz: string, inicio: number, fim: number): Date => {
  // ...
  let salto = 1;
  while (salto <= 7) {
    const diaDaSemana = (p.diaDaSemana + salto) % 7;
    if (diaDaSemana >= 1 && diaDaSemana <= 5) break;   // ← Fase 3: acrescentar "E não é feriado"
    salto += 1;
  }
  // ...
};
```
`ehDiaUtil` (lines 63-66) ganha o mesmo parâmetro opcional de feriados. Testar contra anos conhecidos (2026: Páscoa 05/04, Carnaval 17/02, Sexta Santa 03/04, Corpus Christi 04/06 — RESEARCH Pitfall 8). Override via `settings.calendar.holidays` lido com `value #>> '{}'` (ver §Shared: Settings).

---

### `src/domain/cadence.ts` (domain, transform puro)

**Analog:** `src/domain/business-hours.ts` (função pura, testável) + `src/domain/orchestrator/transitions.ts` (matriz de transição declarativa — descrita no RESEARCH como `ALLOWED` + `resolveNextState`).

**Padrão de matriz declarativa — como `transitions.ts` é consumido** (uso real, `src/application/handoff-service.ts` lines 180-182):
```ts
// A FSM decide o `state`; a parada já está provada por `handoff_active`.
const proximo = resolveNextState(conv.state as Estado, undefined, {
  handoffDisparado: true,
});
```

**Regra de âncora (D-01):** `proximaTentativa = last_outbound_at + DELTAS[follow_up_index]` com `DELTAS = [1h, 1d, 3d, 7d]` (ms). O tick só **compara** `proximaTentativa <= now`; **nunca reancora em `now()`** (RESEARCH Pitfall 2 — warning sign: `scheduled_for` mudando a cada tick). Cursor: `conversations.follow_up_index` (já existe, `schema.ts:169`); watermark de silêncio: `conversations.last_inbound_at` (D-12 — read receipts não contam).

---

### `src/domain/pipeline.ts` (domain, transform puro)

**Analog:** `src/domain/orchestrator/transitions.ts` — mesma forma: constantes do domínio + função pura de transição, consumida por application.

**Os 3 domínios que NÃO podem se misturar (D-14, RESEARCH Pitfall 6):**
- `conversations.state` — FSM do motor (`resolveNextState`), CHECK em `schema.ts:189-192`
- `conversations.stage` — sub-estágio de qualificação
- `conversations.pipeline_status` — **novo** (coluna nova com CHECK dos 9 valores: `novo, contatado, respondeu, qualificado, aquecido, reuniao_agendada, proposta, fechado, perdido`; default `novo`)

Motivos de `closed_reason` (D-15): `sem_resposta, sem_interesse, sem_verba, sem_decisao, concorrente, fora_do_perfil, opt_out, bad_timing, outro`. Status críticos exigem justificativa (RN-082). Toda transição grava `status_history` via `recordStatusChange` (ver §Shared: Audit trail). `opt_out` é terminal e irreversível (D-16/AR-005) — `leads` já tem trigger de UPDATE que impede unset.

---

### `src/application/scheduler.ts` (service, event-driven — tick 30s)

**Analog principal:** `src/infra/health-monitor.ts` — o padrão de tick `croner` in-process do projeto:
```ts
// src/infra/health-monitor.ts lines 42-47
const job = new Cron(deps.cronPattern, { maxRuns: Infinity }, async () => {
  if (parado) return;
  await tick();
});
// ... expõe { stop, tick, parado } — HealthMonitor (lines 118-125)
```

**Analog secundário:** `src/application/outbox-worker.ts` (o laço + resolução por item; D-04 diz "padrão já usado por drainLoop"):
```ts
// src/application/outbox-worker.ts lines 118-128
export const drainLoop = async (db, deps, opts = {}): Promise<void> => {
  const intervalMs = opts.intervalMs ?? 30_000;
  while (!opts.signal?.aborted) {
    await drainOnce(db, deps, opts);
    await sleep(intervalMs);
  }
};
```

**O tick NUNCA envia — só produz para o outbox** (RESEARCH Pattern 1, anti-padroes):
```ts
// produtor idempotente — reusa src/application/outbox.ts enqueue (lines 100-118)
const id = await enqueue(db, {
  conversationId,
  origin: "followup",                    // ou 'catchup' no dreno (D-07)
  body: textoVariado,
  idempotencyKey: `flup:${conversationId}:${index}`,   // D-05
  scheduledFor: proximaTentativa,        // last_outbound_at + DELTAS[index]
});
// id === null ⇒ já estava na fila; um segundo INSERT criaria um segundo ENVIO.
```

**Cancelar = linha auditável, nunca DELETE** (RESEARCH Pattern 3; colunas já existem em `scheduled_tasks`, `schema.ts:636-637`; status CHECK é `pending|done|failed|abandoned` — usar `abandoned` + `cancelled_reason`):
```ts
// src/application/outbox.ts abandon (lines 268-278) — o mesmo vocabulário
await db.execute(sql`
  UPDATE ${outbox} SET status = 'abandoned', last_error = ${motivo} WHERE id = ${id}
`);
```

**Reconciliador (D-04c):** conversa em cadência sem `scheduled_tasks` pendente → recria (o `enqueue` com a mesma chave é no-op); `scheduled_tasks` cujo job no `outbox` é terminal → fecha o ledger (`status='abandoned'` com motivo). Idempotência exige índice único parcial `(conversation_id, follow_up_index) WHERE status='pending'` — **`follow_up_index` NÃO existe em `scheduled_tasks`** (só em `conversations`, `schema.ts:169`); a migração 0007 adiciona a coluna (RESEARCH Pattern 2).

**R-001 reforçado (D-08):** o scheduler só age sobre conversas **já em cadência** (`first_contact_by_human = true` já é pré-condição do gate — guard 0). O bot jamais inicia conversa.

---

### `src/application/catchup-drain.ts` (service, batch)

**Analog:** `src/application/outbox-worker.ts` `drainOnce` (reserva + resolve um job com dispatch reavaliando o gate) + `src/application/humanize.ts` (jitter determinístico).

**Reserva + decisão por resultado discriminado** (`outbox-worker.ts` lines 52-98, condensado):
```ts
const job = await reserveNext(db, { now: deps.now });
if (!job) return { drained: 0, sent: 0, blocked: 0, deferred: 0 };
const resultado = await dispatch({ db, channel, ctx }, { /* snapshot fresco */ });
switch (resultado.action) {
  case "sent":     /* dispatch já fechou o job */ break;
  case "blocked":  await abandon(db, job.id, resultado.reason); break;
  case "deferred": /* dispatch já chamou markDeferred */ break;
  case "silencio": await abandon(db, job.id, resultado.reason); break;  // fail-closed
}
```

**Jitter determinístico** (D-07; `humanize.ts` lines 76-86 — nunca `Math.random`):
```ts
export const humanDelayMs = (kind: HumanKind, seed: string): number => {
  const base = kind === "first"
    ? FIRST_MIN_MS + unitario(`first:${seed}`) * (FIRST_MAX_MS - FIRST_MIN_MS)
    : FOLLOWUP_MIN_MS + unitario(`followup:${seed}`) * (FOLLOWUP_MAX_MS - FOLLOWUP_MIN_MS);
  // ...
};
```
ADR-009 define `JITTER_MIN/MAX_MS = 3000/12000` para o catch-up (fora da faixa padrão do `humanize`; passar por config do drain). Travas de D-07: ≤3 envios nos primeiros 10 min; 1 follow-up/lead/dia de drenagem; FIFO por `scheduled_for`; excedente → `markDeferred` para `nextWindow(...)` (**adiar, nunca descartar** — `outbox.ts` lines 251-261). `isCatchupDrain` é **parâmetro booleano do boot**, não `settings`.

---

### `src/application/copilot.ts` (service, LLM→sugestão persistida)

**Analog:** `src/application/shadow.ts` — o copiloto (D-24) reusa exatamente o fluxo: gate sobre o texto gerado → INSERT `messages(origin='ai_suggestion', status='suggested')` → registro em `llm_runs`. **Nunca** importa o dispatcher para gravar sugestão (o `import` ausente é a invariante).

**Persistência do rascunho** (`shadow.ts` lines 197-210):
```ts
const inseridos = await tx.insert(messages).values({
  conversationId: input.conversationId,
  direction: "out",
  origin: "ai_suggestion",
  kind: "text",
  body: input.generatedText,
  status: "suggested",
  idempotencyKey: input.idempotencyKey,
  createdAt: agora,
}).onConflictDoNothing({ target: messages.idempotencyKey })
  .returning({ id: messages.id });
```

**Gate roda IGUAL em sugestão** (`shadow.ts` lines 151-193): L4 `scanPostGate` + `evaluatePolicy` sobre o snapshot fresco; bloqueio → `recordBlockedAttempt` (mesma trilha auditável). Envio da sugestão aceita é ação explícita do Admin e passa pelo **dispatcher** (`origin='admin'`) — nunca automático. Promoção de `suggested` é evento em `review_events`, nunca `UPDATE messages` (trigger append-only).

---

### `src/application/appointment.ts` (service, agendamento manual)

**Analog:** `src/application/outbox.ts` `enqueue` (confirmação/lembrete viram jobs gateados) + `src/application/handoff-service.ts` (remarcar/cancelar → handoff).

**Transação atômica com `FOR UPDATE` + idempotência** (`handoff-service.ts` lines 118-145, padrão a espelhar):
```ts
const resultado = await db.transaction(async (txBruto) => {
  const tx = txBruto as unknown as Db;
  const lido = await tx.execute(sql`
    select c.id, c.lead_id, ... from conversations c ...
    where c.id = ${input.conversationId} for update of c
  `);
  // Idempotência: já está em handoff → não duplica evento nem notificação.
  if (conv.handoff_active) return { disparado: false as const, handoffId: null, ... };
```

**Notificação fora da transação, try/catch** (`handoff-service.ts` lines 219-228): efeito de borda nunca desfaz o commit:
```ts
try {
  await deps.notifier?.notify({ title: ..., message: ..., urgent: true, sound: true });
} catch (erro) {
  log.error({ event: "handoff_notify_falhou", conversation_id: ... }, `... (ignorada)`);
}
```

Fluxo D-25: Admin registra agendamento no painel → `scheduled_tasks` tipo `confirmacao`/`lembrete` + `outbox(origin='bot')` → gate decide. Resposta do lead pedindo remarcar/cancelar → `dispararHandoff` (R-025/AR-003 — nunca agendar sozinho).

---

### `src/infra/db/queries/crm.ts` (query, CRUD server-side)

**Analog:** `src/infra/db/queries/status-history.ts` — o par *gravar* + *carregar* com limite clampado, snake_case→camelCase na mão:

```ts
// lines 54-79 — gravar (INSERT ... RETURNING id; id obrigatório para correlação)
export const recordStatusChange = async (db: Db, input: StatusChangeInput): Promise<string> => {
  const resultado = await db.execute(sql`
    insert into status_history (conversation_id, from_state, to_state, changed_by, reason, changed_at)
    values (${input.conversationId}, ${input.fromState}, ${input.toState},
            ${input.changedBy}, ${input.reason ?? null}, ${input.changedAt ?? new Date()})
    returning id
  `);
  // sem id → throw: transição sem auditoria é erro, não warning
};

// lines 87-94 — carregar com clamp (painel pede dezenas, não a tabela inteira)
const teto = Math.min(Math.max(Math.trunc(limit), 1), 200);
const resultado = await db.execute(sql`
  select ... from status_history where conversation_id = ${conversationId}
  order by changed_at desc, id desc limit ${teto}
`);
```

`lead_notes` é **append-only** (só INSERT, como `status_history` — sem trigger, por convenção da aplicação; ver nota em `status-history.ts` lines 10-18). Tags/notas/tarefas seguem Drizzle `sql` com bind params (nunca concatenação). Busca/filtros server-side e paginação por `LIMIT/OFFSET` com clamp (RESEARCH §Architectural Responsibility Map: D-22 exige server-side).

---

### `src/infra/db/queries/scheduler.ts` (query, seleção de candidatos)

**Analog:** `src/application/outbox.ts` `reserveNext` — a única referência de seleção transacional com lock:

```ts
// lines 137-165 — transação curta; lock só durante a reserva
return db.transaction(async (tx) => {
  const selecao = await tx.execute(sql`
    SELECT id, conversation_id, body, origin, idempotency_key, scheduled_for, attempts
    FROM ${outbox}
    WHERE status = 'pending' AND scheduled_for <= ${agora} ${filtroConversa}
    ORDER BY scheduled_for, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  `);
  // ...
  await tx.execute(sql`
    UPDATE ${outbox} SET status = 'reserved', reserved_at = now(), attempts = attempts + 1
    WHERE id = ${row.id}
  `);
});
```
O scheduler **não** reserva jobs do outbox (isso é do worker); mas o reconciliador usa o mesmo estilo de `SELECT` em `scheduled_tasks` pendentes (já indexado: `scheduled_tasks_pending_idx ON (scheduled_for, id) WHERE status='pending'`, `schema.ts:650-652`).

---

### `src/infra/db/migrations/0007_*.sql` (migration)

**Analog exato:** `src/infra/db/migrations/0006_shadow_and_llm_runs.sql` — inclui o padrão de **troca de CHECK** (DROP + ADD) e reuso de `fn_append_only`:

```sql
-- 0006 lines 26-35 — trocar CHECK exige DROP + ADD (padrão para pipeline_status)
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_engagement_mode_check";
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_engagement_mode_check"
  CHECK (engagement_mode IN ('bot_active', 'awaiting_human', 'human', 'copilot', 'pausado', 'shadow'));

-- 0006 lines 48-59 — append-only REUSANDO fn_append_only (não criar segunda função)
DROP TRIGGER IF EXISTS trg_llm_runs_append_only on llm_runs;
CREATE TRIGGER trg_llm_runs_append_only
  before update or delete on llm_runs
  for each row execute function fn_append_only();
REVOKE UPDATE, DELETE ON llm_runs FROM PUBLIC;
```

Conteúdo da 0007 (D-14/D-22 + RESEARCH Pattern 2): coluna `conversations.pipeline_status` (CHECK 9 valores, `DEFAULT 'novo'`); backfill derivado de `conversations.state`/`messages` como **task separada** (Pitfall 7 — `messages`/`status_history` são append-only: o backfill **lê**, não escreve neles); `scheduled_tasks.follow_up_index smallint NOT NULL DEFAULT 0` + índice único parcial `(conversation_id, follow_up_index) WHERE status='pending'`; tabelas `tags`, `lead_tags`, `lead_notes` (append-only por convenção), `tasks` (`responsible_user_id` nullable, R-028); `COMMENT ON TABLE` explicando o porquê (padrão 0006 lines 61-65). Se `lead_notes`/`tags` nascerem auditáveis, reusar `fn_append_only` + `REVOKE` como em 0006.

**Sincronia Drizzle:** a migração é gerada por `drizzle-kit generate` a partir do `schema.ts` modificado — manter os dois em sincronia (a 0006 mostra o formato emitido pelo kit: `--> statement-breakpoint`).

---

### `src/infra/db/schema.ts` (modificado) / `src/config/env.ts` (modificado) / `src/index.ts` (modificado)

Ambos seguem seus próprios padrões; deltas da Fase 3:

- **schema.ts:** adicionar `pipeline_status` em `conversations` (lines 155-201), coluna `follow_up_index` em `scheduledTasks` (lines 625-654), tabelas novas de CRM no estilo do Bloco 2 (CHECKs declarados com `sql`, índices parciais com predicado entre crases — ver nota lines 440-448: expressão `IS NULL` dentro de `.on()` é rejeitada; usar `.where(sql\`...\`)`).
- **env.ts:** `PANEL_TOKEN` (nunca em `settings` — D-18) e `PANEL_PORT`; validação zod como as demais chaves (RESEARCH: env validado por zod no boot).
- **index.ts:** ordem de boot inegociável (lines 1-12): config → banco (migrate) → logs → canal → motor. O scheduler e o Fastify entram no estágio "motor", com shutdown gracioso (lines 104-110 do outbox-worker: `AbortSignal`; kill abrupto durante `useMultiFileAuthState` corrompe a sessão). Padrão de handle parado no encerra (`index.ts` lines 86-88):
```ts
let monitorSaude: ReturnType<typeof startHealthMonitor> | undefined;
let cronRelatorio: Cron | undefined;
```

---

### `src/web/*` — SPA React + Vite + Tailwind (**SEM ANALOGO — codebase 100% backend**)

**Fato verificado:** glob por `**/*.{tsx,jsx,html,css}` no repositório retorna **zero arquivos**. Não existe `vite.config`, nem CSS, nem componente. O executor não tem o que copiar no codebase para UI — as fontes são:

1. **`03-UI-SPEC.md` §Component Inventory** (~25 componentes: `AppShell`, `HeaderBar`, `ModeIndicator`, `LeadList`, `ChatPanel`, `Composer`, `SuggestionCard`, `PipelineBoard`, `ConfirmDialog`, …) + §Interaction & State Contract (estados SSE, ciclo de vida da sugestão, tooltips de desabilitação) + §Accessibility.
2. **`docs/06-wireframes.md`** e **ADR-011** (layout 3 colunas, indicador de modo, kill switch).
3. **RESEARCH §Standard Stack** — versões pinadas: `react@19.3.1`, `vite@8.3.4`, `@vitejs/plugin-react@6.1.2`, `tailwindcss@4.3.3`, `@tailwindcss/vite@4.3.3`, `lucide-react@1.57.0`. **Tailwind v4 tem sintaxe diferente do v3** (`@import "tailwindcss";` no CSS + plugin Vite; sem `tailwind.config.js` + `content`) — **confirmar na doc oficial** (RESEARCH Open Question Q2/A1).

**Padrões de comportamento que a UI deve espelhar do backend:**
- Enviar mensagem → `POST /api/dispatch` que chama o **mesmo** `dispatch` do backend com `origin='admin'` — a UI nunca fala com o canal.
- Kill switch → mesma fonte de verdade `settings.operational_mode` do CLI `mode.ts` (ver §Shared: Kill Switch) — nunca estado paralelo em memória.
- Histórico imutável (D-23): `messages`/`status_history`/`handoff_events`/`blocked_attempts` são **read-only** na UI — os triggers `fn_append_only` derrubariam qualquer UPDATE, e a UI não deve sequer tentar.
- SSE: `EventSource` nativo (reconecta sozinho); re-sincronizar via `GET /api/*` ao reconectar (Pitfall 9); heartbeat `: ping` a cada ~15s do lado Fastify.
- XSS: React escapa por padrão; sanitizar `href` de links (R-042) — bloquear `javascript:`/`data:` (RESEARCH Security Domain).

---

## Shared Patterns

### Choke-point único de envio
**Source:** `src/application/dispatcher.ts` (todo o arquivo) · **Apply to:** rotas `/api/dispatch`, copiloto, appointment, scheduler
```ts
// dispatcher.ts lines 5-9 — o invariant é mecanico, nao um guard
// o conjunto de arquivos de produção que contêm `sendText(` tem de ser exatamente este
// (tests/lint/choke-point.grep.test.ts). Nenhum caminho novo.
```
Contrato de resultado (lines 58-70) — o scheduler/copiloto consomem o mesmo discriminated union:
```ts
export type DispatchResult =
  | { readonly action: "sent"; readonly messageId: string }
  | { readonly action: "blocked"; readonly reason: GateReason; readonly detail: string }
  | { readonly action: "deferred"; readonly scheduledFor: Date }
  | { readonly action: "silencio"; readonly reason: GateReason; readonly detail: string };
```
Nota: `outbox-worker.ts` chama `resultado.action` (não `.status`) — RESEARCH Open Question 1 respondida.

### Idempotência (três barreiras + chave de cadência)
**Source:** `src/application/outbox.ts` lines 21-27 · **Apply to:** scheduler, appointment, CRM writes
```sql
-- (1) outbox.idempotency_key UNIQUE + ON CONFLICT DO NOTHING impede re-enfileiramento
-- (2) FOR UPDATE SKIP LOCKED impede dois workers
-- (3) messages.idempotency_key UNIQUE impede a duplicata mesmo se as duas primeiras falharem
```
Chave canônica da Fase 3: `flup:{conversationId}:{index}` (D-05).

### Audit trail (append-only, INSERT + RETURNING)
**Source:** `src/infra/db/queries/status-history.ts` (gravar), migrações 0003/0004/0006 (triggers) · **Apply to:** pipeline transitions, CRM notes, cancelamentos
- `status_history`/`mode_changes`/`lead_notes`: append-only **por convenção da aplicação** (só INSERT; sem UPDATE/DELETE).
- `messages`/`event_log`/`llm_runs`/`review_events`/`optout_ledger`: append-only **no banco** (`fn_append_only` + `REVOKE`). `UPDATE messages` **levanta exceção** (RESEARCH Pitfall 4) — gravar já com status final, como `dispatch` faz (lines 277-293).

### Kill switch (mesma fonte de verdade, CLI + painel)
**Source:** `src/cli/mode.ts` · **Apply to:** rota do painel (D-20)
```ts
// mode.ts lines 63-71 — leitura (o snapshot faz o mesmo com #>> '{}')
const resultado = await db.execute(sql`
  select value #>> '{}' as v from settings where key = ${CHAVE_MODO_OPERACIONAL}
`);
return v === "paused" ? "paused" : "active";

// mode.ts lines 86-110 — gravarModo: settings + event_log NA MESMA transação
await db.transaction(async (tx) => {
  await tx.execute(sql`insert into settings (key, value, updated_at)
    values (${CHAVE_MODO_OPERACIONAL}, ${JSON.stringify(para)}::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`);
  await tx.execute(sql`insert into event_log (event_type, entity_type, payload, severity)
    values ('operational_mode_changed', 'settings', ${JSON.stringify({from: de, to: para, actor: "admin", reason: motivo, source: "cli"})}::jsonb, 'info')`);
});
```
O botão do painel troca `source: "cli"` por `source: "panel"`; o kill switch computado é `snapshot.ts` lines 185-188 (`not a.is_active OR operational_mode='paused'`).

### Settings jsonb (leitura escalar)
**Source:** `src/infra/db/queries/snapshot.ts` lines 185-192 · **Apply to:** `followup.max_touches`, `calendar.holidays`, kill switch
```sql
(not coalesce(a.is_active, false) or coalesce(s.value #>> '{}', '') = 'paused') as kill_switch
```
`value` é `jsonb` — comparar `= 'paused'` falha (`"paused"` com aspas). `#>> '{}'` extrai o escalar; `coalesce(..., '')` cobre ausência da chave (RESEARCH Pitfall 10). **Token do painel NUNCA em `settings`** (D-18 — settings é exibido no painel).

### Logger estruturado (childLogger, sem PII)
**Source:** todos os application modules · **Apply to:** scheduler, api, catchup-drain
```ts
// handoff-service.ts line 48 / event-bus.ts line 23
const log = childLogger("handoff");
// uso: log.info({ event: "handoff_idempotente", conversation_id: ... }, "texto");
```
Regra: **nunca** corpo de conversa nem payload LLM em log (RESEARCH §Logging) — só ids, contagens, motivos. O corpo vive em `messages`.

### Fail-closed
**Source:** `src/application/dispatcher.ts` lines 163-169 · **Apply to:** toda rota nova que chama LLM ou envio
```ts
if (!snapshot) {
  return { action: "silencio", reason: "erro_nao_mapeado", detail: ... };
  // nunca texto de fallback — um fallback seria mensagem não auditada
}
```

### Injeção de relógio (`now` obrigatório/injetável)
**Source:** `dispatcher.ts` line 99-100 ("o dispatcher **nunca** chama `Date.now()`"), `shadow.ts` line 58, `handoff-service.ts` line 74 · **Apply to:** scheduler, cadence, appointment
Toda função que depende de tempo recebe `now: Date` (ou `agora?: Date` com default) — determinismo de teste.

### Eventos → base do SSE
**Source:** `src/application/event-bus.ts` · **Apply to:** `src/api/sse.ts`
`BarramentoEventos` com canais `inbound|signal|clock`, handlers sequenciais por canal, falha grava em `event_log` **e repropaga** (nunca engolir exceção, lines 3-18). O SSE do painel subscreve os canais e faz push para o `EventSource` — o estado autoritativo continua no Postgres, o SSE é só *hint* de atualização (Pitfall 9).

### Transação + FK lida com `FOR UPDATE`
**Source:** `handoff-service.ts` lines 123-130 · **Apply to:** appointment, pipeline transitions concorrentes
```sql
select c.id, ... from conversations c join leads l on l.id = c.lead_id
where c.id = ${input.conversationId} for update of c
```
`FOR UPDATE OF c` trava só a conversa. Idempotência por estado lido (`handoff_active` → no-op).

### Testes
**Source:** `tests/domain/business-hours.test.ts`, `tests/application/outbox.test.ts`, `tests/application/outbox-worker-revalidation.test.ts` · **Apply to:** todos os testes novos
Estrutura: Vitest, um arquivo por módulo, domínio puro testado sem DB; application tests com DB de desenvolvimento (o desvio `reserveNext({conversationId})` existe para isolar jobs — `outbox.ts` lines 72-78). O choke-point grep test (`tests/lint/choke-point.grep.test.ts`) deve continuar verde após qualquer arquivo novo — **proibido** `sendText(` fora de `dispatcher.ts`.

---

## No Analog Found

| File | Role | Data Flow | Reason / Fallback |
|------|------|-----------|-------------------|
| `src/api/server.ts` | config/server | request-response | Primeira superfície HTTP do projeto. Skeleton verificado: RESEARCH §Pattern 4 (Host + Bearer no `onRequest`, bind literal `127.0.0.1`). Wiring de boot copiar de `src/index.ts`. |
| `src/api/auth.ts` | middleware | request-response | Sem analog. `crypto.timingSafeEqual` + token de `.env` (RESEARCH §Don't Hand-Roll). |
| `src/api/sse.ts` | middleware | streaming | Sem analog de transporte; fonte de eventos é `event-bus.ts`. Heartbeat + `id:` incremental (Pitfall 9). |
| `src/api/routes/*.ts` | controller | request-response | Sem analog de rotas. Validação: schemas Zod na borda (único vocabulário do projeto). Padrão de erro: status HTTP + `{ error }`, sem stack. |
| `src/web/**` (SPA inteira) | component | fetch + EventSource | **Codebase não tem nenhum frontend** (glob `*.tsx/jsx/html/css` = 0). Fontes: `03-UI-SPEC.md` + `docs/06-wireframes.md` + ADR-011 + versões do RESEARCH §Standard Stack. |
| `vite.config.ts` + Tailwind v4 CSS entry | config/build | — | Sem analog. **Tailwind v4 ≠ v3**: `@import "tailwindcss";` + `@tailwindcss/vite` (RESEARCH A1/Q2 — confirmar na doc oficial). |

---

## Metadata

**Analog search scope:** `src/application/`, `src/domain/`, `src/infra/`, `src/cli/`, `src/infra/db/migrations/`, `tests/`, glob global por frontend.
**Files scanned:** ~60 de `src/` + 55 de `tests/` (índice); 12 arquivos lidos integralmente para extração de excerpts.
**Pattern extraction date:** 2026-10-15
**Excerpt source integrity:** todos os excerpts vêm de leitura direta dos arquivos citados (linhas indicadas); nenhuma excerpt reescrita.
