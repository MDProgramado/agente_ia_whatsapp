---
phase: 02-ia-handoff-e-shadow-mode
verified: 2026-10-14T13:45:00Z
status: human_needed
re_verification: true
score: 24/24
overrides_applied: 0
re_verification_report:
  previous_status: gaps_found
  previous_score: 16/24
  gaps_closed:
    - "CR-01 (CONV-01/R-002) — Guard 0 do primeiro contato humano agora compara o EMISSOR E.164 (`senderPhoneE164`), nao o `chatId`"
    - "CR-02 (FLUP-09/R-065) — `duvida_complexa` incluido em `INTENCOES_HANDOFF` com e2e atomico e silencio total"
    - "Truth 17 — Admin first message → aquecimento (fromMe no numero dedicado)"
    - "Truth 18 — duvida_complexa dispara handoff"
    - "Truth 19 — transicao adminPrimeiraMensagem efetiva end-to-end (novo → aquecimento)"
    - "Truth 20 — duvida_complexa → dispararHandoff fiado end-to-end"
    - "Truth 21 — mapeamento de handoff do inbound cobre todos os intents exigidos"
    - "Truth 22 — silencio total apos handoff em duvida_complexa"
    - "Truth 23 — adminPrimeiraMensagem produz novo→aquecimento com engagement_mode bot_active"
    - "Truth 24 — duvida complexa produz handoff_events+mode_changes+awaiting_human (atomico)"
  gaps_remaining: []
  regressions: []
must_haves:
  source_plans:
    - 02-01-PLAN.md
    - 02-02-PLAN.md
    - 02-03-PLAN.md
    - 02-04-PLAN.md
human_verification:
  - test: "No pareamento real do numero dedicado (P-004), registrar qual forma o `sock.user.id` assume (E.164 em `@s.whatsapp.net` vs LID em `@lid`) e, com o bot em `shadow`, enviar manualmente a 1a mensagem ao lead: observar se `leads.first_contact_by_human` vira `true` e a conversa sai de `novo` para `aquecimento`."
    expected: "`normalizeJid(sock.user.id).e164` nao-nulo (forma E.164) e a 1a mensagem manual do Admin seta `first_contact_by_human=true` + `novo`→`aquecimento`. Se o id proprio for LID, o boot emite 1x `jid_proprio_sem_e164` e o Guard 0 fica fail-closed (nenhuma transicao) — pareamento precisa ser resolvido antes do shadow valer."
    why_human: "Somente um pareamento real com o WhatsApp revela a forma do id proprio. Os testes injetam um `canalSelfJid` fixo em forma E.164 e, por construcao, NAO cobrem o ramo LID — que e exatamente a classe do bug CR-01."
verified_trues:
  - truth: "Rascunho append-only em messages(origin='ai_suggestion', status='suggested') + llm_runs (shadow path persists draft)"
    status: verified
    evidence:
      - path: "src/application/shadow.ts"
        detail: "persistDraft inserts into messages with origin='ai_suggestion', status='suggested'; also records llm_run in same flow"
  - truth: "FSM pure resolveNextState with ALLOWED covering 9 states; guards can override hint"
    status: verified
    evidence:
      - path: "src/domain/orchestrator/transitions.ts"
        detail: "ALLOWED covers states; rules (opt-out/handoff/adminPrimeiraMensagem/verba+decisao) evaluated before hint acceptance"
  - truth: "Envelope Zod with canary and pedido_preco != objecao_preco"
    status: verified
    evidence:
      - path: "src/domain/llm/envelope.ts"
        detail: "canary field present; intent enum separates pedido_preco and objecao_preco"
  - truth: "PII masking choke-point: prompt-builder masks telefone+endereço in context/history/last message/admin first message; name kept"
    status: verified
    evidence:
      - path: "src/domain/llm/prompt-builder.ts"
        detail: "maskPii covers payloads; buildExtractPrompt/buildGeneratePrompt consume masked payloads"
  - truth: "LlmPort trocável (two tiers extract/generate) + scripted adapter offline"
    status: verified
    evidence:
      - path: "src/domain/ports/LlmPort.ts"
        detail: "contract pure (no ai/sdk import)"
      - path: "src/infra/llm/scripted-adapter.ts"
        detail: "deterministic adapter implements LlmPort"
  - truth: "Migration 0006 destrava shadow: CHECK accepts 'shadow'; llm_runs/review_events append-only"
    status: verified
    evidence:
      - path: "src/infra/db/migrations/0006_shadow_and_llm_runs.sql"
        detail: "'shadow' added to CHECKs; llm_runs and review_events created with append-only constraints/triggers per plan"
  - truth: "Opt-out matcher is authority (FORTE/AMBIGUO/NAO); FORTE → opt_out irreversível + ledger; AMBIGUO → handoff"
    status: verified
    evidence:
      - path: "src/domain/optout/optout-matcher.ts"
        detail: "classifyOptout returns FORTE/AMBIGUO/NAO; FORTE mapped to applyOptOut (opt_out + optout_ledger)"
  - truth: "Handoff atomic in one transaction: handoff_events + mode_changes + conversations(engagement_mode='awaiting_human', handoff_active=true, state) + status_history"
    status: verified
    evidence:
      - path: "src/application/handoff-service.ts"
        detail: "single db.transaction writes all four pieces; idempotent if already handoff_active"
  - truth: "Silence total after handoff; notification (som+pop-up) fired, never throws (best-effort)"
    status: verified
    evidence:
      - path: "src/application/handoff-service.ts"
        detail: "notification outside transaction, wrapped in try/catch; no outbound created on handoff path"
  - truth: "Mídia recebida triggers handoff via same HandoffService"
    status: verified
    evidence:
      - path: "src/application/inbound-handler.ts"
        detail: "registrarMidiaRecebida uses dispararHandoff with media trigger"
  - truth: "Post-gate L4 blocks valor/percentual/promo/mídia/agenda before persisting draft (CONV-07)"
    status: verified
    evidence:
      - path: "src/domain/llm/post-gate.ts"
        detail: "scanPostGate returns blocked with reason for prohibited content; shadow.ts calls scanPostGate before insert"
  - truth: "CLI shadow:* decisions append-only in review_events (no UPDATE to messages)"
    status: verified
    evidence:
      - path: "src/cli/shadow.ts"
        detail: "approve/edit/discard call recordReviewEvent; no messages UPDATE"
  - truth: "Kill switch global: mode pause/resume writes settings.operational_mode + append-only event_log (operational_mode_changed); snapshot computes kill_switch_ativo and gate returns it"
    status: verified
    evidence:
      - path: "src/cli/mode.ts"
        detail: "pause/resume upsert settings.operational_mode and insert append-only event_log with event_type='operational_mode_changed'"
      - path: "src/infra/db/queries/snapshot.ts"
        detail: "computes killSwitch from settings.operational_mode and channel_accounts.is_active"
      - path: "src/domain/gate/kill-switch.ts"
        detail: "gate observes kill_switch_ativo"
  - truth: "status:corrigir writes status_history with changed_by='admin'"
    status: verified
    evidence:
      - path: "src/cli/status.ts"
        detail: "calls recordStatusChange with changed_by='admin'"
  - truth: "handoff:ack sets handoff_events.human_acknowledged_at (idempotent) + append-only event_log; does not reactivate bot"
    status: verified
    evidence:
      - path: "src/cli/handoff.ts"
        detail: "UPDATE sets human_acknowledged_at only if NULL (idempotent); inserts event_log append-only; no bot reactivation"
  - truth: "Shadow report generated from DB with metrics and verdict PASS/FAIL (D-17)"
    status: verified
    evidence:
      - path: "scripts/shadow-report.ts"
        detail: "buildShadowReport reads DB tables (messages/llm_runs/review_events/handoff_events/optout_ledger/blocked_attempts) and computes verdict with thresholds"
  - truth: "CONV-01/R-002: Bot assumes conversation when Admin sends 1st message (fromMe on dedicated number) so state becomes aquecimento"
    status: verified
    evidence:
      - path: "src/application/inbound-handler.ts"
        detail: "deveMarcarPrimeiroContatoHumano (120-128) compara `senderPhoneE164 === channelPhoneE164` (fail-closed); call site 621-628 passa `evt.senderPhoneE164`; 636-660 dispara `novo`→`aquecimento` via `resolveNextState(..., {adminPrimeiraMensagem:true})` com UPDATE+recordStatusChange numa transacao unica (WR-03)"
      - path: "src/channel/baileys/runtime.ts"
        detail: "criarEventoInbound(m, canalSelfJid?) carimba `senderPhoneE164` (109-114): fromMe → normalizeJid(canalSelfJid).e164; senao → normalizeJid(chatId).e164"
      - path: "src/index.ts"
        detail: "boot fia `canalSelfJid: () => sock.user?.id` (275) e emite 1x `jid_proprio_sem_e164` no ramo LID (278-288)"
      - path: "tests/application/inbound-fromme.test.ts"
        detail: "Teste A (unescaped) + property test sobre a funcao REAL + Teste F composicional WAMessage→criarEventoInbound→processInboundFromMe"
  - truth: "FLUP-09/R-065: duvida_complexa triggers handoff (silence + handoff)"
    status: verified
    evidence:
      - path: "src/application/inbound-handler.ts"
        detail: "INTENCOES_HANDOFF (82-91) inclui 'duvida_complexa'"
      - path: "tests/application/handoff-intents.test.ts"
        detail: "teste de CONTRATO sobre o conjunto real + Teste 2 e2e"
  - truth: "CONV-01/R-002: FSM guard adminPrimeiraMensagem path effective end-to-end (novo → aquecimento)"
    status: verified
    evidence:
      - path: "src/application/inbound-handler.ts"
        detail: "638-660: estadoAdmin = resolveNextState(conversa.state, undefined, {adminPrimeiraMensagem:true}); UPDATE de state + recordStatusChange atômicos"
      - path: "tests/application/inbound-fromme.test.ts"
        detail: "Teste F encadeia WAMessage(fromMe=true)→criarEventoInbound(canalSelfJid)→processInboundFromMe e assere flag + 'novo'→'aquecimento'"
  - truth: "Handoff on duvida_complexa is wired end-to-end (detected → dispararHandoff)"
    status: verified
    evidence:
      - path: "src/application/inbound-handler.ts"
        detail: "INTENCOES_HANDOFF contem duvida_complexa; Camada 2 mapeia intent→dispararHandoff"
      - path: "tests/application/handoff-intents.test.ts"
        detail: "Teste 2: deps.llm = scriptedLlmAdapter({intent:'duvida_complexa'}) → handoff_events(triggered_by='intent', trigger_value='duvida_complexa')"
  - truth: "Inbound applies handoff triggers by code mapping for all required intents (pedido_preco, intencao_agendar, bot_suspicion, irritacao, ameaca, pedido_optout, midia_recebida, duvida_complexa)"
    status: verified
    evidence:
      - path: "src/application/inbound-handler.ts"
        detail: "INTENCOES_HANDOFF (82-91) contem os 8 intents exigidos"
      - path: "tests/application/handoff-intents.test.ts"
        detail: "teste de contrato falha se qualquer um dos 8 for omitido"
  - truth: "Silence total after handoff on duvida_complexa (no outbound)"
    status: verified
    evidence:
      - path: "tests/application/handoff-intents.test.ts"
        detail: "Teste 2 assere 0 linhas com origin='ai_suggestion' e llm.chamadas === ['extract'] (generate NUNCA chamado — silencio D-13)"
      - path: "src/application/handoff-service.ts"
        detail: "caminho de handoff nao cria outbound"
  - truth: "adminPrimeiraMensagem transition produces novo → aquecimento with engagement_mode intact (bot_active)"
    status: verified
    evidence:
      - path: "src/application/inbound-handler.ts"
        detail: "636-660: transicao so muda `state` (novo→aquecimento); `engagement_mode` nao e tocado pela transicao do Admin"
      - path: "tests/application/inbound-fromme.test.ts"
        detail: "Teste A/F asserem engagement_mode='bot_active' apos a 1a mensagem do Admin"
  - truth: "End-to-end: complex doubt produces handoff_events + mode_changes + awaiting_human (atomic)"
    status: verified
    evidence:
      - path: "tests/application/handoff-intents.test.ts"
        detail: "Teste 2 assere 1 handoff_event + 1 mode_change(to_mode='awaiting_human') + conversations(engagement_mode='awaiting_human', handoff_active=true, state='awaiting_human')"
      - path: "src/application/handoff-service.ts"
        detail: "escrita atomica numa unica transacao"
---

# Phase 02: IA, Handoff e Shadow Mode — Verification Report

**Phase Goal:** "O bot rascunha conversas consultivas, qualifica, respeita todas as fronteiras e para no instante exato em que o humano precisa assumir - tudo validado em shadow mode, sem tocar no número dedicado."

**Verified:** 2026-10-14T13:45:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (02-04)
**Score:** 24/24 must-haves verified (0 FAILED; 8 previously-failed truths now closed)

## Re-verification Scope

This pass re-verifies the 8 truths that FAILED on 2026-10-14T12:48:00Z (all traced to CR-01 and CR-02), against the CURRENT codebase after gap-closure plan `02-04`. Prior passing truths 1-16 were re-checked for regressions (quick pass — unchanged).

## CRITICAL FINDINGS — NOW RESOLVED

### CR-01: Guard 0 / first human contact (was BLOCKER) — RESOLVED
- **Verdict:** FIXED — code + tests + commits present.
- **Evidence (exact):**
  - `src/application/inbound-handler.ts:120-128` — `deveMarcarPrimeiroContatoHumano` now compares the **emitter**: `fromMe===true` AND `senderPhoneE164 === channelPhoneE164`; missing emitter → `false` (fail-closed, R-001).
  - `src/application/inbound-handler.ts:621-628` — the call site passes `senderPhoneE164: evt.senderPhoneE164` (no longer `chatId`).
  - `src/application/inbound-handler.ts:636-660` — `novo → aquecimento` via `resolveNextState(conversa.state, undefined, { adminPrimeiraMensagem: true })`, state UPDATE + `recordStatusChange(changedBy:'admin')` in a single transaction (WR-03).
  - `src/channel/baileys/runtime.ts:109-114` — `criarEventoInbound(m, canalSelfJid?)` stamps `senderPhoneE164` (`fromMe` → `normalizeJid(canalSelfJid).e164`; else → `normalizeJid(chatId).e164`; no `canalSelfJid` → `undefined`).
  - `src/index.ts:275` — boot wires `canalSelfJid: () => sock.user?.id`.
- **Tests:** `tests/application/inbound-fromme.test.ts` — Test A + property test on the REAL function + **Teste F composicional** (`WAMessage→criarEventoInbound→processInboundFromMe`), the exact CR-01 class. GREEN.
- **Commits:** `aacaa69` (fix), RED precedes GREEN.

### CR-02: duvida_complexa handoff (was BLOCKER) — RESOLVED
- **Verdict:** FIXED — code + tests + commits present.
- **Evidence (exact):**
  - `src/application/inbound-handler.ts:82-91` — `INTENCOES_HANDOFF` now contains all 8 intents incl. `"duvida_complexa"` (R-065/FLUP-09).
- **Tests:** `tests/application/handoff-intents.test.ts` — contract test on the REAL set + Teste 2 e2e (atomic handoff + total silence, `generate` never called). GREEN.
- **Commits:** `2e3c56d` (fix), RED at `0a51cc5` precedes GREEN.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Rascunho append-only em messages(origin='ai_suggestion', status='suggested') + llm_runs | ✓ VERIFIED | `src/application/shadow.ts` — persistDraft inserts ai_suggestion/suggested and records llm_run |
| 2 | FSM pure resolveNextState; guards override hint; ALLOWED covers 9 states | ✓ VERIFIED | `src/domain/orchestrator/transitions.ts` — rules before hint acceptance |
| 3 | Envelope Zod with canary; pedido_preco != objecao_preco | ✓ VERIFIED | `src/domain/llm/envelope.ts` — canary + distinct intent values |
| 4 | PII masking choke-point (telefone+endereço masked; name kept) | ✓ VERIFIED | `src/domain/llm/prompt-builder.ts` — maskPii covers payloads |
| 5 | LlmPort two tiers + scripted adapter offline | ✓ VERIFIED | `src/domain/ports/LlmPort.ts`, `src/infra/llm/scripted-adapter.ts` |
| 6 | Migration 0006: shadow in CHECK; llm_runs/review_events append-only | ✓ VERIFIED | `src/infra/db/migrations/0006_shadow_and_llm_runs.sql` |
| 7 | Opt-out matcher authority (FORTE/AMBIGUO/NAO); FORTE→irreversible+ledger; AMBIGUO→handoff | ✓ VERIFIED | `src/domain/optout/optout-matcher.ts` |
| 8 | Handoff atomic (handoff_events + mode_changes + conversations awaiting_human/handoff_active + status_history) | ✓ VERIFIED | `src/application/handoff-service.ts` — single transaction, idempotent |
| 9 | Silence total after handoff; notification (som+pop-up) best-effort | ✓ VERIFIED | `src/application/handoff-service.ts` — notify outside tx, try/catch |
| 10 | Mídia recebida triggers handoff via same service | ✓ VERIFIED | `src/application/inbound-handler.ts` — registrarMidiaRecebida uses dispararHandoff |
| 11 | Post-gate L4 blocks prohibited content before persisting draft (CONV-07) | ✓ VERIFIED | `src/domain/llm/post-gate.ts`, `src/application/shadow.ts` calls scanPostGate |
| 12 | CLI shadow:* decisions append-only in review_events; no messages UPDATE | ✓ VERIFIED | `src/cli/shadow.ts` — recordReviewEvent only |
| 13 | Kill switch global wired to gate as kill_switch_ativo (audit in event_log) | ✓ VERIFIED | `src/cli/mode.ts`, `src/infra/db/queries/snapshot.ts`, `src/domain/gate/kill-switch.ts` |
| 14 | status:corrigir writes status_history with changed_by='admin' (CRM-02) | ✓ VERIFIED | `src/cli/status.ts` |
| 15 | handoff:ack sets human_acknowledged_at idempotently + append-only event_log; no bot reactivation (D-15) | ✓ VERIFIED | `src/cli/handoff.ts` |
| 16 | Shadow report from DB with metrics and PASS/FAIL verdict (D-17) | ✓ VERIFIED | `scripts/shadow-report.ts` |
| 17 | CONV-01/R-002: Admin first message → aquecimento (fromMe on dedicated number) | ✓ VERIFIED (was FAILED) | inbound-handler.ts:120-128 (emitter predicate) + :621-628 (call site) + :636-660 (novo→aquecimento, atomic); runtime.ts:109-114 (stamp); index.ts:275 (wiring); `inbound-fromme.test.ts` Test A/F |
| 18 | FLUP-09/R-065: duvida_complexa triggers handoff | ✓ VERIFIED (was FAILED) | inbound-handler.ts:82-91 (set includes `duvida_complexa`); `handoff-intents.test.ts` |
| 19 | adminPrimeiraMensagem transition effective end-to-end (novo → aquecimento) | ✓ VERIFIED (was FAILED) | inbound-handler.ts:638-660; `inbound-fromme.test.ts` Teste F composicional |
| 20 | duvida_complexa → dispararHandoff wired end-to-end | ✓ VERIFIED (was FAILED) | inbound-handler.ts:82-91 + Camada 2 mapping; `handoff-intents.test.ts` Teste 2 |
| 21 | Inbound handoff trigger mapping includes all required intents (incl. duvida_complexa) | ✓ VERIFIED (was FAILED) | inbound-handler.ts:82-91 (8 intents); contract test |
| 22 | Silence total after handoff on duvida_complexa | ✓ VERIFIED (was FAILED) | `handoff-intents.test.ts` Teste 2 (0 ai_suggestion; generate never called) |
| 23 | adminPrimeiraMensagem produces novo→aquecimento with engagement_mode bot_active | ✓ VERIFIED (was FAILED) | inbound-handler.ts:636-660 (state only; engagement_mode untouched); `inbound-fromme.test.ts` |
| 24 | Complex doubt produces handoff_events+mode_changes+awaiting_human (atomic) | ✓ VERIFIED (was FAILED) | `handoff-intents.test.ts` Teste 2; handoff-service.ts single transaction |

**Score:** 24/24 truths verified (8 previously FAILED → now VERIFIED; 0 regressions in truths 1-16)

## Required Artifacts (key presence)
- FSM/orchestrator: `src/domain/orchestrator/transitions.ts` — ✓
- LLM contracts: `src/domain/ports/LlmPort.ts`, `src/domain/llm/envelope.ts`, `src/domain/llm/prompt-builder.ts` — ✓
- Adapters: `src/infra/llm/scripted-adapter.ts`, `src/infra/llm/ai-sdk-adapter.ts` — ✓
- Shadow: `src/application/shadow.ts` — ✓
- DB migration/queries: `src/infra/db/migrations/0006_shadow_and_llm_runs.sql`, `src/infra/db/queries/{llm-runs,review-events,llm-context,status-history,leads,snapshot}.ts` — ✓
- Opt-out/handoff: `src/domain/optout/optout-matcher.ts`, `src/application/handoff-service.ts` — ✓
- Post-gate: `src/domain/llm/post-gate.ts` — ✓
- CLI: `src/cli/shadow.ts`, `src/cli/mode.ts`, `src/cli/status.ts`, `src/cli/handoff.ts` — ✓
- Scripts: `scripts/shadow-report.ts`, `scripts/bake-off.ts` — ✓
- 02-04 gap-closure surface: `src/application/event-bus.ts` (`EventoInbound.senderPhoneE164`), `src/channel/baileys/runtime.ts` (`criarEventoInbound` stamp), `src/application/inbound-handler.ts` (emitter predicate + `INTENCOES_HANDOFF`), `src/index.ts` (`canalSelfJid` wiring + LID warn) — ✓

## Key Link Verification (highlights)
- shadow.ts → messages (ai_suggestion/suggested): ✓
- inbound-handler → prompt-builder (masking before extract/generate): ✓
- handoff-service → handoff_events+mode_changes+conversations in one transaction: ✓
- CLI shadow → review_events append-only: ✓
- CLI mode → event_log operational_mode_changed + settings.operational_mode wired to gate: ✓
- **runtime.ts → inbound-handler (emitter stamp → Guard 0 predicate):** ✓ (CR-01 close) — `runtime.ts:109-114/163` stamps `senderPhoneE164`; `inbound-handler.ts:120-128/621-628` consumes it.
- **inbound-handler → handoff-service for `duvida_complexa`:** ✓ (CR-02 close) — set membership at `:82-91`, mapping to `dispararHandoff`.

## Data-Flow Trace (Level 4) — Guard 0 first-contact path
| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `inbound-handler.ts` (Guard 0) | `senderPhoneE164` | `runtime.ts` `criarEventoInbound` from `sock.user.id` (boot getter) for `fromMe`; else `remoteJid` | Yes when `sock.user.id` resolves to E.164 | ✓ FLOWING (tests) / ? HUMAN at real pairing |

> The `fromMe` branch is fed by `normalizeJid(canalSelfJid).e164`. Tests inject an E.164-shaped `canalSelfJid`. In production this value depends on the real pairing form (see Human Verification). The LID branch is fail-closed with a one-time warn.

## Behavioral Spot-Checks
| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Guard 0 + emitter stamp + handoff-intent contract | `npx vitest run tests/application/inbound-fromme.test.ts tests/channel/evento-inbound.test.ts tests/application/handoff-intents.test.ts` | 3 files / 16 tests passed | ✓ PASS |
| Full suite (regression) | `npm test` | 51 files / 274 tests passed | ✓ PASS |

## Probe Execution
No phase-declared probes found (`scripts/*/tests/probe-*.sh` absent; no probe references in PLAN/SUMMARY). Skipped.

## Requirements Coverage (Phase 2 set)
Requirements from plans: OPRE-04, OPRE-05, LEAD-05, LEAD-06, CONV-01–CONV-10, CONV-12, FLUP-04, FLUP-05, FLUP-07, FLUP-09, FLUP-10, CRM-02, COMP-01, NFRQ-03.
- **Satisfied by code (evidence in truths 1-24):** OPRE-04, OPRE-05, LEAD-05, LEAD-06, CONV-01–CONV-10, CONV-12, FLUP-04, FLUP-05, FLUP-07, FLUP-09, FLUP-10, CRM-02, COMP-01, NFRQ-03.
- **Previously blocked, now wired:** CONV-01 (Guard 0/emitter) and FLUP-09 (duvida_complexa mapping) — both closed by 02-04.
- **No orphaned requirements** for Phase 2 (all declared IDs appear in a plan's `requirements`).

## Anti-Patterns Found
- No debt markers (`TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER`) in the 02-04-modified files. (The single grep hit was the Portuguese word "todos" in an `event-bus.ts` comment — not a marker.)
- No stubs/placeholder returns in the modified surface. Guard 0 is fail-closed by design (not a stub). `deps.llm` gating is intentional (see Informational note).

## Informational (not a gap) — LLM not wired at the production boot
`src/index.ts:221-223` calls `processInboundFromMe(conn.db, sock, evt)` with **no `deps`**, so `deps.llm` is `undefined` in the live boot and the running process does not produce `ai_suggestion` drafts (`inbound-handler.ts:693` gates the shadow sandwich on `deps.llm`). Drafts are produced only when an `LlmPort` is injected (tests, `scripts/bake-off.ts`, and the CLI path). This is consistent with (a) `02-01-PLAN.md` `user_setup` — "o LLM é **opcional** nesta fase; a fase roda inteira no `ScriptedLlmAdapter`", and (b) the accepted state "no shadow operation yet" (D-18). It was NOT among this phase's must-have truths and is not a CR. **Flag for the shadow-operation/deployment step:** wire an `LlmPort` (bake-off winner) into the boot before the D-18 shadow gate can accumulate ≥14 days / ≥100 drafts.

## Exit Gate Note (ACCEPTED)
Phase 2 exit is D-17/D-18 (shadow report from DB with PASS/FAIL; promotion shadow→active requires explicit Admin approval). Current `shadow:report` returns FAIL with 0 evidence; Admin selected `manter-shadow`. This is the **ACCEPTED outcome per plan/checkpoint**, not a verification gap.

## Gaps Summary
No gaps remain. Both root causes are closed in code, covered by tests, and committed:
1. **CR-01 (CONV-01/R-002)** — Guard 0 now compares the dedicated-number **emitter** E.164 (`senderPhoneE164`, stamped by the runtime) instead of `chatId`; Admin's first manual message sets `first_contact_by_human` and drives `novo → aquecimento` (atomic). `aacaa69`.
2. **CR-02 (FLUP-09/R-065)** — `duvida_complexa` is in `INTENCOES_HANDOFF`, with atomic e2e handoff + total silence. `2e3c56d`.

All 8 previously-failed truths (17-24) are now VERIFIED. Truths 1-16 show no regressions.

## Human Verification Required
1. **Real pairing (P-004) — emitter form for Guard 0**
   - **Test:** On the real dedicated number pairing, record the form of `sock.user.id` (E.164 `@s.whatsapp.net` vs LID `@lid`); with the bot in `shadow`, send the first manual Admin message to a lead and observe `leads.first_contact_by_human` and the conversation `state`.
   - **Expected:** `normalizeJid(sock.user.id).e164` non-null → `first_contact_by_human=true` and `novo → aquecimento`. If LID: the boot logs exactly one `jid_proprio_sem_e164` and Guard 0 stays fail-closed (no transition) — pairing must be resolved before shadow is meaningful.
   - **Why human:** Only a real WhatsApp pairing reveals the id form. Tests inject a fixed E.164-shaped `canalSelfJid` and by construction do not exercise the LID branch — the exact CR-01 class.

---

_Verified: 2026-10-14T13:45:00Z_
_Verifier: goal-backward verification (gsd-verifier)_
