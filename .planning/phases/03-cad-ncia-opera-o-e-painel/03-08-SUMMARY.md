---
phase: 03-cad-ncia-opera-o-e-painel
plan: 08
subsystem: ui
tags: [react, vite, tailwind, crm, pipeline, copiloto, adr, fastify, local-only]

# Dependency graph
requires:
  - phase: 03-cad-ncia-opera-o-e-painel
    provides: >
      Backend do CRM (03-05): `src/domain/pipeline.ts` (9 status + MOTIVOS),
      `src/api/routes/crm.ts` (16 rotas: pipeline, tags, notas, tarefas, responsável),
      `src/application/copilot.ts` (sugere, nunca envia) e `src/application/appointment.ts`
      (confirmação/lembrete; remarcar/cancelar = handoff);
      frontend base (03-04): `SuggestionCard`, `apiGet`/`apiPost`, layout denso de 4 painéis,
      cabeçalho de modo e fila de handoff;
      cadência (03-01/03-02): ADR-009 como autoridade, `last_outbound_at` como âncora,
      teto de 4 toques, dreno `FIRE_ONCE` com `isCatchupDrain` como parâmetro de boot.
provides:
  - "PipelineBoard: pipeline de 9 status com rótulos pt-BR, busca server-side, correção manual com MOTIVO obrigatório em status terminal e histórico read-only"
  - "LeadNotes: notas do lead com rótulo textual de autoria (`admin` vs `ia`) e criação de nota pelo Admin"
  - "TaskList: tarefas/lembretes com `due_at`, status e responsável, com criação e mudança de status"
  - "CopilotPanel: sugestões renderizadas no `SuggestionCard` do 03-04; Aceitar/Editar só preenchem o input; envio apenas pelo botão Enviar → `POST /api/dispatch`"
  - "Integração em `App.tsx`: abas Painel/CRM + gaveta de detalhe do lead com abas Notas/Tarefas/Histórico"
  - "ADR-014 (motor da cadência, subordinado ao ADR-009) e ADR-015 (painel único, pipeline de 9 status, suggest-never-send)"
  - "Reconciliação documental D-26: R-004/R-005/R-058 em `docs/01-requisitos-funcionais.md`, RN-009 e `isCatchupDrain` em `docs/03-regras-de-negocio.md`, P-008 em `docs/pendencias.md`"
  - "`apiPatch` em `src/web/api.ts` — PATCH de tarefas no mesmo transporte (Host guard + Bearer) do painel"
affects: [03-06, 03-07, fase-04-piloto, REQUIREMENTS, ROADMAP]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Painel único local: a UI só consome `GET/POST/PATCH /api/crm/*`; nenhuma escrita direta no banco nem caminho novo de envio"
    - "Suggest-never-send: Aceitar/Editar apenas preenchem o input; a única saída de texto para o canal é o botão Enviar → `/api/dispatch` (gate, `origin='admin'`)"
    - "Histórico append-only na UI: somente leitura, sem controles de editar/excluir; máximo de 200 entradas em memória"
    - "Erro 4xx do servidor exibido inline (`role=\"alert\"`), nunca silenciado e nunca com payload da mensagem do lead"
    - "ADR-009 permanece a autoridade permanente da cadência; ADRs 014/015 são subordinados e não podem contradizê-lo"

key-files:
  created:
    - src/web/components/PipelineBoard.tsx
    - src/web/components/LeadNotes.tsx
    - src/web/components/TaskList.tsx
    - src/web/components/CopilotPanel.tsx
    - docs/08-adr/014-scheduler-cadencia.md
    - docs/08-adr/015-pipeline-crm-copiloto.md
  modified:
    - src/web/App.tsx
    - src/web/api.ts
    - docs/01-requisitos-funcionais.md
    - docs/03-regras-de-negocio.md
    - docs/pendencias.md

key-decisions:
  - "`isCatchupDrain` documentado como PARÂMETRO de boot (D-07/ADR-009) — nunca campo de `settings` nem modo global; o plano 03-08 não altera o código do scheduler, apenas reconcilia a documentação que ocontradizia"
  - "ADR-009 permanece a autoridade da cadência; o ADR-014 detalha o motor (âncora `last_outbound_at`, teto de 4, dreno como válvula) sem contradizer 1h→1d→3d→7d nem o corte de 15 dias"
  - "R-058 acrescentado a `docs/01-requisitos-funcionais.md` (silêncio do bot fora da janela operacional) porque não constava do documento — a reconciliação de R-004/R-005 ficaria incompleta sem ele"
  - "R-005 reconciliado com o estado terminal real do código (`encerrado` + `closed_reason='sem_resposta'` → `pipeline_status` `perdido`), com `opt_out` como estado terminal incondicionado"
  - "RN-009 reconciliado no sentido 'fora da janela só enfileira/adia, dentro envia' — o texto anterior sugeria descarte, o que contradizia WHS-02"
  - "A correção de status no painel usa `POST /api/crm/conversations/:id/status` com `motivo` obrigatório em status terminal; o servidor decide a transição (`transicaoValida`), a UI apenas apresenta"
  - "Histórico de status compartilhado entre `PipelineBoard` e a gaveta do lead em `App.tsx` (append-only, máx. 200), sem edição — D-23"
  - "`apiPatch` criado em `src/web/api.ts` em vez de `fetch` cru no componente: mantém o mesmo transporte do painel (Host guard + Bearer token) e a mesma política de erro 4xx tolerado"

patterns-established:
  - "Componente de CRM = 4 estados (dados/carregando/erro/enviando) + estado de formulário local; erro de servidor sempre inline, sem fechar o diálogo de correção"
  - "Rótulo textual de autoria (`Nota do Admin` / `Nota da IA`) — nunca só cor (acessibilidade e CRM-03/D-22)"
  - "Copy 100% pt-BR nos componentes; nenhuma string em inglês no texto visível"
  - "Documento reconciliado carrega a marca explícita `reconciliado com ADR-009 — Fase 3` e referência cruzada ao ADR-014"

requirements-completed: [CRM-01, CRM-03, FLUP-06, FLUP-08]

# Metrics
duration: 32min
completed: 2026-10-21
---

# Phase 3 Plan 08: UI de CRM/copiloto + Reconciliação de ADRs — Summary

**Painel de CRM operacional em React (pipeline de 9 status com motivo obrigatório, notas Admin×IA, tarefas/lembretes e copiloto suggest-never-send) sobre o backend do 03-05, mais a reconciliação documental D-26 com o ADR-009 mantido como autoridade permanente da cadência.**

## Performance

- **Duration:** 32 min
- **Started:** 2026-10-21T10:22:00Z
- **Completed:** 2026-10-21T10:54:00Z
- **Tasks:** 2
- **Files modified:** 11 (6 web + 5 docs — o plano declarava 10; ver desvio 1)

## Accomplishments

- **O Admin opera o pipeline completo pelo painel, sem tocar no banco nem em CLI**: `PipelineBoard` lista as conversas nos 9 status de `src/domain/pipeline.ts` com rótulos pt-BR, busca **server-side** (`GET /api/crm/conversations?q=...`, debounce de 250 ms) e abre um diálogo de correção que **exige MOTIVO** nos status terminais (`perdido` exige um valor de `MOTIVOS`). Erros 4xx do servidor (ex.: reativar um lead em `opt_out`) são exibidos **inline**, com `role="alert"`, sem silenciar e sem fechar o diálogo.
- **Histórico de status visível e read-only** (`HistoricoStatus`, exportado): append-only, sem nenhum controle de editar/excluir, compartilhado entre o quadro e a gaveta do lead (máx. 200 entradas) — D-23.
- **Notas do lead com autoria explícita** (`LeadNotes`): rótulo **textual** `Nota do Admin` vs `Nota da IA` (`author_type='admin'|'ia'`), nunca só cor; criação de nota pelo Admin via `POST /api/crm/leads/:leadId/notes`; empty state `Nenhuma nota ainda.`
- **Tarefas/lembretes** (`TaskList`): exibe `due_at`, status e responsável; criação via `POST /api/crm/tasks` e mudança de status via `PATCH /api/crm/tasks/:id`; empty state `Nenhuma tarefa ainda.`; **sem** ação de reagendar/cancelar (isso é handoff — R-025/AR-003).
- **Copiloto sem caminho de envio acidental** (`CopilotPanel`): **reusa** o `SuggestionCard` do 03-04 (não duplica); Aceitar/Editar apenas preenchem o input; a única chamada a `/api/dispatch` é o botão **Enviar** (1 ocorrência no arquivo), com a copy de bloqueio `Envio bloqueado pelo gate: {motivo}. Nada foi enviado ao lead.`
- **Integração no painel** (`App.tsx`): abas **Painel** e **CRM**, gaveta de detalhe do lead com abas **Notas | Tarefas | Histórico** e a ação `Abrir conversa no painel`; cabeçalho de modo e fila de handoff do 03-04 preservados.
- **Reconciliação documental D-26 concluída**: ADRs `014-scheduler-cadencia.md` e `015-pipeline-crm-copiloto.md` criados (nomes travados de D-26); `docs/01-requisitos-funcionais.md` com **R-004/R-005 reconciliados + R-058 acrescentado**; `docs/03-regras-de-negocio.md` com **RN-009 reconciliado** e nova §2.1 documentando `isCatchupDrain` como **parâmetro**; `docs/pendencias.md` com P-008 resolvido.

## Task Commits

Each task was committed atomically:

1. **Task 1: UI de CRM/copiloto — PipelineBoard, LeadNotes, TaskList, CopilotPanel integrados ao App** - `09005cd` (feat)
2. **Task 2: Reconciliação de docs/ADRs (D-26) — ADRs 014/015, R-004/R-005/R-058, RN-009/isCatchupDrain, pendencias** - `2041e35` (docs)

**Plan metadata:** `docs(03-08): completa o plano 03-08` (este SUMMARY)

_Note: TDD tasks may have multiple commits (test → feat → refactor)_

## Files Created/Modified

- `src/web/components/PipelineBoard.tsx` (novo, 594 linhas) — quadro dos 9 status, busca server-side, diálogo de correção com motivo obrigatório em status terminal, `HistoricoStatus` read-only.
- `src/web/components/LeadNotes.tsx` (novo, 189 linhas) — notas do lead com `author_type` e criação de nota pelo Admin.
- `src/web/components/TaskList.tsx` (novo, 291 linhas) — tarefas/lembretes com `due_at`, status e responsável.
- `src/web/components/CopilotPanel.tsx` (novo, 137 linhas) — sugestões no `SuggestionCard`, Aceitar/Editar preenchem o input, Enviar → `POST /api/dispatch`.
- `src/web/App.tsx` (modificado) — abas Painel/CRM, gaveta de detalhe do lead, histórico compartilhado, integração dos 4 componentes.
- `src/web/api.ts` (modificado) — `apiPatch` tipado, aceito pelo `requisitar` junto de GET/POST.
- `docs/08-adr/014-scheduler-cadencia.md` (novo, 328 linhas) — motor da cadência: âncora `last_outbound_at`, teto de 4 toques, dreno como válvula, `isCatchupDrain` como parâmetro de boot, janela 7h–17h útil como fronteira dura; **subordinado ao ADR-009**.
- `docs/08-adr/015-pipeline-crm-copiloto.md` (novo, 328 linhas) — painel único local (bind `127.0.0.1`, guarda `Host`, Bearer token), pipeline de 9 status, notas append-only, tarefas, copiloto suggest-never-send, agendamento manual; **subordinado ao ADR-011**.
- `docs/01-requisitos-funcionais.md` (modificado) — R-004 e R-005 reconciliados com o ADR-009 e com o código real; **R-058 acrescentado** (silêncio do bot fora da janela).
- `docs/03-regras-de-negocio.md` (modificado) — RN-009 reconciliado (fora da janela enfileira/adia; dentro envia) e nova §2.1 sobre `isCatchupDrain` como parâmetro.
- `docs/pendencias.md` (modificado) — **P-008 registrada como resolvida** (2026-10-21) com os 3 defeitos documentais e a correção aplicada.

## Decisions Made

- **`isCatchupDrain` é parâmetro, não configuração**: documentado explicitamente em `docs/03-regras-de-negocio.md` §2.1 como parâmetro de boot (D-07/ADR-009), com a ressalva de que não é campo de `settings` nem modo global. O código do scheduler (03-02) não foi alterado — este plano é de reconciliação documental.
- **ADR-009 continua sendo a autoridade**: o ADR-014 detalha o motor sem tocar nos 4 toques (1h→1d→3d→7d), no corte de 15 dias, na janela útil nem na regra de interrupção (R-042/R-012/R-024/R-066). A marca `reconciliado com ADR-009 — Fase 3` aparece 3× em `docs/01-requisitos-funcionais.md` e 2× em `docs/03-regras-de-negocio.md`.
- **R-005 alinhado ao código, não o contrário**: `encerrado` + `closed_reason='sem_resposta'` mapeia para `pipeline_status='perdido'`; `opt_out` é terminal e incondicionado; motivos enumerados.
- **R-058 como requisito novo no documento de requisitos**: o plano previa "acrescentar R-058 se ainda não constar" — não constava, e a reconciliação de R-004/R-005 ficaria incompleta sem ele.
- **UI decide apresentação, servidor decide transição**: `PipelineBoard` envia `motivo` e mostra o 4xx; a validade da transição é de `transicaoValida` (03-05). A UI não replica regras de negócio.
- **Histórico nunca é editável na UI** (D-23/T-03-52): o `HistoricoStatus` exportado não expõe mutação, e a gaveta do lead reaproveita o mesmo estado append-only do `App.tsx`.
- **`apiPatch` em vez de `fetch` cru**: mantém o mesmo transporte do painel (Host guard + Bearer) e a política de erro 4xx tolerado, em vez de abrir um segundo caminho de rede dentro do componente.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Adicionado `apiPatch` ao transporte do painel**
- **Found during:** Task 1 (TaskList — criação/mudança de status de tarefas)
- **Issue:** o contrato do CRM expõe `PATCH /api/crm/tasks/:id` (03-05), mas `src/web/api.ts` só aceitava `"GET" | "POST"` em `requisitar` e não expunha helper de PATCH. Sem isso, `TaskList` teria de fazer `fetch` cru — abrindo um **segundo caminho de rede** fora do transporte do painel (Host guard + Bearer token) e duplicando a política de erro 4xx tolerado.
- **Fix:** `metodo` widened para `"GET" | "POST" | "PATCH"` e criado `apiPatch<T>` com a mesma política de `apiPost` (`toleranteAErroHttp: true`).
- **Files modified:** `src/web/api.ts`
- **Verification:** `npm run typecheck` exit 0; `npm run web:build` exit 0; `npm test` 416/416 verdes; nenhum `fetch` novo em `src/web` (só `src/web/api.ts` e `src/web/useSse.ts`).
- **Committed in:** `09005cd` (part of task commit)
- **Impacto no plano:** `files_modified` real = **11** (6 web + 5 docs) contra os 10 declarados — o arquivo acrescentado está dentro da mesma entrega da Task 1 e não representa trabalho fora de escopo.

**2. [Rule 1 - Bug] Corrigida grafia corrompida no ADR-015**
- **Found during:** Task 2 (redação do ADR-015)
- **Issue:** o texto gerado carregava a sequência corrompida `nãoliners commits` na passagem que define a precedência documental.
- **Fix:** trecho reescrito com a formulação correta, mantendo o sentido (o ADR-015 não substitui nem contradiz o ADR-009/ADR-011).
- **Files modified:** `docs/08-adr/015-pipeline-crm-copiloto.md`
- **Verification:** `Select-String` por `commit`/`nãoliners` no ADR-015 → 0 ocorrências de texto corrompido; leitura do ADR confirmando a formulação.
- **Committed in:** `2041e35` (part of task commit)

---

**Total deviations:** 2 auto-fixed (1 Rule 2 - missing critical, 1 Rule 1 - bug)
**Impact on plan:** Both auto-fixes necessary for correctness/security. No scope creep — o `apiPatch` é infraestrutura de transporte do próprio painel, e a correção de grafia é cosmética dentro do arquivo que o plano mandava criar.

## Issues Encountered

- **`files_modified` do plano (10) não fecha com a união real (11):** o plano previa 5 arquivos web, mas o contrato de tarefas do CRM exige `PATCH`, inexistente no cliente HTTP do painel. Resolvido com o `apiPatch` (desvio 1) e registrado aqui em vez de omitido — a divergência é real e auditável.
- **Console do PowerShell exibe mojibake nos arquivos UTF-8** (acentos como `Hist�rico`): é apenas a codificação do console, não do arquivo. Para não corromper a acentuação dos documentos, toda edição foi feita com as ferramentas de arquivo (`edit`/`write`) e as conferências de BOM foram feitas por leitura binária — nenhum `Set-Content`/`Out-File`/heredoc foi usado em `docs/`.
- **16 warnings pré-existentes de `noNonNullAssertion`** (`tests/` e `src/infra/db/queries/`): são anteriores a este plano e **nenhum** está em arquivo tocado por 03-08. `npm run lint` exit 0 (0 erros).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- **03-06 (gaveta de detalhe + compliance)**: já pode reaproveitar `HistoricoStatus`, `LeadNotes` e `TaskList` — a gaveta do `App.tsx` criada aqui é a base que o 03-06 vai consolidar com as abas Conversa/Compliance e a `AuditTimeline`. A rota `GET /api/conversations/:id/audit` permanece de responsabilidade do 03-06.
- **03-07 (eventos e falhas)**: o padrão de painel (4 estados, erro inline, `role="alert"`, pt-BR) já está estabelecido nos 4 componentes e serve de template para `ErrorPanel`/`ConnectionIndicator`/`SystemHeader`.
- **Fase 4 (piloto)**: o Admin tem operação completa sem tocar no banco nem em CLI; a cadência está documentada de forma única (ADR-009 como autoridade, ADR-014 como detalhe do motor), o que elimina divergência de leitura entre quem opera e quem audita.
- **Ponto de atenção herdado (não bloqueia a Fase 3)**: `P-007` — queda do socket após `channel_ready` (rc14 vs servidor WhatsApp) e `01-03` deferido; ambos seguem registrados em `docs/pendencias.md`.

## Verification

- `npm run lint` → exit 0 (0 erros; 16 warnings `noNonNullAssertion` pré-existentes, nenhum em arquivo tocado).
- `npm run typecheck` → exit 0.
- `npm test` → exit 0, **68 arquivos / 416 testes** verdes (164,28 s).
- `npm run web:build` → exit 0 (`dist/web`: `index-Bbjn7NIy.js` 286,40 kB, CSS 17,42 kB).
- `grep -c "dangerouslySetInnerHTML" src/web` → **0**.
- `sendText(` → chamado apenas em `src/application/dispatcher.ts` (choke-point intacto; `src/infra/fake-channel.ts` é a implementação fake do `ChannelPort`, não um chamador).
- `api/dispatch` em `CopilotPanel.tsx` → **2** ocorrências (import do tipo + 1 chamada, no botão Enviar).
- Controles de editar/excluir histórico em `PipelineBoard.tsx` → **0**.
- `fetch(` em `src/web` → apenas `src/web/api.ts` e `src/web/useSse.ts`.
- Docs: `docs/08-adr/014-scheduler-cadencia.md` e `docs/08-adr/015-pipeline-crm-copiloto.md` existem; `R-058` → 1 em `docs/01-requisitos-funcionais.md`; `reconciliado com ADR-009` → 3 e 2; `isCatchupDrain` → 1 em `docs/03-regras-de-negocio.md`; **nenhum dos 5 arquivos docs com BOM UTF-8**.

## Self-Check: PASSED

- **Arquivos criados/modificados verificados (12/12 presentes):** `src/web/components/PipelineBoard.tsx`, `src/web/components/LeadNotes.tsx`, `src/web/components/TaskList.tsx`, `src/web/components/CopilotPanel.tsx`, `src/web/App.tsx`, `src/web/api.ts`, `docs/08-adr/014-scheduler-cadencia.md`, `docs/08-adr/015-pipeline-crm-copiloto.md`, `docs/01-requisitos-funcionais.md`, `docs/03-regras-de-negocio.md`, `docs/pendencias.md`, `.planning/phases/03-cad-ncia-opera-o-e-painel/03-08-SUMMARY.md`.
- **Commits verificados (4/4 presentes em `git log --all`):** `09005cd` (T1), `2041e35` (T2), `44c9e72` (SUMMARY), `765554a` (estado/roadmap).
- **Working tree limpo** — nenhum arquivo não rastreado ou modificado pendente.

---
*Phase: 03-cad-ncia-opera-o-e-painel*
*Completed: 2026-10-21*
