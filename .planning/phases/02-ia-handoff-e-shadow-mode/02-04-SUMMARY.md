---
phase: 02-ia-handoff-e-shadow-mode
plan: 04
subsystem: application/orchestrator
tags: [handoff, intents, whatsapp, baileys, lid, tdd, postgres, drizzle]

# Dependency graph
requires:
  - phase: 02-ia-handoff-e-shadow-mode
    provides: "02-01 envelope Zod/FSM + adaptadores + inbound em shadow; 02-02 handoff atômico + opt-out + qualificação; 02-03 pós-gate + kill switch + relatório"
provides:
  - "Guard 0 (deveMarcarPrimeiroContatoHumano) comparando o EMISSOR E.164 com CHANNEL_PHONE_E164 (CR-01)"
  - "EventoInbound.senderPhoneE164 carimbado pelo runtime Baileys (fromMe → id próprio; senão → remoteJid)"
  - "duvida_complexa no mapeamento INTENCOES_HANDOFF (Camada 2, CR-02/FLUP-09)"
  - "Passo (d) do inbound transacional (UPDATE conversations.state + status_history numa única transação)"
  - "Warn localizado jid_proprio_sem_e164 no aoConectar (id próprio em LID sem E.164)"
affects: [03, 04, fases de operação/piloto]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Identidade de emissor por E.164 explícito (nunca inferida do chatId) para distinguir Admin de lead"
    - "Teste de contrato sobre conjunto-constante exportado (INTENCOES_HANDOFF) como trava de especificação"
    - "Teste composicional WAMessage→criarEventoInbound→processInboundFromMe para costuras cross-módulo"

key-files:
  created:
    - tests/channel/evento-inbound.test.ts
    - tests/application/handoff-intents.test.ts
  modified:
    - src/application/event-bus.ts
    - src/channel/baileys/runtime.ts
    - src/index.ts
    - src/application/inbound-handler.ts
    - tests/application/inbound-fromme.test.ts
    - tests/application/qualification.test.ts
    - tests/application/shadow.test.ts

key-decisions:
  - "Guard 0 compara igualdade EXATA entre senderPhoneE164 e channelPhoneE164 (fail-closed): ausência de E.164 nunca marca first_contact_by_human"
  - "senderPhoneE164 é carimbado no runtime (fronteira do canal), não no handler — o handler não conhece JIDs nem LID"
  - "Warn jid_proprio_sem_e164 é emitido UMA vez no boot (aoConectar), não por mensagem, para o operador diagnosticar pareamento LID"
  - "INTENCOES_HANDOFF passa a ser exportado para permitir teste de CONTRATO (a especificação de FLUP-09 vira teste, não comentário)"

patterns-established:
  - "Contrato de conjunto: a lista de intents de handoff é travada por teste de igualdade exata (8 itens)"
  - "E2E de handoff: 1 handoff_event + 1 mode_change + estado awaiting_human + silêncio (generate nunca chamado) provados na mesma transação"

requirements-completed: [CONV-01, FLUP-09]

# Metrics
duration: 5h 42m
completed: 2026-10-14
---

# Phase 02 Plan 04: Correções CR-01/CR-02 (Guard 0 pelo emissor + duvida_complexa) Summary

**Guard 0 passa a comparar o EMISSOR E.164 (não o chatId) com o número dedicado, `duvida_complexa` entra no mapeamento de handoff, e o passo (d) do inbound fica atômico — 5 commits TDD com suíte completa verde (274 testes).**

## Performance

- **Duration:** 5h 42m
- **Started:** 2026-10-14T12:49:41Z
- **Completed:** 2026-10-14T18:31:57Z
- **Tasks:** 3
- **Files modified:** 9 (2 criados)

## Accomplishments
- **CR-01 corrigido:** `deveMarcarPrimeiroContatoHumano` agora recebe `{fromMe, senderPhoneE164, channelPhoneE164}` e compara o emissor E.164 com `env.CHANNEL_PHONE_E164` (igualdade exata, fail-closed). Antes, com `chatId` sendo o JID do LEAD (como o runtime real produz), o Guard 0 nunca disparava — Admin abria conversa e o lead não era marcado.
- **Emissor carimbado na fronteira do canal:** `EventoInbound.senderPhoneE164` é resolvido por `criarEventoInbound(m, canalSelfJid?)` (fromMe → id próprio via `normalizeJid`; senão → `remoteJid`), com `canalSelfJid` fiado no boot a partir de `sock.user?.id`.
- **CR-02 corrigido:** `duvida_complexa` acrescentado a `INTENCOES_HANDOFF` (Camada 2/D-12); o enum do envelope já o previa, então o gatilho estava mapeado em nenhum lugar. Agora extração com `intent='duvida_complexa'` dispara `dispararHandoff` ponta-a-ponta.
- **Atomicidade (WR-03, caminho admin):** o `UPDATE conversations.state` + `recordStatusChange` do passo (d) passaram a rodar numa única `db.transaction`.
- **Diagnóstico LID:** warn único `jid_proprio_sem_e164` no `aoConectar` quando o id próprio não tem E.164 (para o operador identificar pareamento LID) — sem warn por mensagem.
- **Provas anti-tautologia:** property test sobre `deveMarcarPrimeiroContatoHumano` REAL (importado) + teste composicional `WAMessage→criarEventoInbound→processInboundFromMe`, a classe exata do bug CR-01.

## Task Commits

Each task was committed atomically (TDD → RED depois GREEN):

1. **Task 1: CR-01 — Guard 0 pelo emissor correto + atomicidade do passo (d)** - `757f728` (test/RED), `aacaa69` (fix/GREEN)
2. **Task 2: CR-02 — duvida_complexa como gatilho de handoff** - `0a51cc5` (test/RED), `2e3c56d` (fix/GREEN)
3. **Task 3: Gate final — suíte completa, typecheck e lint** - `1b40695` (style — ver deviações)

**Plan metadata:** _a ser commitado (docs: complete plan)_

_Nota: tasks TDD têm dois commits (test RED → fix GREEN)._

## Files Created/Modified
- `src/application/event-bus.ts` - `EventoInbound.senderPhoneE164?: string | null`
- `src/channel/baileys/runtime.ts` - `criarEventoInbound(m, canalSelfJid?)` carimba o emissor; `DepsHandlersCanal.canalSelfJid?`; doc-comment atualizado
- `src/index.ts` - boot fia `canalSelfJid: () => sock.user?.id`; warn único `jid_proprio_sem_e164` em `aoConectar`
- `src/application/inbound-handler.ts` - Guard 0 por E.164; `INTENCOES_HANDOFF` exportado e com `duvida_complexa`; passo (d) transacional; doc-comments atualizados
- `tests/application/inbound-fromme.test.ts` - comportamentos reescritos com `chatId` = JID do lead + `senderPhoneE164`; property test sobre a função real; teste composicional (criado/reescrito em `757f728`)
- `tests/channel/evento-inbound.test.ts` - carimbo de `senderPhoneE164` (fromMe com/sem `canalSelfJid`; não-fromMe) (criado em `757f728`)
- `tests/application/handoff-intents.test.ts` - contrato do conjunto (8 intents) + e2e `duvida_complexa` atômico/silencioso (criado em `0a51cc5`)
- `tests/application/qualification.test.ts` - ajustado ao novo contrato (`chatId` = JID do lead + `senderPhoneE164`)
- `tests/application/shadow.test.ts` - idem

## Decisions Made
- Guard 0 usa igualdade exata de E.164 com fail-closed: um emissor sem E.164 (LID) **não** marca `first_contact_by_human` — nunca marcar por engano é preferível a marcar errado.
- `senderPhoneE164` é carimbado no runtime (fronteira do canal); o handler permanece agnóstico a JID/LID.
- O warn de LID é de boot (uma vez), não por mensagem — evita poluir o log e mantém o sinal acionável.
- `INTENCOES_HANDOFF` exportado para que a especificação de FLUP-09 seja um teste de contrato (trava regressão por omissão).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Erros de FORMAT do biome em 2 arquivos do plano**
- **Found during:** Task 3 (Gate final — `npm run lint` retornou exit 1 com "Found 2 errors")
- **Issue:** `biome check .` reportou 2 erros de formato (`tests/application/handoff-intents.test.ts` e `tests/application/inbound-fromme.test.ts`) — não erros de lint semântico, mas o gate exige `lint` exit 0.
- **Fix:** `npx biome check --write` nos dois arquivos (apenas whitespace/indentação; sem mudança de comportamento). O gate foi reexecutado sobre a árvore final.
- **Files modified:** tests/application/handoff-intents.test.ts, tests/application/inbound-fromme.test.ts
- **Verification:** Gate final reexecutado: 51 arquivos / 274 testes verdes, typecheck 0, lint 0 erros (13 warnings).
- **Committed in:** `1b40695` (style)

### Ajustes de teste autorizados pelo plano

`tests/application/qualification.test.ts` e `tests/application/shadow.test.ts` foram ajustados (2 arquivos além dos 7 em `files_modified`) porque passaram a construir eventos inbound com `chatId` = JID do lead + `senderPhoneE164` — o novo contrato. Sem isso os testes existentes falhariam por contrato desatualizado, não por regressão. O plano autoriza ajustes de teste ao novo contrato. Commitados junto do GREEN de Task 1 (`aacaa69`).

---

**Total deviations:** 1 auto-fixed (1 blocking) + ajustes de teste autorizados pelo plano
**Impact on plan:** O auto-fix é puramente de formatação (sem risco). Os ajustes de teste são consequência direta e esperada do novo contrato CR-01. Nenhum scope creep: nenhum arquivo fora de escopo foi tocado (`handoff-service.ts`, `transitions.ts`, `post-gate.ts`, kill switch e D-18 ficaram intactos).

## Issues Encountered
- **RED do Task 1 produziu 5 falhas** (mais do que o esperado): o property test precisou ser escrito para realmente exercitar o ramo de igualdade não-vazia (caso contrário passaria tautologicamente). Ajustado antes de commitar o RED, garantindo que ele falha de fato.
- Nenhum outro problema: as costuras cross-módulo (runtime → event-bus → handler) foram validadas pelo teste composicional já no RED.

## User Setup Required
None - no external service configuration required. `CHANNEL_PHONE_E164` já está definido no `.env`.

## Next Phase Readiness
- **As duas Critical (CR-01, CR-02) do gate de saída da fase 02 estão fechadas e provadas por teste.**
- Nenhum bloqueio. `package.json` intocado (`git diff package.json` vazio) — nenhum pacote novo.
- Suíte completa verde (274 testes), typecheck e lint exit 0 — a fase 02 está pronta para o veredito do gate de saída (não reaberto por este plano).

---
*Phase: 02-ia-handoff-e-shadow-mode*
*Completed: 2026-10-14*

## Self-Check: PASSED

