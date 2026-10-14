---
phase: 02-ia-handoff-e-shadow-mode
plan: 02
subsystem: application
tags: [handoff, opt-out, lgpd, postgres, drizzle, fsm, notifications, shadow, pt-br]

# Dependency graph
requires:
  - phase: 02-ia-handoff-e-shadow-mode
    provides: "Sanduíche de 3 camadas (extração/decisão/geração), FSM `resolveNextState`, `LlmPort` + adaptador scripted, persistência de rascunho em shadow, envelope Zod com `qualification` e canário"
provides:
  - "Handoff atômico e idempotente (`dispararHandoff`): handoff_events + mode_changes + engagement_mode/state + status_history numa transação única"
  - "Matcher determinístico pt-BR de opt-out (autoridade D-14): FORTE → opt_out irreversível + ledger; AMBIGUO → handoff; NAO → fluxo normal"
  - "Qualificação acumulativa auditável (`updateQualification`): verba && decisao → aquecido"
  - "`status_history` append-only com changed_by/reason em toda transição (R-022/CRM-02)"
  - "Corpus adversário pt-BR reusável pelo 02-03 (opt-out, pressão de preço, injeção de prompt, mídia)"
affects: [02-03, 03, 04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Handoff em transação única com guard `handoff_active` + `FOR UPDATE OF c` (idempotência)"
    - "Matcher determinístico como AUTORIDADE; sinal da LLM só reforça (nunca desbloqueia)"
    - "Qualificação jsonb acumulativa (novo valor conhecido vence; desconhecido não rebaixa)"
    - "Notificação best-effort fora da transação (try/catch; nunca arranca o handoff já commitado)"
    - "Transação revertida por sentinela com savepoint aninhado (harness de teste DB)"

key-files:
  created:
    - src/domain/optout/optout-matcher.ts
    - src/application/handoff-service.ts
    - src/infra/db/queries/status-history.ts
    - src/infra/db/queries/leads.ts
    - tests/domain/optout-matcher.test.ts
    - tests/application/handoff-service.test.ts
    - tests/application/qualification.test.ts
  modified:
    - src/application/inbound-handler.ts
    - tests/adversarial/corpus.ts
    - tests/application/shadow.test.ts

key-decisions:
  - "Matcher roda ANTES da Camada 1 (não 'após', como no texto do plano): opt-out tem de ser honrado mesmo com a LLM fora do ar (fail-closed R-024) e ainda economiza tokens"
  - "dispararHandoff grava status_history internamente; falha ao gravar não é engolida (auditoria é parte da atomicidade)"
  - "status_history é append-only por CONVENÇÃO da aplicação (sem trigger/REVOKE; nenhuma DDL fora de escopo)"
  - "authority do opt-out: LLM (pedido_optout) só reforça; só o matcher escreve leads.opt_out"
  - "optout_ledger é chaveado por lead_id (prova do titular), não por conversa"
  - "transitions.ts NÃO foi alterado: a extensão ctx.qualification→aquecido já veio do 02-01"

patterns-established:
  - "Handoff único: mídia e texto usam o MESMO `dispararHandoff` (sem caminho paralelo de metade das escritas)"
  - "Fiação do handler: guardas locais → matcher → Camada 1 → merge qualification → Camada 2 (resolveNextState) → handoff OU Camada 3 → persistDraft"
  - "Auditoria de transição: UPDATE de state sempre acompanhado de recordStatusChange quando o estado muda"

requirements-completed: [CONV-06, CONV-09, CONV-10, CONV-12, FLUP-04, FLUP-05, FLUP-07, FLUP-09, FLUP-10, COMP-01, NFRQ-03]

# Metrics
duration: ~30min
completed: 2026-10-14
---

# Phase 2 Plan 02: Handoff Atômico, Opt-out Irreversível e Qualificação Auditável Summary

**Handoff atômico com silêncio total, matcher pt-BR de opt-out irreversível (FORTE → opt_out + ledger; AMBIGUO → handoff) e qualificação acumulativa auditável em `status_history`.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-10-14T07:33:00-03:00 (commit RED do Task 1)
- **Completed:** 2026-10-14T07:55:00-03:00
- **Tasks:** 3
- **Files modified:** 10 (7 criados, 3 modificados)

## Accomplishments

- **Handoff atômico e idempotente** — `dispararHandoff` grava `handoff_events` + `mode_changes` + `conversations.engagement_mode='awaiting_human'`/`handoff_active=true`/`state` + `status_history` numa ÚNICA `db.transaction`. Falha no meio reverte tudo (teste força erro no 2º INSERT e exige `handoff_events` = 0). Repetir o gatilho não duplica evento nem notificação.
- **Silêncio total + notificação local** — após handoff, zero linhas outbound `sent`; a notificação carrega lead + motivo + ação (`npm run handoff:ack <id>`) com `urgent=true`, e um `notify` que lança NÃO desfaz o handoff commitado.
- **Matcher pt-BR é a autoridade do opt-out (D-14)** — `classifyOptout` (FORTE/AMBIGUO/NAO) roda antes da LLM: FORTE → `applyOptOut` (opt_out + ledger atômicos) + handoff; AMBIGUO → handoff; NAO → fluxo. A LLM nunca escreve opt-out sozinha.
- **Qualificação auditável** — `updateQualification` mescla de forma acumulativa; `verba=2 && decisao=2` → estado `aquecido` no mesmo turno; `objecao_preco` gera contorno sem handoff.
- **`status_history` completa** — toda transição (bot e admin) grava `changed_by` e `reason` não vazios.
- **Mídia aciona o handoff de forma única** — `registrarMidiaRecebida` passou a usar o mesmo `dispararHandoff` (sem INSERT paralelo de `handoff_events`).

## Task Commits

1. **Task 1: matcher pt-BR de opt-out (TDD)** — `cac69bf` (test, RED) → `da0a77b` (feat, GREEN)
2. **Task 2: handoff atômico + status_history + leads** — `2fd37d8` (feat)
3. **Task 3: opt-out irreversível + qualificação auditável + fiação** — `1f13ecf` (feat)

**Plan metadata:** `[hash final]` (docs: complete plan)

## Files Created/Modified

- `src/domain/optout/optout-matcher.ts` — autoridade determinística pt-BR: `FORTE_TERM`/`AMBIGUO_TERM` + `classifyOptout` (`OptoutClass`)
- `src/application/handoff-service.ts` — `dispararHandoff` (transação única, idempotência, notificação best-effort) + `HandoffTriggeredBy`
- `src/infra/db/queries/status-history.ts` — `recordStatusChange` (INSERT append) + `loadStatusHistory`
- `src/infra/db/queries/leads.ts` — `applyOptOut` (opt_out + `optout_ledger` atômicos) e `updateQualification` (merge acumulativo)
- `src/application/inbound-handler.ts` — fiação: matcher antes da LLM, merge de qualificação, `status_history` nas transições bot/admin, mídia via `dispararHandoff`
- `tests/domain/optout-matcher.test.ts` — matriz FORTE/AMBIGUO/NAO, acento/caixa, anti-padrão "não quero perder tempo"
- `tests/application/handoff-service.test.ts` — atomicidade, rollback, idempotência, silêncio, FLUP-05, notify que lança
- `tests/application/qualification.test.ts` — verba+decisao→aquecido, acumulação, objecao_preco sem handoff, opt-out FORTE irreversível, status_history
- `tests/adversarial/corpus.ts` — corpus adversário (optoutForte, optoutAmbiguo, pressaoPreco, injecaoPrompt, midia)
- `tests/application/shadow.test.ts` — asserção de handoff atualizada do stub para `handoff_events`

## Decisions Made

- **Matcher antes da Camada 1** (refinamento sobre o texto do plano, que diz "após a Camada 1"): honra R-024 mesmo com a LLM indisponível e evita gastar tokens em quem já pediu para sair.
- **`transitions.ts` não alterado**: `ctx.qualification` + regra `verba && decisao → aquecido` já entregues pelo 02-01.
- **`optout_ledger` por `lead_id`**: a prova LGPD pertence ao titular, não à conversa.
- **`status_history` append-only por convenção**: sem trigger/REVOKE; nenhuma DDL fora de `files_modified`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Fronteira de segurança] Matcher de opt-out movido para ANTES da Camada 1**
- **Found during:** Task 3 (fiação do handler)
- **Issue:** O plano (linha 220) diz "após a Camada 1, aplicar `classifyOptout`". Rodar depois da extração deixa um opt-out explícito invisível quando a LLM está fora do ar — exatamente o modo de falha que R-024/AR-005 proíbem.
- **Fix:** `classifyOptout` roda no topo de `rascunharShadow`, logo após as guardas locais e antes de qualquer chamada à LLM.
- **Files modified:** `src/application/inbound-handler.ts`
- **Verification:** `tests/application/qualification.test.ts` prova `chamadas === []` no opt-out FORTE.
- **Committed in:** `1f13ecf`

**2. [Rule 1 - Bug] Teste de shadow assertava o stub removido**
- **Found during:** Task 2 (substituição do stub pelo handoff real)
- **Issue:** `tests/application/shadow.test.ts` contava `event_log` com `event_type='handoff_stub'`, que o 02-02 removeu — o teste passaria a falhar e não cobria mais o caminho de handoff.
- **Fix:** asserção passou a contar `handoff_events` (a linha real, append-only).
- **Files modified:** `tests/application/shadow.test.ts`
- **Verification:** `npx vitest run tests/application/shadow.test.ts` verde.
- **Committed in:** `2fd37d8`

**3. [Rule 3 - Bloqueio] `transitions.ts` listado em `files_modified` mas sem mudança necessária**
- **Found during:** Task 3
- **Issue:** O plano lista `src/domain/orchestrator/transitions.ts`, mas a extensão `ctx.qualification` já estava presente do 02-01.
- **Fix:** nenhuma alteração; verificado por leitura do FSM.
- **Files modified:** nenhum
- **Verification:** `resolveNextState(prev, hint, { qualification })` já retorna `aquecido`.

---

**Total deviations:** 3 (1 Rule 1, 1 Rule 2, 1 Rule 3)
**Impact on plan:** Todas necessárias para correção/segurança. Sem scope creep; nenhuma dependência nova (T-02-SC: accept).

## TDD Gate Compliance

Task 1 seguiu RED → GREEN no git log: `cac69bf` (test) precede `da0a77b` (feat). Nenhum `refactor` necessário.

## Issues Encountered

- O erro do trigger de irreversibilidade (`fn_opt_out_irreversible`) chega embrulhado pelo drizzle: a mensagem do Postgres vive em `error.cause`. O teste desembrulha ambas as mensagens antes de casar o texto.

## Known Stubs

None — nenhum placeholder, dados mockados ou valor vazio fluindo para renderização.

## Threat Flags

None — nenhuma superfície nova fora do `<threat_model>` do plano (as mitigações T-02-07 a T-02-12 foram implementadas como descrito).

## User Setup Required

None — nenhuma configuração de serviço externo.

## Next Phase Readiness

- **02-03 pronto para consumir**: `recordStatusChange`/`loadStatusHistory` (CLI `status:corrigir`, CRM-02), `dispararHandoff`/`handoffId` (CLI `handoff:ack`), e o corpus adversário (`tests/adversarial/corpus.ts`) para o harness de bake-off.
- **Suíte completa verde**: 41 arquivos / 206 testes; `npm run typecheck` limpo.
- Sem blockers.

---
*Phase: 02-ia-handoff-e-shadow-mode*
*Completed: 2026-10-14*

## Self-Check: PASSED

- FOUND: src/domain/optout/optout-matcher.ts
- FOUND: src/application/handoff-service.ts
- FOUND: src/infra/db/queries/status-history.ts
- FOUND: src/infra/db/queries/leads.ts
- FOUND: tests/domain/optout-matcher.test.ts
- FOUND: tests/application/handoff-service.test.ts
- FOUND: tests/application/qualification.test.ts
- FOUND commit: cac69bf (test RED — matcher)
- FOUND commit: da0a77b (feat GREEN — matcher)
- FOUND commit: 2fd37d8 (feat — handoff + status_history + leads)
- FOUND commit: 1f13ecf (feat — opt-out/qualificação/fiação)
