---
phase: 02-ia-handoff-e-shadow-mode
fixed_at: 2026-10-19T11:49:10Z
review_path: .planning/phases/02-ia-handoff-e-shadow-mode/02-REVIEW.md
iteration: 1
findings_in_scope: 11
fixed: 11
skipped: 0
status: all_fixed
commits: none (per executor instruction: "Do not commit unless user asks")
---

# Phase 02: Code Review Fix Report

**Fixed at:** 2026-10-19T11:49:10Z
**Source review:** `.planning/phases/02-ia-handoff-e-shadow-mode/02-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 11 (CR-01, WR-01..WR-06, IN-01..IN-04)
- Fixed: 11
- Skipped: 0
- **No commits were made** — the executor instruction was "Do not commit unless user asks"; all changes are left as working-tree edits for review.

**Verification (all green):**
- `npm run typecheck` → exit 0 (both `tsconfig.json` and `tsconfig.web.json`)
- `npm run lint` (`biome check .`) → exit 0, 0 errors (16 warnings, all pre-existing `noNonNullAssertion` in test files not touched here)
- `npm test` → 63 files / **367 tests passed**

---

## Fixed Issues

### CR-01: Opt-out AMBIGUO handoff labeled `opt_out` without applying opt-out

**Files modified:** `src/application/inbound-handler.ts`
**Commit:** none (uncommitted, per instruction)
**Applied fix:** In the `OptoutClass.AMBIGUO` branch, `triggeredBy` changed from `"opt_out"` to `"validation_error"` (a valid value of `HandoffTriggeredBy` and of the DB CHECK `handoff_events_triggered_by_check`). No `applyOptOut`/`optout_ledger` write added — ambiguity must never create a permanent block (AR-005/R-024); the label now matches the action actually taken (handoff for human confirmation only). `triggerDetail: "optout_ambiguo"` kept for traceability.
**Status:** `fixed: requires human verification` — control/audit labeling decision; confirm `validation_error` (vs `low_confidence`) is the label the audit wants for ambiguous opt-out.

### WR-01: Handoff could reopen the terminal sink `encerrado`

**Files modified:** `src/domain/orchestrator/transitions.ts`, `tests/domain/transitions.test.ts`
**Commit:** none (uncommitted, per instruction)
**Applied fix:** Added `if (prev === "encerrado") return "encerrado";` as the first guard in `resolveNextState`, before the `optOutAtivo`/`handoffDisparado` guards, honoring `ALLOWED.encerrado = []` ("sumidouro, nenhuma saída").
**Test change (required by this behavior change):** `tests/domain/transitions.test.ts` — the test "handoff disparado → awaiting_human, vencendo a hint (AR-010)" looped over **all** 9 states and therefore asserted the old reopening behavior for `prev === "encerrado"`, directly contradicting the sibling test "estado terminal é sumidouro: encerrado não transita". The loop now skips `encerrado`, and a new test pins the corrected contract: `resolveNextState("encerrado", …, { handoffDisparado: true }) === "encerrado"`.
**Status:** `fixed: requires human verification` — FSM semantics change. Note that post-handoff silence does NOT depend on this: AR-010/R-066 freeze is enforced by `handoff_active` + `engagement_mode='awaiting_human'` (written by `dispararHandoff` regardless of `state`), and `handoff_events`/`mode_changes` rows are still written. Confirm no downstream report/UI expects `state='awaiting_human'` for handoffs raised in already-closed conversations.

### WR-02: `MEDIA_LINK_EXT` `$`-anchored, missing mid-text media links

**Files modified:** `src/domain/gate/patterns/automation-disclosure.ts`
**Commit:** none (uncommitted, per instruction)
**Applied fix:** Replaced the `$` anchor with a token-closing boundary: `(?:[^\w]|$)`. Adapted from the review's suggested `(?:[?#\s]|$)` because that variant still misses sentence punctuation (`"…/arquivo.pdf."` → after `pdf` comes `.`), i.e. it would leave a variant of the same bug. `[^\w]` closes the token wherever it sits: whitespace, `?`/`#` (query/fragment), and punctuation (`.`, `,`, `)`, `;`), while still refusing longer tokens (`.pdfs`). Doc-comment added explaining the anchor decision. Consumers (`ar-004.ts` b2 on `href`, `post-gate.ts` on text) are unchanged and both use `.test()` on a non-global regex (no `lastIndex` hazard).
**Deferred (advisory sub-item, not a defect):** populating `shadow.ts` `outbound.parts` with `href` link metadata. The real send path (`dispatcher.ts:174`) uses the identical `parts: [{ kind: "text" }]` shape, so diverging only in shadow would desync the two paths; text coverage of `MEDIA_LINK_EXT` is equivalent for a generated draft. Revisit only if link parts are populated in `dispatcher.ts` too.

### WR-03: State update and `status_history` audit not atomic in the IA path

**Files modified:** `src/application/inbound-handler.ts`
**Commit:** none (uncommitted, per instruction)
**Applied fix:** Wrapped the `conversations.state` UPDATE and `recordStatusChange` in a single `db.transaction(...)`, using the codebase's existing `txBruto as unknown as Db` convention (same as `handoff-service.ts:119` and the admin-first-message path at `inbound-handler.ts:676`).

### WR-04: Shadow CLI `decidir` validated UUID but not the target draft

**Files modified:** `src/cli/shadow.ts`
**Commit:** none (uncommitted, per instruction)
**Applied fix:** Before `recordReviewEvent`, `decidir` now looks the target up (`id AND origin = 'ai_suggestion' AND status = 'suggested'`); missing/non-reviewable → writes `rascunho inexistente ou nao revisavel: <id>` and returns `1` (domain error, per CLI convention). Both the lookup and the insert are wrapped in `try/catch` so a DB/foreign-key error is reported as a line and returns `1` instead of escaping as an unhandled exception.

### WR-05: LLM `pedido_optout` handoff labeled `opt_out` without applying opt-out

**Files modified:** `src/application/inbound-handler.ts`
**Commit:** none (uncommitted, per instruction)
**Applied fix:** In the handoff branch, `triggeredBy` is now `"intent"` when `intent === "pedido_optout"` (deterministic matcher already ran and returned `NAO` — AR-005 gives the deterministic matcher authority over the irreversible action), otherwise `triggeredByDoGatilho(...)` as before. `triggerDetail`/`triggerValue` still carry `pedido_optout`, so the audit trail keeps the information; only the misleading `opt_out` label (which implies a ledger write that did not happen) is gone.
**Status:** `fixed: requires human verification` — label-vs-action consistency decision.

### WR-06: `maskPii` did not mask email, CPF, or CNPJ

**Files modified:** `src/domain/llm/prompt-builder.ts`
**Commit:** none (uncommitted, per instruction)
**Applied fix:** Added `RE_EMAIL`, `RE_CNPJ`, `RE_CPF` and applied them first in `maskTexto` (order matters: CNPJ before CPF so `00.000.000/0000-00` is not half-matched as CPF; email before both so `user@123.456.789-00`-style text isn't mangled), then the existing address/phone/CEP replacements. Placeholders `[EMAIL]`/`[CNPJ]`/`[CPF]` are digit-free, matching the module's "sem dígitos, para não virarem falso-positivo" rule. `maskPii` remains the single choke-point (`buildExtractPrompt`/`buildGeneratePrompt` call it), so no call-site changes.

### IN-01: `as Date` type assertions where the driver returns strings

**Files modified:** `src/cli/shadow.ts`, `src/infra/db/queries/review-events.ts`
**Commit:** none (uncommitted, per instruction)
**Applied fix:** Added a `paraData(bruto)` helper in each module (`bruto instanceof Date ? bruto : new Date(String(bruto))`) and used it for `criadoEm`, `decididoEm` (with explicit null/undefined handling) and `createdAt`. This is a real runtime bug, not just a type lie: `src/cli/handoff.ts:43-48` documents that Drizzle's node-postgres driver installs a type parser returning TIMESTAMPTZ as a **raw string**.

### IN-02: Bake-off corpus used non-`Estado` value `"contorno_objecao"`

**Files modified:** `scripts/bake-off.ts`
**Commit:** none (uncommitted, per instruction)
**Applied fix:** Replaced all 7 `"contorno_objecao"` values with `"qualificando"` (a valid `Estado`; objection handling keeps the conversation in qualification) **and** tightened `Transcript.estado` from `string` to `Estado`, so an impossible state is now a compile error rather than a silent corpus defect. Import of `Estado` placed in biome's organizeImports order.

### IN-03: Media event did not advance the processing watermark

**Files modified:** `src/application/inbound-handler.ts`
**Commit:** none (uncommitted, per instruction)
**Applied fix:** The media branch now updates `conversations.last_processed_at = now()` after `registrarMidiaRecebida`, so the cursor reflects what was actually handled. Deliberately **only** `last_processed_at` (not `last_inbound_at`): per the existing comment at the watermark block, `last_inbound_at` measures the lead's *text* response driving follow-up cadence (D-12/D-13), and a media-block event must not touch that predicate.

### IN-04: Doc/type mismatch for `senderPhoneE164` (null vs undefined)

**Files modified:** `src/application/event-bus.ts`
**Commit:** none (uncommitted, per instruction)
**Applied fix:** Comment updated to "`null/undefined quando não derivável`", matching `normalizeJid(...).e164` possibly returning `null`.

---

## Skipped Issues

None — all in-scope findings were applied.

---

## Notes on scope & method

- Only the files cited by the findings were edited; no unrelated changes.
- `tests/domain/transitions.test.ts` is the **only test file modified**, and only because WR-01's prescribed behavior change contradicted an assertion that codified the old (buggy) behavior. No production test expectations were weakened elsewhere.
- Pre-existing working-tree changes NOT made by this fixer and left untouched: `02-REVIEW.md`, `biome.json`, `src/web/App.tsx`, `tests/web/build.test.ts`, plus untracked `baileys-debug.txt` / `probe-baileys.mjs` / `src/web/components/*`.
- `src/infra/db/queries/status-history.ts` was temporarily touched during WR-03 iteration and **fully reverted** to its original signature (verified in `git diff`).

---

_Fixed: 2026-10-19T11:49:10Z_
_Fixer: the agent (gsd-code-fixer)_
_Iteration: 1_
