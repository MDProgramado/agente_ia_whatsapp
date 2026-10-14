---
phase: 02-ia-handoff-e-shadow-mode
plan: 03
subsystem: application
tags: [cli, shadow-mode, guardrails, post-gate, kill-switch, llm, drizzle, vitest]

# Dependency graph
requires:
  - phase: 02-ia-handoff-e-shadow-mode
    provides: "LlmPort + FSM hintada + rascunho append-only em messages(origin='ai_suggestion') + llm_runs (02-01)"
  - phase: 02-ia-handoff-e-shadow-mode
    provides: "HandoffService atômico, matcher de opt-out, qualificação auditável e status_history (02-02)"
  - phase: 01-funda-o-canal-e-gate-de-envio
    provides: "evaluatePolicy (gate único), evaluate-kill-switch, blocked_attempts, settings.operational_mode, snapshot"
provides:
  - "CLI de revisão em shadow (shadow:list/approve/edit/discard) com decisões append-only em review_events"
  - "Kill switch global de 1 comando (mode pause/resume) auditado em event_log"
  - "correção de status pelo Admin (status:corrigir) via status_history"
  - "confirmação humana de handoff (handoff:ack) idempotente + auditoria append-only (D-15)"
  - "pós-gate de conteúdo L4 (CONV-07) determinístico contra valor/percentual/promo/mídia/agenda"
  - "relatório de shadow gerado do banco (gate de saída D-17) com veredicto PASS/FAIL"
  - "harness de bake-off de provedor LLM (D-10) com corpus pt-BR e veredito JSON"
affects: [03-cadencia-operacao-painel, 04-piloto-calibracao]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "CLI-first com função pura testável (runXxxCli(db, argv)) + entrypoint tsx"
    - "Decisões de revisão append-only em review_events (nunca UPDATE em messages)"
    - "Kill switch global = settings.operational_mode + trilha append-only em event_log"
    - "Pós-gate determinístico de conteúdo (L4) ANTES de persistir rascunho; bloqueio → recordBlockedAttempt"
    - "Relatório/gate de saída lendo o banco (nunca logs); limiares como constantes versionadas"
    - "Harness de bake-off offline-first com candidatos scripted, providers reais atrás de env keys"

key-files:
  created:
    - src/cli/shadow.ts
    - src/cli/mode.ts
    - src/cli/status.ts
    - src/cli/handoff.ts
    - src/domain/llm/post-gate.ts
    - scripts/shadow-report.ts
    - scripts/bake-off.ts
    - tests/cli/shadow.test.ts
    - tests/cli/status.test.ts
    - tests/cli/mode.test.ts
    - tests/cli/handoff-ack.test.ts
    - tests/domain/post-gate.test.ts
    - tests/adversarial/adversarial.test.ts
    - tests/ops/shadow-report.test.ts
    - tests/ops/bake-off.test.ts
    - .planning/phases/02-ia-handoff-e-shadow-mode/bake-off-resultado.json
  modified:
    - package.json
    - src/application/shadow.ts
    - src/domain/gate/patterns/automation-disclosure.ts
    - tests/application/shadow.test.ts

key-decisions:
  - "Kill switch global auditado em event_log (event_type='operational_mode_changed'), não em mode_changes (per-conversa) — D-02 'ou equivalente já existente'; decisão explícita do Admin em 2026-10-14"
  - "Limiares do gate de saída (ADR-010) como CONSTANTES (LIMIARES_PADRAO), não editáveis via settings — evita relaxamento silencioso do gate (T-02-16)"
  - "Promoção shadow→ativo NÃO aprovada em 2026-10-14: Admin selecionou manter-shadow; relatório ao vivo = FAIL com 0 evidência; ACTIVA adiada até PASS"
  - "Pós-gate determinístico (regex/L4) é a barreira; o LLM não é dono do controle de conteúdo"
  - "snapshot.ts/kill-switch.ts já computavam o kill switch (settings.operational_mode + is_active) — nenhuma alteração necessária (no-op documentado)"

patterns-established:
  - "Decisão de revisão = INSERT append-only em review_events; messages permanece imutável"
  - "Gate de saída = veredicto PASS/FAIL computado do banco; exit code 1 em FAIL; promoção exige aprovação humana explícita (D-18)"
  - "Auditoria de ação administrativa (pause/resume/ack) numa mesma transação com a mudança de estado"

requirements-completed: [CONV-07, CRM-02]

# Metrics
duration: ~1h 30m
completed: 2026-10-14
---

# Phase 2 Plan 03: Shadow Review e Gate de Saída Summary

**CLI de revisão em shadow com decisões append-only e kill switch de 1 comando, pós-gate L4 (CONV-07) validado por corpus adversário, e relatório de shadow gerado do banco com veredicto PASS/FAIL — promoção shadow→ativo NÃO aprovada (Admin escolheu `manter-shadow`; relatório = FAIL com 0 evidência).**

## Performance

- **Duration:** ~1h 30m
- **Started:** 2026-10-14T09:35:00-03:00
- **Completed:** 2026-10-14T11:00:00-03:00
- **Tasks:** 3/3
- **Files modified:** 20 (16 criados, 4 modificados)

## Accomplishments

- **CLI de revisão em shadow (D-01/D-03):** `shadow:list` lista rascunhos (`origin='ai_suggestion'`) com estado resolvido, texto e metadados de `llm_runs`; `shadow:approve/edit/discard` gravam decisão append-only em `review_events` e **nunca** fazem `UPDATE` em `messages` (contagem de linhas estável, provado por teste).
- **Kill switch global de 1 comando (D-02):** `mode pause`/`mode resume` gravam `settings.operational_mode` e uma linha append-only em `event_log` na mesma transação; o snapshot passa a computar `kill_switch_ativo` e o gate retorna `kill_switch_ativo` (provado em `tests/cli/mode.test.ts`).
- **Pós-gate de conteúdo L4 (CONV-07):** `scanPostGate` barra valor monetário, percentual/desconto/promo, termos de mídia e promessa de agenda — determinístico, **antes** de persistir o rascunho; bloqueio → `recordBlockedAttempt` + sem rascunho. Corpus adversário com **taxa de falso-negativo = 0** para padrões proibidos e contorno legítimo (`objecao_preco`) **não** bloqueado.
- **Relatório de shadow (gate de saída D-17):** `npm run shadow:report` compõe métricas do banco (`messages`, `llm_runs`, `review_events`, `handoff_events`, `optout_ledger`, `blocked_attempts`), aplica os limiares do ADR-010 e emite veredicto `PASS`/`FAIL` com motivos; CLI retorna exit code 1 em FAIL.
- **Harness de bake-off (D-10):** `npm run bake-off` avalia candidatos sobre 24 transcrições pt-BR mascaradas (offline-first) e grava veredito JSON; providers reais atrás de env keys.
- **Confirmação humana de handoff (D-15):** `handoff:ack <id>` grava `human_acknowledged_at` de forma idempotente + evento append-only em `event_log`; **não** reativa o bot.
- **Correção manual de status (CRM-02):** `status:corrigir <conv> --to <state> --reason` grava `status_history` com `changed_by='admin'`.

## Task Commits

Cada task foi commitada atomicamente:

1. **Task 1: CLI de revisão em shadow + kill switch global (1 comando)** — `0a10fd9` (feat)
2. **Task 2: Pós-gate de conteúdo (CONV-07) + corpus adversário** — `c1ad40e` (test, RED) → `4ad4514` (feat, GREEN)
3. **Task 3: Relatório de shadow (D-17) e harness de bake-off (D-10)** — `d8975d1` (feat)

**Plan metadata:** `f179ab8` (docs: complete plan) + `b0c5824` (docs: STATE/ROADMAP/REQUIREMENTS)

_Nota: a Task 2 é `tdd="true"` → 2 commits (test → feat)._

## Files Created/Modified

**Criados:**
- `src/cli/shadow.ts` — `runShadowCli(db, argv)`: list/approve/edit/discard; decisões append-only
- `src/cli/mode.ts` — `runModeCli(db, argv)`: `mode` (consulta) + `pause`/`resume`; kill switch global auditado
- `src/cli/status.ts` — `status:corrigir <conv> --to <state> --reason` via `recordStatusChange`
- `src/cli/handoff.ts` — `handoff:ack <handoffId>` idempotente + auditoria append-only (D-15)
- `src/domain/llm/post-gate.ts` — `scanPostGate(text)`: pós-gate L4 (valor/percentual/promo/mídia/agenda)
- `scripts/shadow-report.ts` — `buildShadowReport` + `avaliarVeredicto` + `formatarRelatorio` (gate D-17)
- `scripts/bake-off.ts` — `runBakeOff`, `candidatosOffline`, `carregarCandidatosReais` (harness D-10)
- `tests/cli/{shadow,status,mode,handoff-ack}.test.ts` — 4 suítes de CLI (37+ casos)
- `tests/domain/post-gate.test.ts` — comportamento do pós-gate
- `tests/adversarial/adversarial.test.ts` — corpus adversário (falso-negativo = 0)
- `tests/ops/{shadow-report,bake-off}.test.ts` — 9 + 6 testes do relatório e do bake-off
- `.planning/phases/02-ia-handoff-e-shadow-mode/bake-off-resultado.json` — evidência do bake-off

**Modificados:**
- `package.json` — scripts `shadow:list/approve/edit/discard`, `mode`, `status:corrigir`, `handoff:ack`, `shadow:report`, `bake-off`
- `src/application/shadow.ts` — texto gerado passa por `scanPostGate` antes de persistir
- `src/domain/gate/patterns/automation-disclosure.ts` — correção `MEDIA_TERM` (ver Desvio 3)
- `tests/application/shadow.test.ts` — cenário bloqueado não gera rascunho

## Decisions Made

- **Kill switch global auditado em `event_log`, não em `mode_changes`** — `mode_changes` é per-conversa (`conversation_id NOT NULL` + FK); o kill switch é global. A decisão de contexto D-02 previa "ou equivalente já existente de `mode_changes`"; o equivalente é `event_log` com `event_type='operational_mode_changed'`. Decisão explícita do Admin em 2026-10-14.
- **Limiares do gate de saída como constantes** (`LIMIARES_PADRAO`) em `scripts/shadow-report.ts`, não editáveis via `settings` — um ajuste ao vivo poderia relaxar silenciosamente o gate de saída (T-02-16). ADR-010: `minDaysOfOperation≥14`, `minSuggestionsReviewed≥100`, `minApprovalRate≥0.80`, `maxCriticalHallucinations=0`, `maxAutomationReveals=0`.
- **Promoção shadow→ativo não aprovada.** O checkpoint `decision` da Task 3 foi resolvido pelo Admin com **`manter-shadow`** (2026-10-14). O relatório ao vivo retornou **FAIL** com 0 evidência (0 dias, 0 rascunhos, 0 revisados). `ACTIVA` fica adiada até o relatório atingir PASS; nenhum caminho de código se auto-promove (D-18). O envio real não foi implementado nesta fase de qualquer forma.
- **Pós-gate determinístico é a barreira de conteúdo** (L4); o LLM gera texto, mas valor/percentual/promo/mídia/agenda são barrados por regex antes de persistir.
- **`snapshot.ts`/`kill-switch.ts` não foram alterados** — já computavam o kill switch a partir de `settings.operational_mode` + `is_active` (no-op documentado, Desvio 2).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 4 / decisão do usuário] Kill switch global auditado em `event_log`, não em `mode_changes`**
- **Found during:** Task 1 (CLI de revisão + kill switch)
- **Issue:** o plano/`key_links`/D-19 apontam para `mode_changes`, mas `mode_changes` é per-conversa (`conversation_id NOT NULL` + FK); o kill switch é global e não tem conversa associada. A decisão D-02 previa "ou equivalente já existente de `mode_changes`".
- **Fix:** a trilha append-only foi gravada em `event_log` (`event_type='operational_mode_changed'`, `entity_type='settings'`, `conversation_id=null`, `payload={from,to,actor,reason,source}`, `severity='info'`) na **mesma transação** do upsert de `settings.operational_mode`. Decisão explícita do Admin em 2026-10-14.
- **Files modified:** `src/cli/mode.ts`
- **Verification:** `tests/cli/mode.test.ts` prova a linha em `event_log` + o gate retornando `kill_switch_ativo` após `mode pause`.
- **Committed in:** `0a10fd9` (Task 1)

**2. [Já satisfeito] `snapshot.ts`/`kill-switch.ts` já computavam o kill switch**
- **Found during:** Task 1
- **Issue:** o plano listava `src/infra/db/queries/snapshot.ts` e `src/domain/gate/kill-switch.ts` em `<files>`, mas ambos já computavam `killSwitch = (NOT a.is_active) OR (settings.operational_mode='paused')`.
- **Fix:** nenhuma alteração necessária (no-op documentado); os arquivos **não** aparecem no commit da task.
- **Files modified:** (nenhum)
- **Verification:** `tests/cli/mode.test.ts` exercita o snapshot + gate pelo caminho existente.
- **Committed in:** (n/a — no-op)

**3. [Rule 1 - Bug] Correção do padrão `MEDIA_TERM` em `automation-disclosure.ts`**
- **Found during:** Task 2 (pós-gate + corpus adversário)
- **Issue:** `\b[áa]udio\b` não casava corretamente o termo em contexto pt-BR (fronteira `\b` com acento), deixando mídia passar.
- **Fix:** `\b[áa]udio\b` → `(?<!\w)[áa]udio(?!\w)`.
- **Files modified:** `src/domain/gate/patterns/automation-disclosure.ts`
- **Verification:** corpus adversário com falso-negativo = 0 para mídia.
- **Committed in:** `4ad4514` (Task 2, GREEN)

**4. [Interpretação] Mapeamento do `reason` no pós-gate**
- **Found during:** Task 2
- **Issue:** o plano citava AR-001/AR-004/R-042 sem definir o `reason` canônico por tipo de match.
- **Fix:** AR-002→proposta, AR-003→agendamento; "R-042" descartado como não-conteúdo (não é um `GateReason`).
- **Files modified:** `src/domain/llm/post-gate.ts`
- **Verification:** `tests/domain/post-gate.test.ts`.
- **Committed in:** `4ad4514` (Task 2)

**5. [Task 3] Limiares como constantes, não via `settings`**
- **Found during:** Task 3
- **Issue:** alternativa de expor `shadow_exit.*` em `settings` permitiria relaxar o gate ao vivo (T-02-16).
- **Fix:** `LIMIARES_PADRAO` como constantes; inclusivo nas bordas (`>=`/`<=` → valores exatos no limiar → PASS).
- **Files modified:** `scripts/shadow-report.ts`
- **Verification:** `tests/ops/shadow-report.test.ts` (bordas exatas).
- **Committed in:** `d8975d1` (Task 3)

**6. [Task 3] Teste extra `tests/ops/bake-off.test.ts`**
- **Found during:** Task 3
- **Issue:** o plano `<files>` não listava cobertura própria do harness de bake-off (4º arquivo além do previsto).
- **Fix:** adicionada suíte com 6 testes cobrindo `avaliarRegistro`, offline candidates e veredito.
- **Files modified:** `tests/ops/bake-off.test.ts`
- **Verification:** 6/6 verdes.
- **Committed in:** `d8975d1` (Task 3)

**7. [Task 3] Correção de doc-comment em `shadow-report.ts`**
- **Found during:** Task 3
- **Issue:** o doc-comment afirmava que todas as colunas de tempo eram `timestamptz`; `messages.created_at` é `timestamp` **sem** timezone.
- **Fix:** comentário corrigido (apenas `messages.created_at` é sem tz).
- **Files modified:** `scripts/shadow-report.ts`
- **Verification:** typecheck + testes (a leitura assume o tipo correto).
- **Committed in:** `d8975d1` (Task 3)

---

**Total deviations:** 7 (1 decisão do usuário, 1 no-op já-satisfeito, 1 bug Rule 1, 1 interpretação, 3 de Task 3)
**Impact on plan:** Todos necessários para correção/segurança/funcionamento. Sem scope creep. O plano (`02-03-PLAN.md`) **não** foi reescrito: este SUMMARY é o registro dos desvios (notadamente o `event_log` em vez de `mode_changes`).

## Phase Exit Gate (D-17 / D-18)

**Comando:** `npm run shadow:report` (2026-10-14)
**Veredicto:** **FAIL** — 0 dias de operação, 0 rascunhos, 0 revisados (aprovação sem dados < 80%).
**Limiares (ADR-010):** `minDaysOfOperation≥14`, `minSuggestionsReviewed≥100`, `minApprovalRate≥0.80`, `maxCriticalHallucinations=0`, `maxAutomationReveals=0`.
**Decisão do Admin (D-18):** **`manter-shadow`** — promoção shadow→ativo **NÃO** aprovada. `ACTIVA` adiada até o relatório atingir PASS. Nenhum caminho de código promove a si mesmo. O gate é satisfeito pela **existência do veredicto PASS/FAIL computado + teste de borda**, não pela ativação.

## Issues Encountered

- `npm run shadow:report` sobre o banco atual retorna **FAIL** (0 evidência) — esperado: não há dias de operação em shadow acumulados. Não é um defeito; é o gate funcionando (exit code 1).

## User Setup Required

None — sem configuração de serviço externo. `npm run bake-off` opera offline por padrão; providers reais exigem env keys (opcional).

## Next Phase Readiness

- Fase 2 concluída em termos de implementação (3/3 planos). O sistema rascunha em shadow, respeita fronteiras, faz handoff e produz o veredicto de saída — **sem enviar nada ao número**.
- **Bloqueio de continuidade:** a promoção shadow→ativo depende de **dados reais de operação** (≥14 dias, ≥100 rascunhos revisados, ≥80% aprovação, 0 alucinação crítica, 0 revelação de automação). Enquanto o relatório for FAIL, o modo permanece `shadow`.
- **P-004 segue aberto:** o pareamento do número dedicado (01-03) não foi concluído (`CREDS_INVALID`); `CHANNEL_PHONE_E164` ainda é o placeholder `+5511999999999`.
- Pronto para a Fase 3 (Cadência, Operação e Painel), que constrói o painel único (R-046) sobre a CLI-first entregue aqui.

## Self-Check

- [x] `scripts/shadow-report.ts` existe (verificado via commit `d8975d1` e `npm run shadow:report`)
- [x] `scripts/bake-off.ts` existe (verificado via commit `d8975d1` e `npm run bake-off`)
- [x] `src/domain/llm/post-gate.ts` existe (commit `4ad4514`)
- [x] `src/cli/shadow.ts`, `src/cli/mode.ts`, `src/cli/status.ts`, `src/cli/handoff.ts` existem (commit `0a10fd9`)
- [x] Commits `0a10fd9`, `c1ad40e`, `4ad4514`, `d8975d1` presentes em `git log`
- [x] Suíte verde: 49 arquivos / 268 testes; `npm run typecheck` limpo; `npm run lint` 0 erros (33 warnings pré-existentes)

**Self-Check: PASSED**

---
*Phase: 02-ia-handoff-e-shadow-mode*
*Completed: 2026-10-14*
