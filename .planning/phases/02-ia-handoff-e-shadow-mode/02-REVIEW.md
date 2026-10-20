---
phase: 02-ia-handoff-e-shadow-mode
reviewed: 2026-10-19T03:52:00Z
depth: standard
files_reviewed: 42
files_reviewed_list:
  - .planning/phases/02-ia-handoff-e-shadow-mode/bake-off-resultado.json
  - scripts/bake-off.ts
  - scripts/shadow-report.ts
  - src/application/event-bus.ts
  - src/application/handoff-service.ts
  - src/application/inbound-handler.ts
  - src/application/shadow.ts
  - src/channel/baileys/runtime.ts
  - src/cli/handoff.ts
  - src/cli/mode.ts
  - src/cli/shadow.ts
  - src/cli/status.ts
  - src/domain/gate/patterns/automation-disclosure.ts
  - src/domain/gate/types.ts
  - src/domain/llm/envelope.ts
  - src/domain/llm/post-gate.ts
  - src/domain/llm/prompt-builder.ts
  - src/domain/optout/optout-matcher.ts
  - src/domain/orchestrator/transitions.ts
  - src/domain/ports/LlmPort.ts
  - src/index.ts
  - src/infra/db/migrations/0006_shadow_and_llm_runs.sql
  - src/infra/db/queries/leads.ts
  - src/infra/db/queries/llm-context.ts
  - src/infra/db/queries/llm-runs.ts
  - src/infra/db/queries/review-events.ts
  - src/infra/db/queries/snapshot.ts
  - src/infra/db/queries/status-history.ts
  - src/infra/db/schema.ts
  - src/infra/llm/ai-sdk-adapter.ts
  - src/infra/llm/scripted-adapter.ts
  - tests/adversarial/adversarial.test.ts
  - tests/adversarial/corpus.ts
  - tests/application/handoff-intents.test.ts
  - tests/application/handoff-service.test.ts
  - tests/application/inbound-fromme.test.ts
  - tests/application/qualification.test.ts
  - tests/application/shadow.test.ts
  - tests/channel/evento-inbound.test.ts
  - tests/cli/shadow.test.ts
  - tests/domain/optout-matcher.test.ts
  - tests/domain/post-gate.test.ts
  - tests/ops/shadow-report.test.ts
findings:
  critical: 1
  warning: 6
  info: 4
  total: 11
status: issues_found
---
# Phase 02: Code Review Report

**Reviewed:** 2026-10-19T03:52:00Z
**Depth:** standard
**Files Reviewed:** 42
**Status:** issues_found

## Summary

Phase 2 implements a layered AI safety model with code-owned FSM (`transitions.ts`), L4 post-gate (`post-gate.ts`), PII masking at the prompt choke-point (`prompt-builder.ts`), and atomic handoff (`handoff-service.ts`). The architecture is sound and follows the documented invariants.

However, defensive adversarial review finds **one critical issue** with potential compliance impact, alongside 6 warnings and 4 info items. Most notably:

- **CR-01 (BLOCKER):** When the deterministic opt-out matcher returns AMBIGUO, the code fires `dispararHandoff` with `triggeredBy: "opt_out"` but never calls `applyOptOut`. The audit trail claims an "opt-out" handoff while `leads.opt_out` remains `false` and no `optout_ledger` row is written—creating inconsistency between the ledger and `handoff_events`. Under AR-005/R-024, the "permanent block" must be explicit in the ledger; labeling it `opt_out` without applying opt-out is a control mismatch.
- **WR-01–WR-06:** FSM state reopening risk, media extension anchoring, non-transactional state+audit in the IA path, shadow CLI missing target validation, the above opt-out/ledger consistency gap, and incomplete PII masking (email/CPF/CNPJ not masked before LLM egress).
- **INFO:** Type assertions on `Date` from pg driver (runtime strings), bake-off transcripts using invalid `Estado`, media event not advancing watermark, plus minor documentation/type mismatches.

## Critical Issues

### CR-01: Opt-out AMBIGUO path fires handoff labeled `opt_out` without applying opt-out

**File:** `src/application/inbound-handler.ts:423-441` (opt-out AMBIGUO branch)

**Issue:** When `classifyOptout(evt.body)` returns `OptoutClass.AMBIGUO`, the code calls `dispararHandoff` with `triggeredBy: "opt_out"` and `triggerDetail: "optout_ambiguo"` (lines 423-441). However, it never calls `applyOptOut(...)`. Only the FORTE branch does (lines 395-422).

Consequence: the audit trail (`handoff_events.triggered_by='opt_out'`, `trigger_value/detail`) claims an opt-out-triggered handoff, but:
- `leads.opt_out` remains `false` (no ledger write)
- No `optout_ledger` row exists for this event
- `scripts/shadow-report.ts:271-277` computes `optOuts` by counting `optout_ledger` rows (the report’s "opt-out" metric reads the ledger, not handoff_events). The labels diverge between what was recorded as triggered-by and what is recorded in the opt-out ledger.

This is a control/audit consistency failure: the "opt-out" label is used without the irreversible ledger action. Under AR-005/R-024, ambiguity must never silently create a permanent block; equally, the labeling must not imply a block that didn’t happen.

**Fix:** For AMBIGUO (requires human confirmation), do **not** label the trigger as `opt_out`. Use `keyword` or a distinct value (e.g. `low_confidence`/`validation_error`) consistent with the enum (`HandoffTriggeredBy` includes `opt_out`, `validation_error`, `low_confidence`, `keyword`, `intent`, `message_type`, `user_defined`). Also do not write to `optout_ledger` in AMBIGUO. Suggested change:

```ts
if (classeOptout === OptoutClass.AMBIGUO) {
  await dispararHandoff(
    db,
    {
      conversationId: conversa.id,
      reason: "opt-out ambiguo (matcher deterministico)",
      triggeredBy: "validation_error", // or "low_confidence"; avoid "opt_out"
      triggerDetail: "optout_ambiguo",
      excerpt: evt.body,
      actor: "bot",
      agora,
    },
    { notifier: deps.notifier },
  );
  ...
}
```

If the requirement explicitly wants `triggered_by='opt_out'` for the handoff in AMBIGUO, the implementation must also apply opt-out (but that would contradict "never block without confirmation"). The current labeling is incorrect given the action taken.

## Warnings

### WR-01: Handoff can reopen the terminal sink `encerrado`

**File:** `src/domain/orchestrator/transitions.ts:78`

**Issue:** When `prev === "encerrado"`, the function returns early only if `ctx.optOutAtivo` is true. If `ctx.handoffDisparado` is also true (stale state, race condition, or data drift), the check `if (ctx.handoffDisparado) return "awaiting_human";` executes after the opt-out check but **before** honoring the terminal nature of `encerrado`. Because the order is:
```ts
if (ctx.optOutAtivo) return "encerrado";
if (ctx.handoffDisparado) return "awaiting_human";  // <-- executes for any non-opt-out case
```

No guard checks if `prev === "encerrado"`. So if `encerrado` was set due to `sequenciaEsgotada` or other terminal conditions, and `handoff_active` is later asserted (or the context passes `handoffDisparado: true`), `resolveNextState` returns `"awaiting_human"`, reopening a sink. Both `handoff-service.ts:180-185` and `inbound-handler.ts:667-689` rely on this to set `state = proximo`.

**Fix:** Short-circuit the terminal state first:

```ts
if (prev === "encerrado") return "encerrado";
if (ctx.optOutAtivo) return "encerrado";
if (ctx.handoffDisparado) return "awaiting_human";
```

This preserves the FSM contract: `encerrado` has no outgoing transitions.

### WR-02: `MEDIA_LINK_EXT` is `$`-anchored, missing mid-text media links; structural link check underutilized

**File:** `src/domain/gate/patterns/automation-disclosure.ts:62`, consumed by `src/domain/llm/post-gate.ts:131`

**Issue:** `MEDIA_LINK_EXT = /\.(png|jpe?g|gif|webp|mp3|ogg|opus|m4a|mp4|mov|pdf|docx?|xlsx?|pptx?|zip)$/i` ends with `$`, so it only matches when the extension is the final token of the text. For example: `"baixe em https://ex.com/arquivo.pdf e responda"` — `.pdf` is not at the end, so the test fails. `MEDIA_TERM` covers words like "pdf" but not the actual file extension in a URL embedded mid-sentence.

Additionally, in the shadow pipeline (`src/application/shadow.ts:175`), `outbound.parts = [{ kind: "text" }]` is constructed without `href`. The AR-004 structural check in `ar-004.ts` (which can inspect link parts) is never exercised for AI-generated drafts in shadow; only the text-based scan (`post-gate.ts`) protects. The anchored regex is the weaker of the two paths.

**Fix:** Remove the end anchor and match until whitespace/query/fragment boundary:

```ts
export const MEDIA_LINK_EXT =
  /\.(png|jpe?g|gif|webp|mp3|ogg|opus|m4a|mp4|mov|pdf|docx?|xlsx?|pptx?|zip)(?:[?#\s]|$)/i;
```

Also consider populating `parts` with actual link metadata when present (so structural guards are exercised), not just plain text.

### WR-03: State update and `status_history` audit not atomic in IA path

**File:** `src/application/inbound-handler.ts:528-542` (`rascunharShadow`)

**Issue:** When `estadoResolvido !== conversa.state`, the code does:
```ts
await db.execute(sql`update conversations set state = ${estadoResolvido} where id = ${conversa.id}`);
await recordStatusChange(db, { ... });
```

These are two separate statements with no transaction. If the process crashes between them, or the second write fails, the conversation state changed with no corresponding `status_history` row. This violates R-022 audit integrity.

By contrast, `handoff-service.ts:118-207` correctly wraps state changes + audit + event writes in a single transaction, and the admin-first-message path (`inbound-handler.ts:673-689`) also uses a transaction. The IA path (`rascunharShadow`) is the outlier.

**Fix:** Wrap both writes in `db.transaction(...)` as done elsewhere:

```ts
if (estadoResolvido !== conversa.state) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`update conversations set state = ${estadoResolvido} where id = ${conversa.id}`);
    await recordStatusChange(tx, { conversationId: conversa.id, fromState: conversa.state, toState: estadoResolvido, changedBy: "bot", reason: `extracao Camada 1 (intent=${intent})`, changedAt: agora });
  });
}
```

### WR-04: Shadow CLI `decidir` validates UUID but not target draft state

**File:** `src/cli/shadow.ts:162-188`

**Issue:** `decidir` only checks UUID format (`UUID.test(id)`). It then calls `recordReviewEvent` directly. It does not verify:
- The message exists
- The message is an AI suggestion (`origin='ai_suggestion'`)
- The message status is reviewable (`status='suggested'`) or hasn’t already been decided (idempotency/duplication)

Consequences:
1. A typo’d/unknown UUID produces a foreign key violation from `review_events.message_id` → surfaced as an unhandled DB error (no try/catch in `runShadowCli` path; CLI exits via exception).
2. An admin could attempt to record a decision against a non-draft message id (if UUID happens to exist), polluting `review_events` and shadow metrics. The schema allows FK to `messages.id` but has no guard on `origin/status`.

**Fix:** Look up the target before inserting the event:

```ts
const alvo = await db.execute(sql`
  select id from messages
  where id = ${id}
    and origin = 'ai_suggestion'
    and status = 'suggested'
`);
if (!linhasDe<{id:string}>(alvo)[0]) {
  escrever(`rascunho inexistente ou nao revisavel: ${id}`);
  return 1;
}
await recordReviewEvent(db, { messageId: id, decision: decisao, actor: "admin", editedText: textoEditado });
```

Return `1` (domain/error) or `2` (usage) per existing conventions; avoid leaking DB exceptions to the CLI.

### WR-05: `pedido_optout` from LLM sets handoff `triggeredBy='opt_out'` but does not apply opt-out (consistency)

**File:** `src/application/inbound-handler.ts:327-341` (`triggeredByDoGatilho`), `484-524` (handoff branch)

**Issue:** When `intent === "pedido_optout"`, `triggeredByDoGatilho` returns `"opt_out"`. If the deterministic matcher (`classifyOptout`) returned `NAO` but the LLM extracts `pedido_optout`, the handoff branch (lines 508-524) triggers with `triggeredBy: "opt_out"` but does **not** call `applyOptOut`. This is the same class of inconsistency as CR-01 (label vs action).

The deterministic matcher runs before LLM (lines 390-442) and already handles FORTE/AMBIGUO with `applyOptOut` (FORTE) or handoff without opt-out write (AMBIGUO). So the LLM-path opt-out case only occurs when deterministic says NAO but LLM disagrees. In that case:
- Handoff is fired with `triggered_by='opt_out'`
- `leads.opt_out` remains `false`; no `optout_ledger` entry
- Audit claims opt-out, ledger does not contain it

**Fix:** If LLM detects `pedido_optout` (and deterministic was NAO), treat as a compliance boundary: either (a) treat as ambiguous and handoff with `triggeredBy: "validation_error"`/`"low_confidence"` (do not label opt_out), or (b) require a stronger confirmation and still avoid writing opt-out ledger. Do not conflate "handoff due to opt-out intent" with "opt-out applied". Suggested: in the handoff branch when `intent === "pedido_optout"`, set `triggeredBy` to `"intent"` (or `"validation_error"`) rather than `"opt_out"`, unless you also apply opt-out. Since AR-005 requires deterministic authority for the irreversible action, the safer label is non-opt-out.

### WR-06: `maskPii` does not mask email, CPF, or CNPJ

**File:** `src/domain/llm/prompt-builder.ts:42-57`, `60-80`

**Issue:** `maskTexto` only replaces `RE_ENDERECO`, `RE_TELEFONE`, `RE_CEP`. It does not mask:
- Email addresses (e.g. `lead@empresa.com.br`)
- CPF (e.g. `000.000.000-00`, `00000000000`)
- CNPJ (e.g. `00.000.000/0000-00`, `00000000000000`)

These are common PII in B2B contexts and will egress to the external LLM via `historico`, `ultimaMensagem`, and potentially `adminPrimeiraMensagem`/`lead` fields. The module’s comment says it masks "o payload inteiro", but the implementation is incomplete relative to typical LGPD surface.

**Fix:** Add patterns before phone/address replacements (order matters to avoid partial matches). Suggested:

```ts
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const RE_CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const RE_CPF  = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;

const maskTexto = (texto: string): string =>
  texto
    .replace(RE_EMAIL, "[EMAIL]")
    .replace(RE_CNPJ, "[CNPJ]")
    .replace(RE_CPF, "[CPF]")
    .replace(RE_ENDERECO, PLACEHOLDER_ENDERECO)
    .replace(RE_TELEFONE, PLACEHOLDER_TELEFONE)
    .replace(RE_CEP, PLACEHOLDER_ENDERECO);
```

Also export placeholders if tests need to assert them, or keep as string literals (current codebase uses string constants).

## Info

### IN-01: `as Date` type assertions where pg driver returns strings

**File:** `src/cli/shadow.ts:118,121` (`criadoEm: row.created_at as Date`, `decididoEm: row.decidido_em as Date`), `src/infra/db/queries/review-events.ts:120` (`createdAt: row.created_at as Date`)

**Issue:** `openDb` registers no pg type parsers for `TIMESTAMPTZ`/`TIMESTAMP`. With `node-postgres` v8, timestamps are returned as strings by default unless explicitly parsed. The `as Date` assertions are type lies at runtime—`new Date(string)` is correct, but the type system is told it’s already a `Date`. Currently not exercised in a way that breaks (only `.length` used), but it’s unsafe.

**Fix:** Convert explicitly: `createdAt: new Date(row.created_at as string)`, or register type parsers in `openDb` (e.g. `pg.types.setTypeParser(1184, (v) => v ? new Date(v) : null)`) to match the declared types.

### IN-02: Bake-off corpus uses non-`Estado` value `"contorno_objecao"`

**File:** `scripts/bake-off.ts:63,92,95,100,125,145,160,175`

**Issue:** `Transcript.estado` is documented as the "Estado AUTORITATIVO que o `resolveNextState` escolheria". However, 7 transcripts use `"contorno_objecao"`, which is not in `Estado` (`transitions.ts:14-23`: novo,aquecimento,qualificando,aquecido,awaiting_human,human,copilot,pausado,encerrado). `GenerateInput.resolvedState` is typed `string` (`LlmPort.ts:107`), so TypeScript allows it. This feeds the model an impossible/unsupported state, reducing fidelity of the bake-off evaluation.

**Fix:** Replace `"contorno_objecao"` with a valid `Estado` (e.g. `"qualificando"`) in those transcripts, or model the hint/state mapping explicitly in the harness.

### IN-03: Media event does not advance processing watermark

**File:** `src/application/inbound-handler.ts:607-614` (`registrarMidiaRecebida` called, then returns at line ~614)

**Issue:** After handling media (AR-009), the function returns before the watermark update that occurs later (around line ~688+ in the full flow for text). The `last_processed_at` cursor is not advanced for media events. While deduplication for media is handled via `handoff-service.ts` idempotency (`handoff_active` check), re-delivered media events will be re-evaluated and may create `blocked_attempts` rows again (the messages-based idempotency key doesn’t apply to media path). The "processed up to" cursor becomes inconsistent with what was actually handled.

**Fix:** Advance `last_processed_at` for media events as well (e.g. update conversations watermark in the media branch, or track processed media by `providerMsgId`), consistent with how text events update the watermark.

### IN-04: Minor doc/type mismatch for `senderPhoneE164` (null vs undefined)

**File:** `src/application/event-bus.ts:38-39` (doc) vs `src/channel/baileys/runtime.ts:109-114`

**Issue:** The doc states it’s `undefined` when not derivable, but when `canalSelfJid` exists but resolves to LID form, `normalizeJid(...).e164` can return `null` (per jid-resolver behavior). The type is `string | null | undefined` which is correct and the predicate treats both as fail-closed. This is a documentation imprecision only.

**Fix:** Update the comment to say `"null/undefined quando não derivável"` to match runtime behavior.

---

_Reviewed: 2026-10-19T03:52:00Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_