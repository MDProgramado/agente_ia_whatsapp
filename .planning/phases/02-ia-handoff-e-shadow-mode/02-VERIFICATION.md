---
phase: 02-ia-handoff-e-shadow-mode
verified: 2026-10-14T12:48:00Z
status: gaps_found
re_verification: false
score: 16/24
overrides_applied: 0
must_haves:
  source_plans:
    - 02-01-PLAN.md
    - 02-02-PLAN.md
    - 02-03-PLAN.md
gaps:
  - truth: "CONV-01/R-002: Bot assumes conversation when Admin sends 1st message (fromMe on dedicated number) so state becomes aquecimento"
    status: failed
    reason: "deveMarcarPrimeiroContatoHumano compares chatId (remoteJid = lead JID) with CHANNEL_PHONE_E164; equality never true → first_contact_by_human never set. Guard 0 blocks the planned transition."
    artifacts:
      - path: "src/application/inbound-handler.ts"
        issue: "lines 106-114: chatId === channelPhoneE164 fails when chatId is lead's JID"
      - path: "src/channel/baileys/runtime.ts"
        issue: "lines 82-103: criarEventoInbound sets chatId = m.key.remoteJid (lead JID), not the channel number"
    missing:
      - "Fix: detect admin first message by checking fromMe==true AND the message is from/to context consistent with channel, or use another signal (e.g. compare to the channel JID forms) so Guard 0 becomes true when Admin sends first message on dedicated number"
  - truth: "FLUP-09/R-065: duvida_complexa triggers handoff (silence + handoff)"
    status: failed
    reason: "INTENCOES_HANDOFF set omits 'duvida_complexa'; intent duvida_complexa from LLM will not trigger dispararHandoff via that mapping"
    artifacts:
      - path: "src/application/inbound-handler.ts"
        issue: "lines 74-83: INTENCOES_HANDOFF missing 'duvida_complexa'"
    missing:
      - "Add 'duvida_complexa' to INTENCOES_HANDOFF so complex doubt triggers handoff as specified"
  - truth: "CONV-01/R-002: FSM guard adminPrimeiraMensagem path effective end-to-end (novo → aquecimento)"
    status: failed
    reason: "FSM has ctx.adminPrimeiraMensagem handling in resolveNextState (02-01), but inbound path cannot set adminPrimeiraMensagem to true due to CR-01; effective behavior blocked"
    artifacts:
      - path: "src/application/inbound-handler.ts"
        issue: "adminPrimeiraMensagem transition depends on Guard 0 being true"
      - path: "src/domain/orchestrator/transitions.ts"
        issue: "FSM rule exists but not reachable via inbound in current wiring"
    missing:
      - "Fix Guard 0 detection so adminPrimeiraMensagem is set when Admin sends first message"
  - truth: "Handoff on duvida_complexa is wired end-to-end (detected → dispararHandoff)"
    status: failed
    reason: "Mapping missing; even if LLM returns duvida_complexa, code path does not fire handoff"
    artifacts:
      - path: "src/application/inbound-handler.ts"
        issue: "intent handoff mapping excludes duvida_complexa"
    missing:
      - "Wire duvida_complexa to handoff (add to set and ensure mapping uses same enum values)"
  - truth: "Inbound applies handoff triggers by code mapping for all required intents (pedido_preco, intencao_agendar, bot_suspicion, irritacao, ameaca, pedido_optout, midia_recebida, duvida_complexa)"
    status: failed
    reason: "duvida_complexa missing from handoff trigger set"
    artifacts:
      - path: "src/application/inbound-handler.ts"
        issue: "lines 74-83"
    missing:
      - "Include duvida_complexa"
  - truth: "Silence total after handoff on duvida_complexa (no outbound)"
    status: failed
    reason: "Cannot be verified as achieved because trigger not wired; behavior unobservable"
    artifacts:
      - path: "src/application/inbound-handler.ts"
        issue: "handoff trigger mapping incomplete"
    missing:
      - "Wire trigger first; then verify silence path"
  - truth: "adminPrimeiraMensagem transition produces novo → aquecimento with engagement_mode intact (bot_active)"
    status: failed
    reason: "Reachability blocked by CR-01"
    artifacts:
      - path: "src/application/inbound-handler.ts"
        issue: "Guard 0 never true in current chatId/channel comparison"
    missing:
      - "Fix Guard 0 detection"
  - truth: "End-to-end: complex doubt produces handoff_events + mode_changes + awaiting_human (atomic)"
    status: failed
    reason: "Trigger not wired → cannot produce handoff from duvida_complexa"
    artifacts:
      - path: "src/application/handoff-service.ts"
        issue: "atomic handoff implementation exists but not invoked for duvida_complexa"
    missing:
      - "Add duvida_complexa to trigger mapping"

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
---

# Phase 02: IA, Handoff e Shadow Mode — Verification Report

**Phase Goal:** "O bot rascunha conversas consultivas, qualifica, respeita todas as fronteiras e para no instante exato em que o humano precisa assumir - tudo validado em shadow mode, sem tocar no número dedicado."

**Verified:** 2026-10-14T12:48:00Z  
**Status:** gaps_found  
**Re-verification:** No — initial verification  
**Score:** 16/24 must-haves verified (8 FAILED)

## CRITICAL FINDINGS (from advisory review) — CONFIRMED/REFUTED

### CR-01: Guard 0 / first human contact (BLOCKER)
- **Verdict:** CONFIRMED — BLOCKER
- **Evidence (exact):**
  - `src/application/inbound-handler.ts:106–114` — `deveMarcarPrimeiroContatoHumano` compares `chatId === channelPhoneE164`. 
  - `src/channel/baileys/runtime.ts:82–103` — `criarEventoInbound` sets `chatId = m.key.remoteJid` (recipient JID is the lead when `fromMe=true`), so equality is never true.
- **Impact:** `first_contact_by_human` is never set. Guard 0 blocks outbound in production; the planned transition `novo → aquecimento` on Admin’s first message is not achieved by current code. Maps to CONV-01/R-002.

### CR-02: duvida_complexa handoff (BLOCKER)
- **Verdict:** CONFIRMED — BLOCKER
- **Evidence (exact):**
  - `src/application/inbound-handler.ts:74–83` — `INTENCOES_HANDOFF` set is missing `"duvida_complexa"`.
- **Impact:** Complex doubt (intent `duvida_complexa` exists in envelope) will not trigger `dispararHandoff` via that mapping → handoff on complex doubt not wired. Maps to FLUP-09/R-065.

## Kill switch deviation (assessed)
- **Deviation:** Global kill switch audit is recorded in `event_log` (event `operational_mode_changed`) instead of `mode_changes` (which is per-conversation, `conversation_id NOT NULL`).
- **Assessment:** ACCEPTED by design (explicit user decision context). 
- **Must-have status:** SATISFIED.
- **Evidence (exact):**
  - `src/cli/mode.ts` — pause/resume upsert `settings.operational_mode` and insert append-only `event_log` with `event_type='operational_mode_changed'` in same transaction.
  - `src/infra/db/queries/snapshot.ts` — computes `killSwitch` from `settings.operational_mode` and `channel_accounts.is_active`.
  - `src/domain/gate/kill-switch.ts` — gate observes `kill_switch_ativo` and returns it.
- **Conclusion:** Underlying must-have (global, reversible, audited kill switch wired to gate as `kill_switch_ativo`) is satisfied.

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
| 17 | CONV-01/R-002: Admin first message → aquecimento (fromMe on dedicated number) | ✗ FAILED | CR-01: Guard 0 chatId vs channelPhoneE164 never true (inbound-handler:106-114; runtime:82-103) |
| 18 | FLUP-09/R-065: duvida_complexa triggers handoff | ✗ FAILED | CR-02: INTENCOES_HANDOFF missing 'duvida_complexa' (inbound-handler:74-83) |
| 19 | adminPrimeiraMensagem transition effective end-to-end (novo → aquecimento) | ✗ FAILED | blocked by CR-01 |
| 20 | duvida_complexa → dispararHandoff wired end-to-end | ✗ FAILED | trigger mapping incomplete (CR-02) |
| 21 | Inbound handoff trigger mapping includes all required intents (incl. duvida_complexa) | ✗ FAILED | missing duvida_complexa (CR-02) |
| 22 | Silence total after handoff on duvida_complexa | ✗ FAILED | trigger not wired |
| 23 | adminPrimeiraMensagem produces novo→aquecimento with engagement_mode bot_active | ✗ FAILED | blocked by CR-01 |
| 24 | Complex doubt produces handoff_events+mode_changes+awaiting_human (atomic) | ✗ FAILED | trigger not wired |

**Score:** 16/24 truths verified

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

## Key Link Verification (highlights)
- shadow.ts → messages (ai_suggestion/suggested): ✓
- inbound-handler → prompt-builder (masking before extract/generate): ✓
- handoff-service → handoff_events+mode_changes+conversations in one transaction: ✓
- CLI shadow → review_events append-only: ✓
- CLI mode → event_log operational_mode_changed + settings.operational_mode wired to gate: ✓

## Requirements Coverage (Phase 2 set)
Requirements from plans: OPRE-04, OPRE-05, LEAD-05, LEAD-06, CONV-01–CONV-06, CONV-08–CONV-10, CONV-12, FLUP-04, FLUP-05, FLUP-07, FLUP-09, FLUP-10, CRM-02, COMP-01, NFRQ-03.  
- **Verified/satisfied by code**: OPRE-04, OPRE-05, LEAD-05, LEAD-06, CONV-02–CONV-06, CONV-08–CONV-10, CONV-12, FLUP-04, FLUP-05, FLUP-07, FLUP-10, CRM-02, COMP-01, NFRQ-03 (core mechanics present).  
- **Blocked/missing wiring**: CONV-01 (Guard 0), FLUP-09 (duvida_complexa mapping).

## Anti-Patterns Found
- None major in modified files (shadow.ts does not import dispatcher; append-only enforced; PII masking centralized).  
- The two blockers are wiring/logic gaps (missing mapping + Guard 0 comparison), not placeholders/debt markers.

## Behavioral/Execution Checks
- Behavioral spot-checks not run (no server started).  
- Probe execution: no phase-declared probes found in phase dir; conventional probes absent. Skipped.  
- Existing tests: phase 2 test suites cover shadow/matcher/handoff/qualification/CLI/post-gate/adversarial/report as per summaries (verified by file presence).

## Exit Gate Note (ACCEPTED)
Phase 2 exit is D-17/D-18 (shadow report from DB with PASS/FAIL; promotion shadow→active requires explicit Admin approval). Current `shadow:report` returns FAIL with 0 evidence; Admin selected `manter-shadow`. This is the **ACCEPTED outcome per plan/checkpoint**, not a verification gap.

## Gaps Summary
Two BLOCKERS identified (CR-01, CR-02) prevent the phase goal from being fully achieved in production behavior:
1. **CR-01 (CONV-01/R-002):** Guard 0 detection uses incorrect comparison (chatId vs CHANNEL_PHONE_E164). Fix required so Admin’s first message sets `first_contact_by_human` true and enables `novo → aquecimento`.
2. **CR-02 (FLUP-09/R-065):** `INTENCOES_HANDOFF` missing `duvida_complexa`. Add mapping so complex doubt triggers `dispararHandoff` (atomic) with silence.

Six additional related gaps stem from these two (reachability/wiring). All 8 failed truths are traceable to CR-01 or CR-02.

## Human Verification Required
None identified by automated checks. The items above are code fixes (deterministic), not UI/visual behavior requiring human testing.

---

_Verified: 2026-10-14T12:48:00Z_  
_Verifier: goal-backward verification (gsd-verifier)_