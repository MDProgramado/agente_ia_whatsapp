---
phase: 03-cadencia-operacao-e-painel
plan: "05"
subsystem: api
tags: [crm, pipeline, copilot, llm, scheduling, drizzle, fastify, zod, baileys]

requires:
  - phase: 03-cadencia-operacao-e-painel
    plan: "03"
    provides: dispatch/outbox (enqueue idempotente), gate de envio, BarramentoEventos e PanelCore
  - phase: 03-cadencia-operacao-e-painel
    plan: "04"
    provides: painel SPA (status history, ações de conversa) consumindo /api/*
  - phase: 02-conducao-ia-sombra
    provides: persistDraft, loadLlmContext, recordLlmRun, LlmPort, scanPostGate, business-hours (nextWindow)

provides:
  - "Pipeline de 9 status + closed_reason + tags/lead_tags/lead_notes/tasks (migração 0008) e queries do CRM"
  - "API do CRM: busca server-side, correção de status auditada, tags, notas, tarefas, responsável"
  - "Copiloto: sugestão como rascunho ai_suggestion + nota automática (lead_notes author_type='ia')"
  - "Agendamento manual de reunião: confirmação/lembrete normalizados para janela (R-006) e cota (R-023), com ledger durável"
  - "Resposta do lead (confirmar vs remarcar/cancelar) tratada sem o bot negociar — remarcar/cancelar = handoff (R-025)"

affects:
  - 03-cadencia-operacao-e-painel (06+ / remainder da fase)
  - painel (SPA consome /api/crm/*)
  - fase futura de relatórios (status_history/pipeline_status como fonte)

tech-stack:
  added: []
  patterns:
    - "Rota fina sobre queries de domínio: borda valida com Zod, mapeia erro de domínio para HTTP, nunca escreve regra de negócio"
    - "Instantes lidos de `sql` cru via `extract(epoch ...)` — imune ao fuso da sessão do PostgreSQL"
    - "Fail-closed para LLM: canário divergente / falha de provider / texto vazio → evento + silêncio, nunca rascunho inventado"
    - "Ledger durável (scheduled_tasks) + outbox idempotente: reexecução devolve duplicado, nunca dobra a mensagem"

key-files:
  created:
    - src/api/routes/crm.ts
    - src/application/copilot.ts
    - src/application/appointment.ts
    - tests/api/crm.test.ts
    - tests/application/appointment.test.ts
    - tests/application/copilot.test.ts
    - src/infra/db/migrations/0008_pipeline_crm.sql
  modified:
    - src/infra/db/schema.ts
    - src/domain/pipeline.ts
    - src/infra/db/queries/crm.ts
    - src/domain/llm/prompt-builder.ts
    - src/api/routes/conversations.ts
    - src/api/server.ts
    - src/index.ts
    - tests/domain/pipeline.test.ts

key-decisions:
  - "Pipeline com 9 status (novo..perdido) + closed_reason obrigatório nos status críticos (reuniao_agendada/proposta/fechado/perdido)"
  - "Agendamento é 100% manual (D-25): o bot nunca decide horário; data inválida é 400 na borda"
  - "Confirmação/lembrete usam índices reservados 100/101 em scheduled_tasks, fora da faixa 0..5 dos follow-ups"
  - "remarcar/cancelar nunca é respondido pelo bot — pendências abandonadas + handoff com excerpt (R-025)"
  - "PanelCore.llm opcional: rota de copiloto responde 503 sem porta de LLM (testes de borda), produção injeta a real"

patterns-established:
  - "Leitura de timestamp sem fuso em JS via epoch: `extract(epoch from col) as epoca` + `new Date(Number(epoca) * 1000)`"
  - "Normalização dupla janela+cota no agendamento (não só no envio): o outbox respeita, mas o horário já nasce válido"
  - "Nota automática exige as 3 seções — ausência é fail-closed (evento nota_ia_invalida, nenhuma nota gravada)"

requirements-completed: [FLUP-06, FLUP-08, CRM-01, CRM-03]

duration: 1h 44m
completed: 2026-10-20
---

# Phase 3 Plan 5: Backend do CRM operacional Summary

**Pipeline de 9 status com auditoria, copiloto (sugestão-rascunho + nota da IA) e agendamento manual de reunião com confirmação/lembrete normalizados para a janela e a cota — remarcar/cancelar vira handoff, nunca resposta do bot**

## Performance

- **Duration:** 1h 44m
- **Started:** 2026-10-20T11:27:46-03:00
- **Completed:** 2026-10-20T13:11:50Z
- **Tasks:** 2
- **Files modified:** 15 (+ 2 de wiring: `src/api/server.ts`, `src/index.ts`)

## Accomplishments
- Migração 0008 e domínio do funil: `pipeline_status` (9 valores, CHECK), `closed_reason` (CHECK), `tags`/`lead_tags`/`lead_notes`/`tasks`; `src/domain/pipeline.ts` com `transicaoValida`, `exigeJustificativa`, `isMotivo` e `crm.ts` (queries) — aplicada e verificada no banco vivo
- API do CRM (16 rotas): busca server-side por status/tag, correção de status com `status_history` + `event_log` na mesma transação, opt-out → 409, motivo fora de D-15 → 400, CRUD de tags + vínculo com lead, notas (admin), tarefas, responsável
- Copiloto: `gerarSugestao` persiste rascunho (`ai_suggestion`/`suggested`) via `persistDraft` (gate + canário aplicados) e `gerarNotaAutomatica` grava `lead_notes(author_type='ia')` só quando as três seções existem; ambos fail-closed
- Agendamento manual: `agendarConfirmacao` normaliza janela (R-006) e cota (R-023), grava ledger `scheduled_tasks` (índices 100/101) e enfileira no outbox com chave idempotente; `tratarRespostaAgendamento` encerra pendências no confirmar e dispara handoff no remarcar/cancelar (R-025)
- 3 suítes novas (31 testes) + 15 testes de domínio; suíte completa 416/416 verde

## Task Commits

Each task was committed atomically:

1. **Task 1: Migração 0008, domínio do funil e queries do CRM** - `e696b1a` (feat)
2. **Task 2: Copiloto, nota IA, agendamento e rotas do CRM** - `7357b19` (feat)

**Plan metadata:** (docs: complete plan) — commit final deste plano

## Files Created/Modified
- `src/infra/db/schema.ts` - `pipelineStatus` (9 valores) + `closedReason` + tabelas `tags`/`leadTags`/`leadNotes`/`tasks`
- `src/infra/db/migrations/0008_pipeline_crm.sql` + `meta/_journal.json` + `meta/0008_snapshot.json` - migração do funil
- `src/domain/pipeline.ts` - constantes e predicados do pipeline (D-14/D-15)
- `src/infra/db/queries/crm.ts` - busca, `corrigirStatus` (lock + opt-out + histórico), tags, notas, tarefas, responsável
- `src/application/copilot.ts` - `gerarSugestao`, `gerarNotaAutomatica` (fail-closed, canário, eventos)
- `src/application/appointment.ts` - `agendarConfirmacao`, `tratarRespostaAgendamento` (janela/cota/ledger/handoff)
- `src/domain/llm/prompt-builder.ts` - `buildNotePrompt` + `NOTA_PROMPT_VERSION = "03-05"`
- `src/api/routes/crm.ts` - 16 rotas do CRM (borda Zod + mapeamento de erro)
- `src/api/routes/conversations.ts` - detalhe com `pipelineStatus`/`closedReason`; rotas de agendamento e resposta
- `src/api/server.ts`, `src/index.ts` - `PanelCore.llm` opcional + wiring da porta de LLM de produção (deviation)
- `tests/domain/pipeline.test.ts`, `tests/application/copilot.test.ts`, `tests/application/appointment.test.ts`, `tests/api/crm.test.ts`

## Decisions Made
- **Status críticos exigem justificativa** tanto na borda (Zod, 400) quanto em `corrigirStatus` — erro de borda vira 400 com mensagem clara, não 409 de domínio depois de abrir transação
- **`changed_by='admin'` fixo** nas correções vindas do painel: um request capturado não pode se passar por automação
- **Índices 100/101 reservados** em `scheduled_tasks` para confirmação/lembrete, deliberadamente fora da faixa 0..5 dos follow-ups (a UNIQUE parcial garante uma linha pendente por tipo)
- **Primeiro agendamento vence**: reexecução com o mesmo horário devolve `duplicado: true`; pendência já vencida é encerrada para permitir registrar a próxima reunião
- **`extract(epoch ...)` para ler instantes** de `sql` cru (o `execute` do Drizzle não aplica o mapper da coluna `timestamp` — devolve texto)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Triggers/REVOKE de append-only na migração 0008**
- **Found during:** Task 1
- **Issue:** Novas tabelas de auditoria (`lead_notes`, `tasks`, histórico de pipeline) entram no escopo de R-043/R-022; sem REVOKE/trigger, uma mutação silenciosa não deixaria rastro
- **Fix:** migração 0008 inclui os triggers/REVOKE de imutabilidade consistentes com as tabelas append-only da fase 2
- **Files modified:** `src/infra/db/migrations/0008_pipeline_crm.sql`
- **Verification:** migração aplicada no banco vivo; suíte de domínio/PK verde
- **Committed in:** `e696b1a`

**2. [Rule 2 - Blocking] Wiring de `PanelCore.llm` em `src/api/server.ts` e `src/index.ts`**
- **Found during:** Task 2
- **Issue:** `files_modified` do PLAN não incluía `server.ts`/`index.ts`, mas a rota de copiloto precisa de uma porta de geração LLM no core; sem o campo opcional, `montarCore` dos testes não compila e a produção não injeta a porta real
- **Fix:** `PanelCore.llm?: LlmPort<...>` opcional (rota responde 503 quando ausente) + `registrarCrm(app, core)` após `registrarConversations`; `corePainel` em `index.ts` recebe `llm: llmProducao`
- **Files modified:** `src/api/server.ts`, `src/index.ts`
- **Verification:** typecheck verde; teste de copiloto 503 (sem llm) e teste de borda do CRM com roteiro scripted passam
- **Committed in:** `7357b19`

**3. [Rule 1 - Bug] `Intl.DateTimeFormat.format` recebia string em vez de `Date`**
- **Found during:** Task 2 (testes de agendamento, `RangeError: Invalid time value`)
- **Issue:** `ocupacaoDoDia`/`lerPendente`/`gravarPendente` liam `scheduled_for` via `sql` cru; o `execute` do Drizzle devolve timestamps como texto (`"2026-10-01 10:00:00-03"`), e `Intl.format(texto)` lança `RangeError`
- **Fix:** leitura via `extract(epoch from scheduled_for) as epoca` + helper `comoInstante` (`new Date(Number(epoca) * 1000)`), imune ao fuso da sessão do PostgreSQL
- **Files modified:** `src/application/appointment.ts`
- **Verification:** 9/9 testes de appointment verdes; 31/31 nas três suítes novas; 416/416 na suíte completa
- **Committed in:** `7357b19`

**4. [Rule 1 - Bug] Corrupção de encoding (mojibake/U+FFFD) em arquivos de Task 2**
- **Found during:** Task 2 (antes do commit)
- **Issue:** edições via `Set-Content`/`Get-Content -Raw` no PowerShell 5.1 reencodaram acentos e setas de comentários (`ção`→`mojibake`, `→`→`U+FFFD`), corrompendo comentários (não idênticos ao original — precisam ser ASCII/UTF-8 íntegros)
- **Fix:** restaurados do git os 2 arquivos modificados com mojibake (`conversations.ts`, `prompt-builder.ts`) e reaplicadas as edições com a ferramenta `edit`; os 3 arquivos novos tiveram as sequências corrompidas corrigidas e os arquivos regravados como UTF-8 sem BOM; verificação byte-level confirmou 0 `U+FFFD` e UTF-8 válido nos 10 arquivos
- **Files modified:** `src/api/routes/conversations.ts`, `src/domain/llm/prompt-builder.ts`, `src/api/routes/crm.ts`, `tests/application/copilot.test.ts`, `tests/api/crm.test.ts`
- **Verification:** varredura `UTF8Encoding($false,$true)` + contagem de `U+FFFD` = 0 nos 10 arquivos; `npm test` 416/416
- **Committed in:** `7357b19`

---

**Total deviations:** 4 auto-fixed (1 missing critical, 1 blocking, 2 bugs)
**Impact on plan:** Todas necessárias para correção/segurança. A #2 toca 2 arquivos fora de `files_modified` (wiring), documentada acima; nenhum scope creep — o PLAN não foi alterado.

## Issues Encountered
- **UTF-8 na suíte de testes:** a corrupção de encoding foi descoberta pelo caminho de teste (`RangeError` mascarou-se parcialmente com o problema de encoding) — resolvida conforme deviation #4. Lição: usar somente `edit`/`write`/`biome` para arquivos com acentuação neste ambiente PowerShell 5.1.
- **`tratarRespostaAgendamento` marca `engagement_mode = 'awaiting_human'`** (via `dispararHandoff`), não `'human'` — expectativa do teste corrigida para o valor real do serviço de handoff; `handoff_active = true` confirma a parada.

## Known Stubs

Nenhum stub que impeça o objetivo do plano. Gaps deliberados (não-bloqueantes, fora de `files_modified`) registrados para rastreio:
- `pipeline_status = 'fechado'` **não** interrompe a cadência de follow-up: o encerramento da cadência vive no scheduler (fora de `files_modified` deste plano) — deferred-items
- Comentário desatualizado em `src/infra/db/queries/status-history.ts:12-18` (referência a `dispatcher`) — preexistente, out of scope

## Threat Flags

Nenhum. As rotas novas ficam atrás da guarda de token/Host existente (127.0.0.1) e nenhum arquivo introduz nova superfície de rede, path de auth ou acesso a arquivo fora do padrão já mapeado no threat model do plano.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Backend do CRM completo e verde (typecheck + lint + 416 testes); o SPA do painel (03-04) já pode consumir `/api/crm/*` e as rotas de agendamento
- A fiação do copiloto em produção depende de `PanelCore.llm` injetado (`index.ts` já injeta `llmProducao`); sem chave a chamada falha fail-closed (503/evento), como especificado
- Pendência para a fase de operação: encerrar a cadência de follow-up quando o pipeline vira `fechado` (scheduler)

---
*Phase: 03-cadencia-operacao-e-painel*
*Completed: 2026-10-20*

## Self-Check: PASSED

