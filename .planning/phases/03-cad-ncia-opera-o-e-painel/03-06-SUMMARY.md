---
phase: 03-cad-ncia-opera-o-e-painel
plan: 06
subsystem: ui
tags: [react, dialog, fastify, drizzle, postgres, lgpd, opt-out, auditoria, append-only]

# Dependency graph
requires:
  - phase: 03-cad-ncia-opera-o-e-painel/03-04
    provides: "Painel base — `LeadList`, `App.tsx`, `MessageHistory` read-only, `apiGet`/`apiPost`, padrão type-to-confirm do kill switch"
  - phase: 03-cad-ncia-opera-o-e-painel/03-05
    provides: "`src/domain/pipeline.ts` (rótulos pt-BR do funil), rotas do CRM, `conversations.pipeline_status`"
  - phase: 03-cad-ncia-opera-o-e-painel/03-08
    provides: "`LeadNotes`, `TaskList`, `CopilotPanel`/`SuggestionCard`, vista CRM"
provides:
  - "POST /api/leads/:id/opt-out — opt-out manual type-to-confirm `OPTOUT`, prova dupla (`optout_ledger(source='manual')` + `event_log('optout_manual')`), idempotente"
  - "GET /api/conversations/:id/audit — `status_history` + `handoff_events` + `blocked_attempts`, read-only, teto de 200 linhas por fonte"
  - "GET /api/leads/:id estendido com `optOutAt`, `pipelineStatus` e `tags`"
  - "`LeadDetailDrawer` — gaveta `<dialog>` nativo com as 5 abas do wireframe §4 (Conversa/Notas/Tarefas/Histórico/Compliance)"
  - "`AuditTimeline` — linha do tempo read-only que funde as 4 fontes append-only em ordem cronológica"
  - "`CompliancePanel` — aba Compliance com origem/base legal/finalidade e a ação irreversível Marcar opt-out"
  - "`LeadHistoryPanel` — coluna direita com o resumo R-064 do lead selecionado"
  - "`ConfirmDialog` — primitiva `<dialog>` reutilizável com variante type-to-confirm"
  - "tests/api/lead-detail.test.ts — 10 casos de API (prova dupla, idempotência, 400/404, audit, funil/tags)"
affects: [03-07, COMP-01, 03-cad-ncia-opera-o-e-painel, painel, lgpd, retencao]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Type-to-confirm como primitiva de UI (`ConfirmDialog`): o botão destrutivo só habilita com o literal exato, case-sensitive — espelha a validação zod do servidor"
    - "Prova dupla de LGPD: mutação irreversível grava ledger + event_log na MESMA transação (SAVEPOINT aninhado do Drizzle)"
    - "Timeline read-only por merge de fontes append-only, origem marcada por ícone + rótulo textual (nunca só cor)"
    - "Slots de estado separados para o mesmo agregado (gaveta vs coluna direita) — um nunca sobrescreve o outro"

key-files:
  created:
    - src/web/components/LeadDetailDrawer.tsx
    - src/web/components/AuditTimeline.tsx
    - src/web/components/CompliancePanel.tsx
    - src/web/components/LeadHistoryPanel.tsx
    - src/web/components/ConfirmDialog.tsx
    - tests/api/lead-detail.test.ts
  modified:
    - src/api/routes/leads.ts
    - src/api/routes/conversations.ts
    - src/api/schemas.ts
    - src/infra/db/queries/leads.ts
    - src/web/api.ts
    - src/web/App.tsx
    - src/web/components/LeadList.tsx

key-decisions:
  - "Rótulos pt-BR de compliance (`rotuloBaseLegal`/`rotuloFinalidade`) moram em `src/web/api.ts` — o módulo que define o contrato — para que a gaveta, a aba Compliance e a coluna direita nunca discordem do rótulo; sem criar um 14º arquivo (a reconciliação de 13 arquivos do plano é explícita)."
  - "Gaveta e coluna direita têm slots de estado SEPARADOS (`leadGaveta` vs `leadDetalhe`): o lead aberto na gaveta (botão Ver detalhe) pode não ser o lead selecionado no chat, e um nunca sobrescreve o outro."
  - "`GET /api/leads/:id` foi estendido com `pipelineStatus` (subquery escalar: `order by c2.created_at desc limit 1`) e `tags` (`json_agg` sobre `lead_tags`×`tags`) — o cabeçalho da gaveta e o `LeadHistoryPanel` dependem desses campos, que a rota não devolvia."
  - "`applyOptOut` foi estendido com `source?: 'auto_detected' | 'manual'` em vez de uma função nova — a semântica idempotente existente fica intocada e `inbound-handler.ts` continua compatível sem alteração."
  - "Auditoria lida SEQUENCIALMENTE (audit + messages) em vez de `Promise.all` — o `pg` emite warning de query concorrente em um mesmo client."
  - "O diálogo de kill switch do 03-04 NÃO foi refatorado para o `ConfirmDialog` novo — o plano proíbe explicitamente; as duas implementações coexistem."

patterns-established:
  - "Primitiva de diálogo nativo: `showModal()` com guard `!dialogo.open`, `Esc` pelo evento `close`, focus-trap do próprio elemento (sem `div` simulando modal)."
  - "Busca de detalhe por aggregate nunca é feita duas vezes para o mesmo slot: o App tem uma função `carregarDetalhe`/`carregarGaveta` por slot, e a re-sincronização pós-mutação só recarrega o slot afetado."
  - "Verificação estrutural por grep como critério de aceite de anti-requisito (`dangerouslySetInnerHTML`, `Excluir dados`, `sendText`, `update|delete from` na rota nova)."

requirements-completed: [NFRQ-05]

# Metrics
duration: 53min
completed: 2026-10-21
---

# Phase 03 Plan 06: Detalhe do Lead Summary

**Gaveta `<dialog>` de detalhe do lead com as 5 abas do wireframe, linha do tempo read-only das 4 fontes de auditoria, e opt-out manual irreversível com type-to-confirm `OPTOUT` e prova dupla em `optout_ledger` + `event_log`.**

## Performance

- **Duration:** 53 min
- **Started:** 2026-10-21T10:58:19Z
- **Completed:** 2026-10-21T11:48:00Z
- **Tasks:** 3 (Task 1 em TDD — RED antes do GREEN)
- **Files modified:** 13 (6 criados, 7 modificados) — reconcilia com a união dos `<files>` das 3 tasks

## Accomplishments

- **Opt-out manual com prova dupla e irreversível**: `POST /api/leads/:id/opt-out` exige o literal `OPTOUT` (400 sem ele), grava `optout_ledger(source='manual', detected_by IS NULL)` + `event_log('optout_manual', severity='warn')` na MESMA transação, e é idempotente — a segunda chamada devolve `mudou:false` sem duplicar prova. Não existe rota de reversão.
- **Auditoria servida em 3 fontes, sem mutação**: `GET /api/conversations/:id/audit` devolve `status_history` + `handoff_events` + `blocked_attempts`, cada uma em ordem desc e com teto de 200 linhas. A rota nova é SELECT-only (0 `update`/`delete` no bloco das linhas 329–404).
- **Gaveta de detalhe com as 5 abas**: `<dialog>` nativo (`showModal()`, `Esc`, focus-trap do elemento) com `role="tablist"` navegável por setas — Conversa (reaproveita `MessageHistory`), Notas (`LeadNotes`), Tarefas (`TaskList`), Histórico (nova `AuditTimeline`) e Compliance (nova `CompliancePanel`).
- **Linha do tempo das 4 fontes**: `AuditTimeline` funde `messages` + `status_history` + `handoff_events` + `blocked_attempts` numa lista cronológica (mais recente primeiro), marcando a origem com ícone + rótulo textual e timestamp tabular — 0 botão de editar/excluir.
- **Compliance visível nos dois lugares**: coluna direita (`LeadHistoryPanel` — funil, tags, origem, base legal, finalidade, opt-out, última entrada/saída) e aba Compliance (os mesmos campos + a ação irreversível).
- **Prova automatizada do comportamento novo**: `tests/api/lead-detail.test.ts` com 10 casos — confirmação obrigatória, 404, prova dupla, idempotência, `optOutAt`, audit com as 3 fontes e o funil/tags do detalhe.

## Task Commits

Each task was committed atomically:

1. **Task 1: Rotas — opt-out manual com prova e auditoria read-only** — `9a19915` (test: RED, 8 casos falhando) + `ff5871a` (feat: GREEN)
2. **Task 2: Gaveta `LeadDetailDrawer` + linha do tempo `AuditTimeline`** — `8c4f12c` (feat)
3. **Task 3: `CompliancePanel` + `LeadHistoryPanel` + `ConfirmDialog` e opt-out type-to-confirm** — `32851b8` (feat)

Commits auxiliares:

- `caefb0f` (style) — formatação do biome em `tests/api/lead-detail.test.ts` (arquivo já previsto no plano; sem mudança de comportamento), isolada para não sujar o commit da Task 3.

**Plan metadata:** `docs(03-06): registra o resumo do plano de detalhe do lead` (este SUMMARY — `edcb91b`)

_Note: TDD tasks may have multiple commits (test → feat → refactor)_

## Files Created/Modified

- `src/web/components/LeadDetailDrawer.tsx` — gaveta `<dialog>` nativo com as 5 abas, cabeçalho (nome, telefone, funil, origem, base legal, finalidade, tags) e botão "Ver conversa completa"
- `src/web/components/AuditTimeline.tsx` — linha do tempo read-only das 4 fontes append-only, com estados vazio/carregando/erro
- `src/web/components/CompliancePanel.tsx` — aba Compliance: origem/base legal/finalidade/registro/primeiro contato humano + ação Marcar opt-out com `ConfirmDialog` type-to-confirm
- `src/web/components/LeadHistoryPanel.tsx` — resumo R-064 do lead selecionado na coluna direita
- `src/web/components/ConfirmDialog.tsx` — primitiva `<dialog>` reutilizável (confirmação simples e type-to-confirm case-sensitive)
- `tests/api/lead-detail.test.ts` — 10 casos de API sobre Fastify real (`app.inject`, rollback por sentinela)
- `src/api/routes/leads.ts` — `POST /api/leads/:id/opt-out`, `optOutAt` no detalhe, `pipelineStatus` + `tags` no detalhe
- `src/api/routes/conversations.ts` — `GET /api/conversations/:id/audit` (read-only)
- `src/api/schemas.ts` — `confirmarOptOutBody` (zod, literal `OPTOUT`)
- `src/infra/db/queries/leads.ts` — `applyOptOut` com `source?: 'auto_detected' | 'manual'`
- `src/web/api.ts` — tipos `LeadDetalhe`/`TrilhaAuditoria`/…, wrappers `buscarLead`/`buscarAuditTrail`/`registrarOptOutManual` e rótulos pt-BR de compliance
- `src/web/App.tsx` — slots da gaveta e da coluna direita, `LeadHistoryPanel` no layout e re-sincronização pós opt-out
- `src/web/components/LeadList.tsx` — botão de ícone "Ver detalhe do lead" por item (o clique simples segue selecionando para o chat)

## Decisions Made

- **Rótulos de compliance no módulo de contrato** (`src/web/api.ts`), e não em um arquivo novo: evita import circular com `src/domain/pipeline.ts` e preserva a reconciliação de 13 arquivos exigida pelo plano.
- **Dois slots de detalhe** (`leadGaveta`, `leadDetalhe`): o botão "Ver detalhe" abre a gaveta de um lead que pode não ser o selecionado no chat; um único slot faria a coluna direita "pular" de lead.
- **`pipeline_status` por subquery escalar** (a conversa mais recente do lead) e **`tags` por `json_agg`** — determinísticos e sem multiplicar linhas do lead.
- **Erro do servidor → texto na tela**: `apiPost` não lança em erro HTTP (devolve o corpo), então o `CompliancePanel` confere `optOut === true` e traduz `confirmacao invalida` para uma mensagem acionável.
- **O botão de opt-out some depois de registrar** (estado local do `CompliancePanel` sincronizado pelo id do lead), sem esperar o round-trip; o App re-sincroniza gaveta/coluna/lista em seguida.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] `GET /api/leads/:id` passou a devolver `pipelineStatus` e `tags`**
- **Found during:** Task 2 (gaveta + coluna direita)
- **Issue:** o plano manda o cabeçalho da gaveta (§4) mostrar status do funil e etiquetas, e o `LeadHistoryPanel` mostrar "status do pipeline, tags, origem…", mas a rota `GET /api/leads/:id` só devolvia `state`/`originSource`/bloco `compliance`. Sem esses campos os critérios de aceite do plano não eram cumpríveis.
- **Fix:** subquery escalar para `pipeline_status` (conversa mais recente) e `json_agg` sobre `lead_tags`×`tags` em `src/api/routes/leads.ts`, expostos como `pipelineStatus`/`tags` no detalhe. O arquivo já está no `files_modified` do plano.
- **Files modified:** `src/api/routes/leads.ts`
- **Verification:** 2 casos novos em `tests/api/lead-detail.test.ts` (lead com funil + etiqueta → `pipelineStatus`/`tags`; lead sem conversa nem etiquetas → `null`/`[]`)
- **Committed in:** `8c4f12c` (parte do commit da Task 2)

**2. [Rule 2 - Missing Critical] Cobertura de teste para os campos novos do detalhe**
- **Found during:** Task 2 (verificação)
- **Issue:** o SQL de `tags`/`pipeline_status` (subquery + `json_agg`) entrou no mesmo commit da UI sem nenhum teste — um erro de coluna ou de agregação só apareceria em runtime, no painel.
- **Fix:** 2 casos em `tests/api/lead-detail.test.ts` (arquivo já previsto no plano), sem criar suíte nova.
- **Files modified:** `tests/api/lead-detail.test.ts`
- **Verification:** `npx vitest run tests/api/lead-detail.test.ts` → 10/10 verdes
- **Committed in:** `8c4f12c`

**3. [Rule 1 - Bug] Formatação do teste de detalhe quebrou `npm run lint`**
- **Found during:** Task 3 (verificação)
- **Issue:** o `biome` apontava 1 erro de formatação no bloco de tipos adicionado na Task 2 (`npm run lint` → `Found 1 error`), o que reprovaria o critério de aceite do plano.
- **Fix:** `biome check --write` no arquivo, commit isolado do tipo `style`.
- **Files modified:** `tests/api/lead-detail.test.ts`
- **Verification:** `npm run lint` → 0 erros, 16 warnings (todos pré-existentes de `noNonNullAssertion` em testes de outras fases)
- **Committed in:** `caefb0f`

---

**Total deviations:** 3 auto-fixed (2 missing critical, 1 bug)
**Impact on plan:** Nenhum escopo novo: os dois primeiros só tornam executáveis os campos que o próprio plano exige nas telas, dentro de arquivos já declarados; o terceiro é formatação. A reconciliação de 13 arquivos foi preservada.

## Issues Encountered

- **Critério literal de grep não passa como escrito.** O plano exige `grep -v '^#' src/api/routes/conversations.ts | grep -ci "update \|delete from"` == 0. O arquivo tem 3 ocorrências — linhas 226, 237 e 245 — TODAS no bloco preexistente `POST /api/conversations/:id/actions` (03-04/03-05: `update conversations`, `update handoff_events`). A rota nova `GET /api/conversations/:id/audit` (linhas 329–404) tem **0** ocorrências de escrita. A verificação foi feita com escopo (rota nova) e o resultado está documentado aqui; nenhuma linha de código pré-existente foi tocada para "dar verde" num grep.
- **`rg` indisponível no shell (PowerShell 5.1)**: todos os greps foram feitos com `Select-String`/`Get-Content`, equivalentes.
- **Concurrent query warning do `pg`**: ler `/audit` e `/messages` em paralelo no mesmo client gera aviso de query concorrente; a leitura ficou sequencial (`AuditTimeline.carregar`).
- **Diálogos `<dialog>` aninhados**: o `ConfirmDialog` (type-to-confirm) é renderizado dentro do `LeadDetailDrawer` (que também é `<dialog>`). O navegador resolve a hierarquia de modais; o `ConfirmDialog` fecha antes de o estado do drawer mudar, evitando sobreposição de `showModal()`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- **Pronto:** o Admin abre o detalhe de qualquer lead numa gaveta sem sair do painel, vê a auditoria das 4 fontes em uma linha do tempo read-only, e registra opt-out manual com confirmação `OPTOUT` — irreversível, idempotente e com prova dupla em `optout_ledger` + `event_log`.
- **Pronto:** o `ConfirmDialog` é a primitiva para as próximas confirmações destrutivas do painel (não só opt-out).
- **Para o 03-07/ COMP-01:** o `optout_ledger` já reserva `event_type='erasure_request'` para quando a política de retenção/exclusão chegar; esta fase **não** cria caminho de exclusão (`grep "Excluir dados" src/web` == 0 e `delete from leads|erasure` == 0 em `src/api/routes/leads.ts`), conforme decisão documentada no plano.
- **Sem bloqueios.** R-024, AR-005, R-043, R-064, D-23 e NFRQ-05 cobertos; nenhuma rota de escrita fora do opt-out foi criada.

## Self-Check: PASSED

- **Arquivos criados/modificados verificados (13/13 presentes + este SUMMARY):** `src/web/components/LeadDetailDrawer.tsx`, `src/web/components/AuditTimeline.tsx`, `src/web/components/CompliancePanel.tsx`, `src/web/components/LeadHistoryPanel.tsx`, `src/web/components/ConfirmDialog.tsx`, `tests/api/lead-detail.test.ts`, `src/api/routes/leads.ts`, `src/api/routes/conversations.ts`, `src/api/schemas.ts`, `src/infra/db/queries/leads.ts`, `src/web/api.ts`, `src/web/App.tsx`, `src/web/components/LeadList.tsx`, `.planning/phases/03-cad-ncia-opera-o-e-painel/03-06-SUMMARY.md`.
- **Commits verificados (6/6 presentes em `git log --all`):** `9a19915` (T1 RED), `ff5871a` (T1 GREEN), `8c4f12c` (T2), `caefb0f` (style), `32851b8` (T3), `edcb91b` (SUMMARY).
- **Verificação final:** `npm test` → 69 arquivos / 426 testes verdes; `npm run typecheck` → exit 0; `npm run lint` → 0 erros (16 warnings pré-existentes, nenhum em arquivo tocado); `npm run web:build` → exit 0.
- **Choke-points intactos:** `sendText` com 1 único chamador de produção (`src/application/dispatcher.ts`) e 0 ocorrências em `src/web/**`/`src/api/**`; `dangerouslySetInnerHTML` = 0; "Excluir dados" = 0 em `src/web`.
- **Working tree limpo** — nenhum arquivo não rastreado ou modificado pendente.

---

*Phase: 03-cad-ncia-opera-o-e-painel*
*Completed: 2026-10-21*
