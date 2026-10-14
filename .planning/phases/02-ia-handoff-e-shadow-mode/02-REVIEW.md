---
phase: 02-ia-handoff-e-shadow-mode
reviewed: 2026-10-14T11:32:17Z
depth: standard
files_reviewed: 26
files_reviewed_list:
  - src/application/inbound-handler.ts
  - src/application/event-bus.ts
  - src/application/handoff-service.ts
  - src/application/shadow.ts
  - src/application/dispatcher.ts
  - src/channel/baileys/runtime.ts
  - src/channel/baileys/jid-resolver.ts
  - src/cli/shadow.ts
  - src/domain/gate/guard-0-r001.ts
  - src/domain/gate/evaluate-policy.ts
  - src/domain/gate/index.ts
  - src/domain/gate/guards/ar-004.ts
  - src/domain/gate/patterns/automation-disclosure.ts
  - src/domain/llm/envelope.ts
  - src/domain/llm/post-gate.ts
  - src/domain/llm/prompt-builder.ts
  - src/domain/orchestrator/transitions.ts
  - src/domain/optout/optout-matcher.ts
  - src/domain/ports/LlmPort.ts
  - src/infra/db/client.ts
  - src/infra/db/queries/review-events.ts
  - scripts/bake-off.ts
  - scripts/shadow-report.ts
  - tests/application/inbound-fromme.test.ts
  - tests/adversarial/corpus.ts
  - tests/domain/post-gate.test.ts
findings:
  critical: 2
  warning: 6
  info: 3
  total: 11
status: clean
updated: 2026-10-14T18:45:11Z
---

# Phase 02: Code Review Report

**Reviewed:** 2026-10-14T11:32:17Z
**Depth:** standard
**Files Reviewed:** 26
**Status:** issues_found

## Summary

Phase 2 (IA, Handoff e Shadow Mode) delivers a genuinely well-structured AI sandwich: a single prompt choke-point with PII masking (`prompt-builder.ts`), a deterministic L4 post-gate (`post-gate.ts`), a code-owned FSM (`transitions.ts`), an atomic handoff transaction (`handoff-service.ts`), and an append-only shadow review trail (`shadow.ts` + `review_events`). The architecture invariants hold: shadow mode has no path to `sendText`, opt-out is decided by the deterministic matcher (never the LLM), and `messages` is only promoted via `review_events` events, not `UPDATE`s.

However, the phase is **not functional in production**, and one required handoff trigger is missing:

- **CR-01** is a hard blocker: the R-001 guard compares a lead's JID against the dedicated number's E.164, which can never be equal. As a result `first_contact_by_human` is never set, Guard 0 (`r001_primeiro_contato_nao_humano`) blocks every outbound, and `persistDraft` blocks every draft. In production, Phase 2 produces **zero** `ai_suggestion` rows, so the shadow exit gate can never pass. The unit/property tests miss it because they feed `chatId: env.CHANNEL_PHONE_E164` (a value the runtime never produces) and the property test re-implements the function locally.
- **CR-02**: `duvida_complexa` (R-065) is enumerated by the plan (02-02 D-12) and research (FLUP-09) as a handoff trigger but is absent from `INTENCOES_HANDOFF`, so complex technical doubt does not silence the automation.

The remaining warnings are real but bounded: an FSM guard order that lets handoff reopen the terminal sink, a `$`-anchored media-extension check that misses mid-text links (with the structural link check never exercised in the shadow pipeline), two non-atomic state+audit writes, an unvalidated shadow CLI decision target, an `opt_out`-labelled handoff that does not actually apply opt-out, and residual PII (email/CPF/CNPJ) egress to the LLM.

## Critical Issues

### CR-01: Guard 0 is never satisfiable in production — `chatId` (lead JID) compared to channel E.164

**File:** `src/application/inbound-handler.ts:106-114` (function), called at `src/application/inbound-handler.ts:608-613`
**Also:** `src/channel/baileys/runtime.ts:83` (`chatId` is assigned `m.key.remoteJid`)

**Issue:** `deveMarcarPrimeiroContatoHumano` requires `opts.chatId === opts.channelPhoneE164`:

```ts
if (opts.fromMe !== true) return false;
if (!opts.chatId || !opts.channelPhoneE164) return false;
return opts.chatId === opts.channelPhoneE164;
```

In the real pipeline `chatId` comes from `criarEventoInbound`, which sets `const chatId = m.key.remoteJid;` (`runtime.ts:83`). For a `fromMe` message, `remoteJid` is the **peer** (the lead) — e.g. `5511999999999@s.whatsapp.net` (or a `…@lid`) — never the sending channel's own number. `env.CHANNEL_PHONE_E164` is E.164 form (`+5511999999999`). The two values differ in both body form and suffix, so the comparison is **always false**.

Consequences, all verified by tracing the call chain:

1. `first_contact_by_human` is never set to `true` (the only writer in the codebase is `inbound-handler.ts:616-619`, per repo-wide grep).
2. `snapshot.lead.firstContactByHuman` stays `false`, so Guard 0 (`guard-0-r001.ts:13-16`) returns `r001_primeiro_contato_nao_humano` for **every** evaluation.
3. In shadow, `persistDraft` calls `evaluatePolicy` (`shadow.ts:173-193`); Guard 0 is the second guard in `GUARD_ORDER`, so every draft is blocked and recorded in `blocked_attempts`. `messages` never receives an `origin='ai_suggestion'` row.
4. `buildShadowReport` counts `rascunhos` from `messages where origin='ai_suggestion'` (`scripts/shadow-report.ts:202-208`), so the exit gate reports 0 drafts and can never reach PASS.

Phase 2 therefore produces no value in production, and the CONV-01 transition (`novo` → `aquecimento`) also never fires.

**Why the tests don't catch it:** `tests/application/inbound-fromme.test.ts:100` passes `chatId: env.CHANNEL_PHONE_E164` (a value the runtime never emits), and the property test at `tests/application/inbound-fromme.test.ts:474-496` uses a **local re-implementation** of the function (`lines 41-51`) with the identical flawed comparison — tautological.

**Fix:** Do not compare the peer JID to the channel's E.164. The dedicated channel is a boot-level invariant (a single socket). Detect the human first contact from the message direction, and if a channel identity check is genuinely needed, compare normalized JIDs — not `chatId` against E.164:

```ts
// The channel socket belongs to the dedicated number (single-user, single-socket
// invariant); a `fromMe` message on that socket IS the human's outbound.
export const deveMarcarPrimeiroContatoHumano = (opts: {
  readonly fromMe: boolean | null | undefined;
}): boolean => opts.fromMe === true;
```

Alternatively, if a channel check must remain, resolve the channel's own JID once at boot and compare against `normalizeJid(opts.chatId).jid` — but note `remoteJid` is the peer, so any comparison against the lead's JID is still wrong.

### CR-02: `duvida_complexa` (R-065) is not a handoff trigger

**File:** `src/application/inbound-handler.ts:74-82` (set) and `src/application/inbound-handler.ts:484-491` (condition)

**Issue:** `INTENCOES_HANDOFF` lists `pedido_preco`, `intencao_agendar`, `bot_suspicion`, `irritacao`, `ameaca`, `pedido_optout`, `midia_recebida` — but omits `duvida_complexa`. The intent enum includes it (`src/domain/llm/envelope.ts:27`), and no `signals` boolean covers complex doubt (`sinaisEnvelope`: pricingAsked, schedulingIntent, botSuspicion, irritation, optOutIntent, mediaReceived). So a complex technical-boundary question classified as `duvida_complexa` produces no handoff.

This contradicts the phase's own plan and research:

- `02-02-PLAN.md:172` — "mapeando os gatilhos: … `duvida_complexa` (R-065) …".
- `02-RESEARCH.md:84` (FLUP-09) — "Handoff também em irritação/ameaça/pedido de opt-out/dúvida complexa (R-065)".
- `docs/01-requisitos-funcionais.md:204` (R-065), `docs/03-regras-de-negocio.md` (RN-051), `docs/02-user-stories.md` (US-019).

In production (post-promotion) the bot would answer a complex/technical question it is required to hand off — a compliance/safety gap; in shadow it silently replaces a required handoff with a draft.

**Fix:** Add the intent to the set:

```ts
const INTENCOES_HANDOFF: ReadonlySet<string> = new Set([
  "pedido_preco",
  "intencao_agendar",
  "bot_suspicion",
  "irritacao",
  "ameaca",
  "pedido_optout",
  "midia_recebida",
  "duvida_complexa",
]);
```

## Warnings

### WR-01: Handoff can reopen the terminal sink `encerrado`

**File:** `src/domain/orchestrator/transitions.ts:77-78`
**Also:** call sites `src/application/inbound-handler.ts:473-482,514-518` and `src/application/handoff-service.ts:180-185`

**Issue:** The doc-comment states `encerrado` is a sink (lines 25, 35: `encerrado: []`), but `resolveNextState` checks `handoffDisparado` before consulting `ALLOWED[prev]`:

```ts
if (ctx.optOutAtivo) return "encerrado";
if (ctx.handoffDisparado) return "awaiting_human";   // <- overrides a terminal prev
```

If a conversation is `encerrado` (e.g. via `sequenciaEsgotada` from a later phase) and `handoff_active` is stale/raised, both `handoff-service.ts:180-185` and the inbound state-persist at `inbound-handler.ts:514-518` will `UPDATE conversations SET state = 'awaiting_human'`, reopening a closed conversation and violating the documented FSM contract.

**Fix:** Guard the terminal state before the handoff override, or only honor handoff when `ALLOWED[prev]` permits it:

```ts
if (prev === "encerrado") return "encerrado";
if (ctx.optOutAtivo) return "encerrado";
if (ctx.handoffDisparado) return "awaiting_human";
```

### WR-02: L4 media-extension check is `$`-anchored, and the structural link check never runs in the shadow pipeline

**File:** `src/domain/gate/patterns/automation-disclosure.ts:61-62` (`MEDIA_LINK_EXT`), consumed at `src/domain/llm/post-gate.ts:128-138`
**Also:** `src/application/shadow.ts:175` (`parts: [{ kind: "text" }]`)

**Issue:** `MEDIA_LINK_EXT = /\.(png|…|zip)$/i` is anchored with `$` (no `m` flag). In `post-gate.ts:131` it is applied to the **whole generated text**, so a media URL that is not the final token escapes L4 — e.g. `"baixe em https://ex.com/arquivo.zip e me diz"` is not caught (`.zip`/`.mp4` are not in `MEDIA_TERM`, which only covers foto/imagem/áudio/vídeo/pdf/planilha; and `\bpdf\b` happens to catch `.pdf` but nothing else). The same regex applied to a single `p.href` in `ar-004.ts` is correct, but that path never executes here because shadow/`persistDraft` constructs `outbound.parts = [{ kind: "text" }]` with no `href`, so only `MEDIA_TERM`/`ANEXO_TERM`/`MEDIA_LINK_EXT.test(texto)` protect.

**Fix:** Remove the `$` anchor (match the extension anywhere in the URL token), e.g. `/\.(png|…|zip)(?:[?#\s]|$)/i`, or run the check per-URL-token. Consider also populating `parts` with the actual link so the structural guard is exercised.

### WR-03: State update and `status_history` audit write are not atomic

**File:** `src/application/inbound-handler.ts:514-527` and `src/application/inbound-handler.ts:625-639`

**Issue:** Both the AI-resolved state transition and the admin-first-message transition perform a standalone `db.execute(UPDATE conversations …)` followed by a separate `recordStatusChange(...)`, with no enclosing transaction. If the process dies or the second statement fails between the two, the conversation state changes with no `status_history` row — a direct R-022 audit gap (the same discipline `handoff-service.ts` correctly applies by wrapping all four writes in one transaction).

**Fix:** Wrap each state change and its audit row in a single `db.transaction(async (tx) => { … })`, as `handoff-service.ts:118-207` does.

### WR-04: Shadow CLI `decidir` does not validate the decision target

**File:** `src/cli/shadow.ts:162-188`

**Issue:** `decidir` validates only the UUID shape, then calls `recordReviewEvent` directly. It never verifies that the message exists, nor that it is a draft (`origin='ai_suggestion'`, `status='suggested'`). Consequences: (a) a typo'd id produces a raw FK-violation stack trace out of the CLI entrypoint (`shadow.ts:234-241`, no `try/catch`); (b) an admin can "approve" a real inbound/outbound message id, polluting `review_events` and the shadow approval-rate metric with a non-draft.

**Fix:** Before recording, verify the target:

```ts
const alvo = await db.execute(sql`
  select id from messages where id = ${id} and origin = 'ai_suggestion' and status = 'suggested'
`);
if (!linhasDe<{ id: string }>(alvo)[0]) {
  escrever(`rascunho inexistente ou não revisável: ${id}`);
  return 1;
}
```

### WR-05: LLM-detected `pedido_optout` is labelled `opt_out` but does not apply opt-out

**File:** `src/application/inbound-handler.ts:327-341` (`triggeredByDoGatilho`) and `src/application/inbound-handler.ts:484-508`

**Issue:** When the LLM classifies a message as `pedido_optout`, `triggeredByDoGatilho` returns `"opt_out"`, so a `handoff_events` row records `triggered_by='opt_out'` — yet the handoff branch does **not** call `applyOptOut` and does not write `optout_ledger`. `leads.opt_out` remains `false`. This only bites when the deterministic matcher (`classifyOptout`, `inbound-handler.ts:379`) returned `NAO` but the LLM says opt-out. Effect: the audit trail claims an opt-out that the ledger does not contain (the shadow report's `optOuts` metric reads `optout_ledger` only, `scripts/shadow-report.ts:271-277`), and the lead is never permanently blocked — a re-contact risk under AR-005.

**Fix:** When `intent === "pedido_optout"`, also call `applyOptOut(...)` (mirroring the FO/AMBIGUO paths at lines 380-407) before/instead of the generic handoff, so `leads.opt_out` and `optout_ledger` are consistent with the `triggered_by='opt_out'` label.

### WR-06: `maskPii` does not mask email, CPF or CNPJ

**File:** `src/domain/llm/prompt-builder.ts:42-57`

**Issue:** The choke-point masks phones, logradouros and CEP. The module claims to mask "o payload inteiro", but `maskTexto` has no rule for e-mail, CPF (`000.000.000-00`) or CNPJ (`00.000.000/0000-00`). If a lead types a CPF/CNPJ or e-mail in the conversation (common in a B2B prospecting context), that PII egresses to the external LLM via `historico`/`ultimaMensagem`. (D-16 in `02-03-PLAN.md` scoped masking to "telefone+endereço", so this is a documented residual — but the LGPD surface is broader than the scope.)

**Fix:** Add patterns and placeholders:

```ts
const RE_CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const RE_CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
```

and apply them in `maskTexto` (CNPJ before CPF, both before the phone rule).

## Info

### IN-01: `as Date` type assertions where the pg driver returns strings

**File:** `src/cli/shadow.ts:118,121`; `src/infra/db/queries/review-events.ts:120`

**Issue:** `openDb` registers no `pg` type parsers (`src/infra/db/client.ts`), so `TIMESTAMPTZ` is returned as a string at runtime; `criadoEm: row.created_at as Date` and `decididoEm: row.decidido_em as Date` are therefore type lies. Currently latent — `resumo()` (`shadow.ts:143-154`) only uses `r.texto.length`.

**Fix:** Convert explicitly (`new Date(row.created_at as string)`) or register the type parser in `openDb`.

### IN-02: Bake-off corpus uses a non-`Estado` value for `estado`

**File:** `scripts/bake-off.ts:92,95,100,125,145,160,175` (and the doc at `scripts/bake-off.ts:63`)

**Issue:** `Transcript.estado` is documented as the "Estado AUTORITATIVO que o `resolveNextState` escolheria", but seven transcripts use `"contorno_objecao"`, which is not one of the nine `Estado` values (`transitions.ts:14-23`). Because `GenerateInput.resolvedState` is typed `string` (`LlmPort.ts:107`), this passes typecheck silently. The harness feeds the model an impossible state, weakening the bake-off's fidelity.

**Fix:** Replace `"contorno_objecao"` with a valid `Estado` (e.g. `"qualificando"`) in the affected transcripts.

### IN-03: Media path does not advance the processing watermark

**File:** `src/application/inbound-handler.ts:595-599`

**Issue:** `registrarMidiaRecebida` is invoked and the function returns before the watermark update at `inbound-handler.ts:688-693`. A re-delivered media event therefore re-inserts a `blocked_attempts` row (the `messages`-based idempotency key does not apply to media). Low impact (media handoff is idempotent via `handoff-service.ts:138-145`), but the "processed" cursor does not reflect that the media event was handled.

**Fix:** Advance `last_processed_at` for media events as well, or key media dedup on `providerMsgId`.

---

## Re-review pós-gap-closure (02-04)

**Reviewed:** 2026-10-14T18:45:11Z
**Diff:** `40ae4ca..HEAD` (`b55eeca`)
**Depth:** standard (foco: gap-closure)
**Status:** clean — as duas Critical do review original estão fechadas e nenhum achado novo (BLOCKER/WARNING) foi introduzido pelo diff de gap.

Escopo desta re-revisão: apenas o diff `40ae4ca..HEAD` (plano `02-04`). As 6 warnings e 3 infos originais (WR-01/02/03/04/05/06, IN-01/02/03) permanecem **fenceadas** e não foram re-flagadas — o diff não as piorou.

### CR-01 → RESOLVED ✅

**Predicado** (`src/application/inbound-handler.ts:120-128`): `deveMarcarPrimeiroContatoHumano` agora recebe `{ fromMe, senderPhoneE164, channelPhoneE164 }` e compara o **EMISSOR** E.164:

```ts
if (opts.fromMe !== true) return false;
if (!opts.senderPhoneE164 || !opts.channelPhoneE164) return false;
return opts.senderPhoneE164 === opts.channelPhoneE164;
```

- **Nunca mais compara `chatId`/`remoteJid` com E.164** — a comparação defeituosa do CR-01 foi removida (era `opts.chatId === opts.channelPhoneE164`). Fail-closed: `fromMe !== true` ou emissor ausente/vazio → `false`.
- **Call site do passo (d)** (`src/application/inbound-handler.ts:622-627`) passa `senderPhoneE164: evt.senderPhoneE164`.
- **Carimbo no runtime** (`src/channel/baileys/runtime.ts:108-114`): `fromMe === true` → `normalizeJid(canalSelfJid).e164`; senão → `normalizeJid(chatId).e164`; `canalSelfJid` ausente → `undefined`. Propagado em `runtime.ts:163` (`criarEventoInbound(mensagem, deps.canalSelfJid?.())`).
- **Fiação de boot** (`src/index.ts:275`): `canalSelfJid: () => sock.user?.id` (getter; `sock.user` só existe pós-registro).
- **A transição realmente acontece** (`src/application/inbound-handler.ts:632-660`): seta `first_contact_by_human = true` (linha 632-635) e, dentro de uma `db.transaction`, faz `UPDATE conversations.state` + `recordStatusChange(..., changedBy: "admin")` (linhas 644-659) — `novo → aquecimento` auditado (R-022).

**Evidência de que é alcançável em produção (não só em teste):**
- `sock.user` é getter que devolve `authState.creds.me` (Baileys `lib/Socket/socket.js:931-933`), populado no login/pareamento — logo disponível em `connection === 'open'` e por mensagem. `sock.user.id` tem a forma `5511999999999[:device]@s.whatsapp.net`; `normalizeJid` (via `jidNormalizedUser`+`jidDecode`) devolve `+5511999999999`, que casa com `env.CHANNEL_PHONE_E164` (validado por `env.ts:48-50` como `/^\+[1-9][0-9]{7,14}$/`).
- Único call site do predicado é o passo (d) — grep repo-wide confirma.
- Testes verdes executados: `tests/channel/evento-inbound.test.ts` (3/3), `tests/application/inbound-fromme.test.ts` + `tests/application/handoff-intents.test.ts` (13/13). `npm run typecheck` exit 0.
- Teste **não-tautológico**: a re-implementation local de `deveMarcarPrimeiroContatoHumano` foi removida (o teste importa a função REAL, `inbound-fromme.test.ts:19-22`); o property test (`inbound-fromme.test.ts:395-434`) exercita a função real com os 4 ramos forçados; o **Teste F composicional** (`inbound-fromme.test.ts:356-392`) encadeia de verdade `WAMessage(fromMe) → criarEventoInbound → processInboundFromMe` com `chatId` = JID do lead — exatamente a costura cross-módulo que o bug CR-01 quebrou. O RED precede o GREEN no git (`757f728` antes de `aacaa69`).
- Testes ajustados (`qualification.test.ts:460-500`, `shadow.test.ts:382-421`) **preservaram** todas as asserções (`state=aquecimento`, `first_contact_by_human=true`, `status_history.changed_by='admin'`, `0` rascunhos) — apenas a construção do evento foi atualizada ao novo contrato.

### CR-02 → RESOLVED ✅

- `"duvida_complexa"` presente no conjunto **exportado** `INTENCOES_HANDOFF` (`src/application/inbound-handler.ts:82-91`), com os 8 intents requeridos.
- Consumido por `precisaHandoff` (`inbound-handler.ts:498-505`: `INTENCOES_HANDOFF.has(intent) || …`) → dispara `dispararHandoff` (`inbound-handler.ts:507-522`) na mesma transação atômica, com silêncio (sem `generate`, sem rascunho).
- `triggeredByDoGatilho` mapeia o default para `"intent"` (`inbound-handler.ts:341-355`), confirmado no e2e.
- Teste de contrato (`tests/application/handoff-intents.test.ts:197-211`) trava EXATAMENTE os 8 intents; o e2e (`handoff-intents.test.ts:214-277`) prova `handoff_events(triggered_by='intent', trigger_value='duvida_complexa')` + `mode_changes(to_mode='awaiting_human')` + `conversations(engagement_mode='awaiting_human', handoff_active=true, state='awaiting_human')` + `llm.chamadas === ["extract"]` + `0` `ai_suggestion`. RED (`0a51cc5`) precede GREEN (`2e3c56d`).

### Novos achados no diff de gap

Nenhum achado **BLOCKER** ou **WARNING** introduzido. Duas observações **Info**:

#### IN-04 (novo): doc-comment de `senderPhoneE164` diz `undefined`, mas o ramo LID carimba `null`

**File:** `src/application/event-bus.ts:38-39` (doc) x `src/channel/baileys/runtime.ts:109-114`
**Issue:** O comentário diz *"undefined quando não derivável"*, mas quando `canalSelfJid` existe e resolve para LID, `normalizeJid(...).e164` devolve `null` (não `undefined`). O tipo `string | null | undefined` cobre ambos e o predicado trata os dois como fail-closed, então é inofensivo — é imprecisão de documentação.
**Fix:** Trocar o texto para `"null/undefined quando não derivável"`.

#### IN-05 (novo): warn de LID dispara por `connection === 'open'` (por conexão), não "uma vez no boot"

**File:** `src/index.ts:276-290`
**Issue:** O `log.warn { event: "jid_proprio_sem_e164" }` está dentro de `aoConectar`, invocado a cada `connection === 'open'` (inclusive reconexões). É o que o plano descreveu ("UM warn por abertura de conexão, nunca por mensagem") e o volume é baixo, mas num socket instável (flapping) o warn se repete a cada reconexão — não é "uma vez no boot" como o `02-04-PLAN.md` fraseia. Não há risco de spam por mensagem.
**Fix:** Nenhum obrigatório; se quiser literalizar "uma vez", guardar com um flag de módulo (`let avisouLid = false`) — opcional.

### Nota de escopo (não é achado novo)

- **WR-03 fechado apenas na METADE admin.** O passo (d) do caminho do Admin agora é transacional (resolvido). A metade IA (`rascunharShadow`, `src/application/inbound-handler.ts:528-541`) permanece `UPDATE conversations` + `recordStatusChange` sem transação — **explicitamente fenceada** em `02-04-PLAN.md` ("WR-03 metade IA … FORA de escopo") e não piorada pelo diff. Continua aberta, por decisão de escopo.
- O `UPDATE leads set first_contact_by_human = true` (linha 632-635) permanece **fora** da transação do passo (d), por escolha documentada (idempotente por construção + trigger R-024). Se a transação de estado falhar, o flag fica `true` com o estado ainda `novo`; a próxima mensagem `fromMe` re-tenta a transição (auto-corrige). Sem perda de dado.

---

_Reviewed: 2026-10-14T11:32:17Z_
_Re-review: 2026-10-14T18:45:11Z (gap-closure 02-04)_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
