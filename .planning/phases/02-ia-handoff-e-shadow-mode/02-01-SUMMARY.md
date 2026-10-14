---
phase: 02-ia-handoff-e-shadow-mode
plan: 01
subsystem: ai-llm
tags: [llm, ai-sdk, zod, fsm, pii-masking, shadow, postgres, drizzle]

# Dependency graph
requires:
  - phase: 01-funda-o-canal-e-gate-de-envio
    provides: "evaluatePolicy (PolicyGate), snapshot do gate, dispatcher (choke-point único de sendText), outbox durável, migrações 0001-0005, openDb/migrate()"
provides:
  - "LlmPort trocável com dois tiers (extract/generate) + adapters scripted (offline) e ai-sdk"
  - "FSM pura resolveNextState + mapa ALLOWED (9 estados do CHECK)"
  - "Envelope Zod da Camada 1/3 com campo-canário"
  - "prompt-builder.ts como choke-point único de mascaramento de PII (telefone + endereço; nome mantido)"
  - "shadow.ts: rascunho append-only em messages(origin='ai_suggestion', status='suggested')"
  - "Tabelas append-only llm_runs / review_events + queries de contexto e de execução"
  - "Migração 0006: CHECK de engagement_mode aceita 'shadow'"
affects: [02-02, 02-03]

# Tech tracking
tech-stack:
  added: ["ai@7.0.138", "@ai-sdk/openai@4.0.92", "@ai-sdk/anthropic@4.0.79", "@ai-sdk/google@4.0.94"]
  patterns:
    - "LLM dá hint, código é autoridade: resolveNextState decide, a hint só é aceita se constar em ALLOWED[prev]"
    - "Sanduíche de 3 camadas: extração (modelo barato) → decisão de código → geração (modelo forte)"
    - "Choke-point único de mascaramento de PII no prompt-builder (todo egresso passa por maskPii)"
    - "Rascunho append-only em messages; nenhuma promoção por UPDATE (evento em review_events)"
    - "Falha-fechada: 1 reprompt → silêncio + notificação local; nunca texto livre"

key-files:
  created:
    - src/domain/ports/LlmPort.ts
    - src/domain/llm/envelope.ts
    - src/domain/llm/prompt-builder.ts
    - src/infra/llm/scripted-adapter.ts
    - src/infra/llm/ai-sdk-adapter.ts
    - src/application/shadow.ts
    - src/infra/db/queries/llm-runs.ts
    - src/infra/db/queries/review-events.ts
    - src/infra/db/queries/llm-context.ts
    - src/infra/db/migrations/0006_shadow_and_llm_runs.sql
  modified:
    - src/domain/orchestrator/transitions.ts
    - src/application/inbound-handler.ts
    - src/infra/db/schema.ts
    - src/infra/db/queries/snapshot.ts
    - src/domain/gate/types.ts

key-decisions:
  - "Provider/modelo é injetado no adapter (resultado do bake-off do 02-03), nunca hard-coded"
  - "shadow.ts NÃO importa o dispatcher e não contém sendText( — barreira mecânica por grep mantém o choke-point único do 01-04"
  - "llm_runs guarda apenas metadados (modelo/tokens/latência/versões); nunca o corpo do prompt (R-045)"
  - "promoção do rascunho é evento append-only (review_events), não UPDATE em messages.status (D-15)"
  - "CONV-01/R-002 fiado no passo (d): fromMe do número dedicado chama resolveNextState(..., {adminPrimeiraMensagem:true}) → novo → aquecimento"

patterns-established:
  - "Porta pura de LLM (sem import de 'ai'/SDK) — espelha NotifyPort/LeadSourcePort"
  - "Adapter scripted determinístico como default dos testes (fase roda sem chave de API)"
  - "Falha-fechada do adapter: erro tipado + NotifyPort, nunca fallback para texto livre"

requirements-completed: [OPRE-04, OPRE-05, LEAD-05, LEAD-06, CONV-01, CONV-02, CONV-03, CONV-04, CONV-05, CONV-08]

# Metrics
duration: interrompido em 2026-10-13, retomado e fechado em 2026-10-14
completed: 2026-10-14
---

# Phase 02: IA, Handoff e Shadow Mode — Plan 01 Summary

**Primeira fatia vertical da LLM: inbound de texto → extração (Zod + canário) → decisão de código (resolveNextState) → geração mascarada → rascunho append-only em shadow, sem jamais chamar o dispatcher.**

## Performance

- **Duration:** sessão inicial 2026-10-13 (~15:42–15:48), retomada e fechada em 2026-10-14 a partir das 07:07
- **Started:** 2026-10-13T15:42:42-03:00
- **Completed:** 2026-10-14
- **Tasks:** 3
- **Files modified:** 24 (13 novos, incluindo migração e meta)

## Accomplishments
- `LlmPort` com dois tiers (`extract`/`generate`) e dois adapters: `scriptedLlmAdapter` (offline, determinístico) e `criarAiSdkAdapter` (`ai@7` + `Output.object`).
- FSM pura `resolveNextState(prev, hint, ctx)` com `ALLOWED` cobrindo exatamente os 9 estados do CHECK; as guardas locais (opt-out, handoff, adminPrimeiraMensagem, verba && decisão) vencem qualquer hint.
- Envelope Zod da extração e da geração com campo-canário e enum que separa `pedido_preco` (→ handoff, AR-001) de `objecao_preco` (→ contorno, R-042).
- `maskPii` no `prompt-builder.ts` cobre contexto + histórico + última mensagem + 1ª mensagem do Admin, mantendo o nome do lead.
- `persistDraft` grava o rascunho em `messages(origin='ai_suggestion', status='suggested')` + linha em `llm_runs` numa transação; bloqueio do gate → `recordBlockedAttempt` sem gravar rascunho.
- Migração `0006` destrava `engagement_mode='shadow'` (CHECKs de `conversations` e `mode_changes`) e cria `llm_runs`/`review_events` append-only (`fn_append_only` + `REVOKE`).
- Fiação ponta-a-ponta no `inbound-handler` (Camadas 1/2/3) com falha-fechada; transição do Admin (CONV-01/R-002) no passo (d).

## Task Commits

Each task was committed atomically:

1. **Task 1: Contratos da LLM + migração 0006 + sincronização de tipos** - `77777fc` (feat)
2. **Task 2: FSM pura + envelope Zod (canário) + choke-point de PII** - `8044c47` (test, RED) → `b90667a` (feat, GREEN)
3. **Task 3: Adaptadores + persistência em shadow + fiação do inbound** - `5bf5434` (feat)

**Plan metadata:** `(docs: complete plan)` — commit de fechamento do plano

_Note: Task 2 é `tdd="true"` — dois commits (RED → GREEN)._

## Files Created/Modified
- `src/domain/ports/LlmPort.ts` - Contrato puro de LLM (extract/generate), sem import de SDK
- `src/domain/orchestrator/transitions.ts` - FSM pura: `ALLOWED` + `resolveNextState`
- `src/domain/llm/envelope.ts` - Schemas Zod (extração/geração) + campo-canário + enum de intenção
- `src/domain/llm/prompt-builder.ts` - Choke-point único de mascaramento de PII e montagem de prompt
- `src/infra/llm/scripted-adapter.ts` - Adapter determinístico offline (default dos testes)
- `src/infra/llm/ai-sdk-adapter.ts` - Adapter `ai@7` com `Output.object` + falha-fechada
- `src/application/shadow.ts` - `persistDraft` (append-only, não importa dispatcher)
- `src/infra/db/queries/llm-runs.ts` - `recordLlmRun` / `loadLlmRuns` (só metadados)
- `src/infra/db/queries/review-events.ts` - `recordReviewEvent` / `loadReviewEvents` (usados no 02-03)
- `src/infra/db/queries/llm-context.ts` - `loadLlmContext` (histórico + 1ª msg do Admin + estado)
- `src/infra/db/migrations/0006_shadow_and_llm_runs.sql` - CHECK `'shadow'` + tabelas append-only
- `src/application/inbound-handler.ts` - Fiação das Camadas 1/2/3 + transição do Admin
- `src/infra/db/schema.ts` - Tabelas `llmRuns`/`reviewEvents` + CHECKs com `'shadow'`
- `src/infra/db/queries/snapshot.ts` - `MODOS`/`paraModo` reconhecem `'shadow'`; leitura de `operational_mode`
- `src/domain/gate/types.ts` - `engagementMode` inclui `'shadow'`

## Decisions Made
- Rascunho vive em `messages` (append-only) com `review_events` como trilha da decisão — a flag global `settings.shadowMode` do ADR-010 fica superseded (Pitfall 3).
- Adapter resolvido por injeção; provider/modelo são resultado do bake-off (02-03) — nada hard-coded.
- `llm_runs` só metadados; nunca corpo de prompt/transcript (R-045 + redact do logger).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Correção de formatação/ordem de imports (biome) ao fechar o plano**
- **Found during:** Fechamento do plano 02-01 (retomada 2026-10-14)
- **Issue:** A sessão anterior foi interrompida antes do commit/close-out; a árvore de trabalho tinha 11 erros `biome` fixáveis (organizeImports + format) em arquivos das Tasks 2/3, incluindo `tests/db/shadow-mode-migration.test.ts` (Task 1) não formatado.
- **Fix:** `npx biome check --write` nos arquivos afetados; `npm run lint` → 0 errors.
- **Files modified:** src/application/inbound-handler.ts, src/application/shadow.ts, src/infra/llm/ai-sdk-adapter.ts, src/infra/llm/scripted-adapter.ts, src/infra/db/queries/llm-context.ts, src/infra/db/queries/llm-runs.ts, src/infra/db/queries/review-events.ts, tests/application/shadow.test.ts, tests/db/shadow-mode-migration.test.ts
- **Verification:** `npm run lint` (0 errors), `npm run typecheck` limpo, `npm test` 38 arquivos / 182 testes verdes
- **Committed in:** `5bf5434`

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Sem desvio funcional — apenas formatação/ordenação de imports para satisfazer o gate de lint. Nenhum scope creep.

## Issues Encountered
- A sessão de execução original foi interrompida durante a Task 3 (sem SUMMARY.md, sem commit). Recuperação escolhida: fechar manualmente (lint → commit da Task 3 → SUMMARY → tracking), preservando o trabalho que já passava em typecheck e testes.

## User Setup Required
None - no external service configuration required. A fase roda inteira no `ScriptedLlmAdapter`; `LLM_API_KEY` só é necessária quando o provider real for escolhido no bake-off (02-03).

## Next Phase Readiness
- `LlmPort` trocável, FSM e mascaramento prontos para o 02-02 consumir (handoff + silêncio + opt-out).
- `review_events` e o stub de handoff no inbound são o gancho onde o `HandoffService` (02-02) se conecta (quita P-006).
- Nenhum envio real no caminho shadow — o número dedicado não é consumido (gate de P-004/01-03 permanece separado).

---
*Phase: 02-ia-handoff-e-shadow-mode*
*Completed: 2026-10-14*
