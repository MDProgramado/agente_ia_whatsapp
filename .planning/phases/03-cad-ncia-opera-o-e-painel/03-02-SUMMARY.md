---
phase: 03-cad-ncia-opera-o-e-painel
plan: 02
subsystem: application
tags: [croner, pg-boss-like, outbox, follow-up, catch-up, baileys, scheduler, tdd, vitest]

# Dependency graph
requires:
  - phase: 03-cad-ncia-opera-o-e-painel
    provides: "`src/domain/cadence.ts` (`proximaTentativa` ancorada / `cadenciaEncerrada` / `maxToques`), `src/domain/business-hours.ts` ciente de feriado, `src/infra/db/queries/settings.ts` (`lerMaxToques`/`lerFeriadosOverride`), índice único parcial da migração 0007"
  - phase: 01-funda-o-canal-e-gate-de-envio
    provides: "`dispatch()` como choke-point único de `sendText`, `ChannelPort`, `loadGateSnapshot`/`evaluatePolicy`, `conversations.last_outbound_at`/`closed_reason`, `outbox` (reserveNext/markSent/markDeferred/abandon), `application/scheduler` de fase anterior (nada disso foi tocado)"
  - phase: 02-ia-externa-e-modo-sombra
    provides: "padrão `worker`/`dispatcher`, `CAP_MENSAGENS`, `choke-point.grep.test.ts` como invariante de arquivo, `inbound-handler.ts` (gravador de `messages` + `last_processed_at`)"
provides:
  - "`src/application/scheduler.ts`: `startScheduler({db, now, feriados, maxToques})` — tick 30s PRODUTOR do `outbox` (agendar → cancelarInterrompidos → reconciliar → encerrar → re-agendar), nunca sender"
  - "`src/infra/db/queries/scheduler.ts`: `candidatosEmCadencia`, `pendentesForaDeCadencia`, `reconciliar`, `scheduledTaskPendente`, `vencidosNoOutbox`, `jaEnviouFollowUpHoje`, `marcarCatchupIminente`, `conversasParaEncerrar`, `cancelarCadenciaPendente`"
  - "`src/application/catchup-drain.ts`: `drenarCatchup` (REAGENDADOR FIRE_ONCE: ≤3 iminentes com jitter 3–12s, o resto adiado — nunca descarta) e `encerrarCadenciasSemResposta` (4º toque sem inbound → `state='encerrado'` + `closed_reason='sem_resposta'` + `status_history`)"
  - "`src/application/inbound-handler.ts`: inbound de texto grava `gravarMensagem` + `cancelarCadenciaPendente` NA MESMA transação; `fromMe` do número dedicado ancora `last_outbound_at`"
  - "Motor fiado no boot: `src/index.ts` sobe catch-up + `drainLoop` + `startScheduler` depois do `migrate()` e do canal, e para tudo no SIGINT/SIGTERM antes do socket e do pool"
affects: [03-03 (painel), 03-04, 03-05 (pipeline_status)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Produtor/sender separação: scheduler e dreno escrevem `scheduled_tasks`/`outbox`; o ÚNICO choke-point de `sendText` continua sendo o `dispatcher`, provado por grep"
    - "Cancelamento transacional: o registro do inbound cancela `scheduled_tasks` (→ `abandoned` + `cancelled_reason`) e o job de `outbox` dentro da MESMA transação do INSERT de `messages` (Pitfall 3 / T-03-06)"
    - "Dreno é REAGENDADOR: escolhe quem pode sair (`marcarCatchupIminente`) e quem espera (`markDeferred`); nunca envia e nunca descarta (WHS-02/D-07)"
    - "Encerramento por não-resposta usa o WATERMARK de inbound (`last_inbound_at < last_outbound_at`), nunca read-receipt (D-12)"
    - "Relógio injetável em TODO ciclo: `startScheduler` recebe `now: () => Date` e `drainLoop` recebe `agora: () => Date` — um `Date` fixo congelaria janela e cota no instante do boot"
    - "Encerramento gracioso: o motor que escreve no banco para ANTES de `closeDb`, e o socket fecha antes do pool (armadilha do `useMultiFileAuthState`)"

key-files:
  created:
    - src/application/catchup-drain.ts
    - tests/application/catchup-drain.test.ts
  modified:
    - src/infra/db/queries/scheduler.ts
    - src/application/scheduler.ts
    - src/application/inbound-handler.ts
    - src/application/outbox-worker.ts
    - src/index.ts
    - tests/application/scheduler.test.ts

key-decisions:
  - "`drenarCatchup` é um REAGENDADOR, não um sender: `key_links` + o padrão \"scheduler e dreno NUNCA importam nem chamam `dispatch`\" (PATTERNS) vencem o analog `drainOnce`. O envio real continua no `drainLoop`."
  - "Jitter do dreno em faixa 3–12s (ADR-009 / PATTERNS l.183), determinístico por sha256 local — e NÃO via `humanDelayMs`, cuja faixa FOLLOWUP é 2.5–6s e ficaria FORA do que o ADR determina para o catch-up."
  - "`sleep` do dreno é injetável com default real: o dreno dorme o jitter e atribui `scheduled_for = now + offsetAcumulado` (≤36s para os 3 iminentes, dentro dos 10 min por construção)."
  - "`pipeline_status` não existe nesta wave (D-14/03-CONTEXT l.51 é camada do 03-05): o encerramento grava `conversations.state='encerrado'` + `closed_reason='sem_resposta'` + `status_history{to_state:'encerrado', changed_by:'bot', reason:'sem_resposta'}`. \"Perdido\" é rótulo de CRM, não estado de máquina."
  - "`isCatchupDrain` é decidido NO BOOT como parâmetro (`const CATCHUP_DRAIN_FIRME = true`) e nunca lido de `settings`: um operador não pode religar um dreno que já rodou, ou o R-007 vira um loop de reenvio."
  - "O catch-up roda em background no boot (`void drenarCatchup(...)`): ele só reagenda jobs, então não precisa atrasar a subida do processo em ~36s."
  - "Feriados no boot = `feriadosNacionais(ano)` + `feriadosNacionais(ano+1)` + `lerFeriadosOverride(db)`: o processo pode atravessar a virada e ainda assim saber que 01-01 é feriado."
  - "`newContactsToday` entra no `ctx` lido uma vez no boot (hoje é declarado mas ainda não é consumido por nenhuma regra do gate); `sentToday` continua sendo atualizado a cada job por `channel.readQuota`."
  - "`drainLoop` ganha o gancho opcional `agora?: () => Date` (default `deps.now`, comportamento de quem já testa preservado): sem ele o `WorkerDeps.now` estático faria todo job da vida do processo ser avaliado contra o instante do boot."

patterns-established:
  - "Bug de `fromMe`/watermark: um echo `fromMe` NÃO pode atualizar `last_inbound_at`, senão ele mesmo mata o predicado `last_inbound_at < last_outbound_at` que inicia a cadência — watermark atualiza só `last_processed_at` no ramo `fromMe`."
  - "Teste de dreno com `sleep` no-op e `scheduled_for` inspecionado no banco: o que se prova é o AGENDAMENTO (≤3 iminentes nos primeiros 10 min, resto em `pending` na próxima janela, zero `abandoned`), não o envio."
  - "`status_history` só por `recordStatusChange`: o encerramento é transação de UPDATE + auditoria, e o `to_state` é o valor REAL de `conversations.state`."

requirements-completed: [WHS-02, FLUP-01, FLUP-02, FLUP-03]

# Metrics
duration: 52min
completed: 2026-10-16
---

# Phase 3 Plan 02: Cadência operacional e dreno de catch-up Summary

**Tick de 30s que só produz `outbox` + cadência 1h→1d→3d→7d com encerramento `sem_resposta` no 4º toque, dreno FIRE_ONCE de catch-up limitado a 3 iminentes (jitter 3–12s, resto adiado) e cancelamento transacional no inbound — tudo fiado no boot com shutdown que não corrompe a sessão Baileys**

## Performance

- **Duration:** 52 min
- **Started:** 2026-10-16T14:20:00Z
- **Completed:** 2026-10-16T15:12:00Z
- **Tasks:** 3 (Task 2 em TDD, RED antes do GREEN)
- **Files modified:** 8 (2 criados, 6 modificados)
- **Suíte:** 324 testes / 59 arquivos verdes (era 324/59 antes? não — 03-01 fechou em 312/57; este plano soma 12 testes e 2 arquivos)

## Accomplishments

- **O bot passa a rodar sozinho** (D-03/D-04, FLUP-01/02/03): `startScheduler` é um tick de 30s que lê estado e chama `enqueue` — agendar → cancelar interrompidos → reconciliar → encerrar → re-agendar. Idempotência em três barreiras (índice único parcial da 0001, `outbox.idempotency_key` e `messages.idempotency_key`); `scheduled_for` é projetado de `last_outbound_at` e o tick compara, **nunca reancora** (Pitfall 2 / T-03-08).
- **Rajada de segunda de manhã é impossível por construção** (WHS-02/D-07/T-03-05): `drenarCatchup` libera no máximo 3 iminentes com jitter 3–12s determinístico dentro dos primeiros 10 minutos e **adia** (nunca descarta) o resto para a próxima janela. O teste "20 vencidos" prova `enviados=3`, o resto `pending` e zero `abandoned`.
- **Resposta do lead cancela a cadência na mesma transação** (Pitfall 3/T-03-06): `gravarMensagem` + `cancelarCadenciaPendente` correm numa única transação, então não existe janela em que um `scheduled_tasks` pendente sobreviva a um inbound de texto.
- **4º toque sem resposta encerra com rastro** (D-12/D-13): `state='encerrado'` + `closed_reason='sem_resposta'` + `status_history` (`changed_by='bot'`, `reason='sem_resposta'`) na mesma transação, pelo watermark de inbound — read receipts não contam.
- **Motor fiado no boot**: `src/index.ts` cria o `ChannelPort`, roda o catch-up, sobe o `drainLoop` e o `startScheduler` depois do `migrate()` e do canal; SIGINT/SIGTERM param o motor ANTES do socket e do pool.
- **Suíte verde e limpa:** `npm test` → 324 testes / 59 arquivos; `npm run typecheck` limpo; `npm run lint` → 0 erros (16 warnings pré-existentes de `noNonNullAssertion` em testes de outras fases, nenhum em arquivo tocado por este plano).

## Task Commits

Cada task foi commitada atomicamente (Task 2 em TDD, com RED antes do GREEN):

1. **Task 1: Tick 30s do scheduler produtor + reconciliador + cancelamento auditável** — `24288f4` (feat) — 3 arquivos, +1005
2. **Task 2 (RED): Testes do dreno de catch-up e do encerramento por não-resposta** — `70e34a6` (test) — 1 arquivo, +465
3. **Task 2 (GREEN): Dreno de catch-up, encerramento por não-resposta e cancelamento no inbound** — `1136409` (feat) — 4 arquivos, +457/−8
4. **Task 3: Fiar o motor da cadência no boot** — `5a49f7a` (feat) — 2 arquivos, +142/−1

**Plan metadata:** este SUMMARY.

## Files Created/Modified

- `src/infra/db/queries/scheduler.ts` — Task 1: `candidatosEmCadencia`, `pendentesForaDeCadencia`, `reconciliar`, `scheduledTaskPendente`. Task 2: `vencidosNoOutbox` (compara `o.scheduled_for <= (now::timestamptz AT TIME ZONE c.timezone)`), `jaEnviouFollowUpHoje`, `marcarCatchupIminente`, `conversasParaEncerrar` (exclui `encerrado|pausado|awaiting_human|human|copilot`), `cancelarCadenciaPendente`
- `src/application/scheduler.ts` — `startScheduler(deps) → {stop, tick}`; `CRON_PADRAO="*/30 * * * * *"`; textos dos 4 toques verbatim de `docs/07`§6 com variação por sha256; `SchedulerDeps{db, now, feriados, maxToques, cronPattern?}`
- `src/application/catchup-drain.ts` — **NOVO.** `drenarCatchup(db, {now, isCatchupDrain, feriados?, limite?, sleep?}) → {enviados, adiados}`; `jitterDe(seed)` sha256 em [3000, 12000]; `encerrarCadenciasSemResposta(db, {now, maxToques}) → {encerradas}`
- `src/application/inbound-handler.ts` — transação `gravarMensagem` + `cancelarCadenciaPendente(tx, id, "resposta_do_lead")`; `fromMe` do número dedicado → `update conversations set last_outbound_at = now()`; watermark `fromMe` só toca `last_processed_at`
- `src/application/outbox-worker.ts` — `DrainLoopOpts.agora?: () => Date` (gancho de relógio fresco por iteração)
- `src/index.ts` — etapa (l) do boot: `criarBaileysChannel` → `drenarCatchup` (FIRE_ONCE, background) → `drainLoop` (AbortController + `agora`) → `startScheduler`; shutdown para motor antes do socket/pool
- `tests/application/scheduler.test.ts` — 4 casos (agendamento ancorado, idempotência entre ticks, cancelamento auditável, reconciliador)
- `tests/application/catchup-drain.test.ts` — **NOVO.** 8 casos: 4 de dreno ("segunda de manhã" 20 vencidos, fora da janela, 1/lead/dia, `isCatchupDrain=false` no-op), 2 de encerramento, 1 de cancelamento no inbound, 1 de sanidade do sha256

## Decisions Made

- **`drenarCatchup` é um REAGENDADOR, não um sender.** O `key_links` e o padrão "scheduler e dreno NUNCA importam nem chamam `dispatch`" vencem o analog com `drainOnce`. Isso preserva o invariante do choke-point: um dreno que enviasse teria de reimplementar o gate — exatamente o "envio sem gate" que `choke-point.grep.test.ts` transforma em falha de suíte (T-03-07).
- **Jitter 3–12s local, não `humanDelayMs`.** O ADR-009 e o PATTERNS l.183 determinam a faixa 3–12s para o catch-up; `humanDelayMs("followup")` entrega 2.5–6s e ficaria fora do intervalo decidido. `humanDelayMs` continua sendo o humanizador do envio no `dispatcher`; aqui é só o espaçamento do agendamento.
- **`sleep` injetável com default real.** Os testes passam `sleep: async () => {}` e inspecionam o `scheduled_for` resultante; produção dorme de verdade (até ~36s para os 3 iminentes, dentro dos 10 min por construção).
- **Encerramento em `conversations.state='encerrado'`, não em "Perdido".** `pipeline_status` é D-14/03-CONTEXT l.51 e camada do plano **03-05** (migration nova). Nesta wave o estado real de máquina é `'encerrado'` e o rótulo de CRM fica para depois — gravar um valor que não existe no CHECK/FSM seria um falso estado.
- **`isCatchupDrain` no boot, não em `settings`.** `const CATCHUP_DRAIN_FIRME = true` em `src/index.ts`: religar um dreno já consumido viraria loop de reenvio, que é o padrão de banimento que o ADR-009 existe para evitar.
- **Catch-up em background.** `void drenarCatchup(...).catch(log)`: ele só reagenda (não envia), então não há razão para segurar a subida do processo por ~36s de jitter. Mesmo padrão de `void lerCapacidades()` já usado no boot.
- **Feriados com ano corrente + próximo.** O processo pode atravessar a virada; sem o `ano+1`, 01-01 deixaria de ser feriado no relógio do sistema a partir de 00:00 do dia 1.
- **Relógio fresco no `drainLoop`.** `WorkerDeps.now` é um `Date`; sem o gancho `agora`, quem fia o laço no boot congelaria a janela operacional (AR-007) e a cota do dia (R-023) no instante do boot, e `reserveNext` continuaria devolvendo jobs vencidos relativos àquele instante.
- **Shutdown com ordem corrigida.** O motor da cadência escreve no banco, então `motorScheduler.stop()` + `motorDreno.abort()` rodam ANTES de `canalSock.end()` e `closeDb(conn)`. O monitor de saúde e o cron do relatório continuam parando por último (são leves).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Nada escrevia `last_outbound_at` — a cadência nunca começaria**
- **Found during:** Task 2 (grep em `src/**` antes de implementar o encerramento)
- **Issue:** O predicado que inicia a cadência é `last_inbound_at < last_outbound_at`, mas nenhuma linha de produção gravava `last_outbound_at`. Em produção a cadência ficaria permanentemente silenciosa: `candidatosEmCadencia` nunca devolveria ninguém e os 4 toques do ADR-009 nunca sairiam.
- **Fix:** No ramo `fromMe` do `inbound-handler.ts` (o echo do número dedicado, a única fonte autorizada de "nós falamos"), `deveMarcarPrimeiroContatoHumano` decide e grava `last_outbound_at = now()`.
- **Files modified:** `src/application/inbound-handler.ts`
- **Verification:** `npm test` verde (suíte de `inbound-fromme`); typecheck limpo.
- **Committed in:** `1136409` (Task 2 GREEN)

**2. [Rule 1 - Bug] O echo `fromMe` matava o próprio predicado da cadência (watermark)**
- **Found during:** Task 2, ao rastrear por que `last_outbound_at` passaria a ser maior que `last_inbound_at` e nada mais funcionaria
- **Issue:** Com a correção acima, o handler atualizava `last_processed_at` **e** `last_inbound_at` em QUALQUER inbound. O echo `fromMe` do número dedicado subiria `last_inbound_at` para cima de `last_outbound_at` — invertendo o predicado. A conversa ficaria travada: o bot enviou, o próprio eco a rebaixaria, e a cadência nunca avançaria.
- **Fix:** Watermark final: no ramo `fromMe` só `last_processed_at` é atualizado; `last_inbound_at` só sobe para mensagens reais do lead (`fromMe !== true`).
- **Files modified:** `src/application/inbound-handler.ts`
- **Verification:** Suíte completa 324/324 verdes; o teste de inbound do catch-up cobre o cancelamento no ramo do lead.
- **Committed in:** `1136409` (Task 2 GREEN)

**3. [Rule 2 - Missing Critical] `drainLoop` avaliaria todos os jobs contra o instante do boot**
- **Found during:** Task 3 (ler `outbox-worker.ts` antes de fiar no boot)
- **Issue:** `drainOnce` lê `deps.now`, um `Date` estático. Fiar o laço no boot passaria o mesmo instante para sempre: a janela operacional e a cota do dia congelariam, e `reserveNext` continuaria devolvendo jobs "vencidos" relativos àquele instante, em loop, para sempre.
- **Fix:** `DrainLoopOpts.agora?: () => Date` (o plano já previa explicitamente expor um gancho de injeção sem alterar comportamento de produção) e `drainOnce(db, {...deps, now: relogio()}, opts)` a cada iteração. O default (`deps.now`) preserva o comportamento de quem já passa um relógio explícito.
- **Files modified:** `src/application/outbox-worker.ts`
- **Verification:** `npm run typecheck` limpo; `npm test` → 324/324.
- **Committed in:** `5a49f7a` (Task 3)

**4. [Rule 2 - Missing Critical] Shutdown fechava o pool com o motor ainda ativo**
- **Found during:** Task 3, ao adicionar o shutdown gracioso do scheduler/drain
- **Issue:** A ordem existente era socket → pool → motor. O motor da Fase 1 (monitor de saúde, cron do relatório) é leve, mas o scheduler e o `drainLoop` **escrevem** no banco; um tick que disparasse durante o `closeDb` cairia no meio do fechamento do pool e gravaria `scheduled_tasks` pela metade.
- **Fix:** `motorScheduler.stop()` + `motorDreno.abort()` movidos para logo depois do `clearInterval(keepAlive)`, ANTES de `canalSock.end()` e `closeDb(conn)`. O monitor/cron continuam por último.
- **Files modified:** `src/index.ts`
- **Verification:** Ordem conferida por `grep` de linha: `keepAlive` → `motorScheduler.stop()` → `motorDreno.abort()` → `canalSock.end()` → `closeDb(conn)`.
- **Committed in:** `5a49f7a` (Task 3)

---

**Total deviations:** 4 auto-fixed (2 Rule 1, 2 Rule 2)
**Impact on plan:** Nenhum scope creep. Duas eram lacunas de implementação que deixariam a cadência permanentemente inerte (âncora `last_outbound_at`, relógio congelado) — i.e., o plano prometia um bot que roda sozinho e o entregaria morto. Uma era um bug de watermark que a própria correção anterior introduziria; a última é a ordem de shutdown exigida pelo fato novo de que o motor passa a escrever no banco.

## Deferred / Known Limitations

**1. O bot não reancora `last_outbound_at` quando ELE envia**
O fix `fromMe` cobre o envio manual do Admin (R-001: a primeira mensagem). Quando a geração de resposta pelo LLM existir (fase futura), o reply automático do bot também precisa ancorar — o ponto natural é `dispatcher.ts`/`outbox-worker.ts` após `sent`. **`src/application/dispatcher.ts` e `src/application/outbox.ts` não constam de `files_modified` deste plano**, então isso ficou fora de escopo deliberadamente. Até lá, a cadência só inicia após um envio manual do Admin, que é exatamente o fluxo do MVP (R-001).

**2. `pipeline_status` ("Perdido") é camada do 03-05**
O plano (behavior bullet) sugeria `status_history → "Perdido"`; o valor real gravado é `'encerrado'`, que é o que existe em `conversations.state` e no FSM. O rótulo de funil CRM entra com a migration nova do 03-05 (D-14/03-CONTEXT l.51).

**3. `newContactsToday` no `ctx` é lido uma vez no boot**
Hoje é o único campo do `ctx` que não é atualizado por job. Nenhuma regra do gate consome esse valor ainda (grep confirma só a declaração em `domain/gate/types.ts:84`), então não há bug corrente; quando a regra R-023 "novos leads/dia" for implementada, o valor precisa passar a ser fresco — o lugar é o próprio `dispatch`, junto do `readQuota`.

**4. Warnings de lint pré-existentes (fora de escopo)**
`npm run lint` reporta 16 warnings `noNonNullAssertion` em `tests/application/inbound-fromme.test.ts`, `lead-importer.test.ts`, `db/scheduled-tasks-index.test.ts` e `shadow-mode-migration.test.ts` — todos de outras fases e nenhum em arquivo tocado por este plano. Exit code 0; fora da fronteira de escopo.

## Issues Encountered

- **Nenhum bloqueio.** As duas decisões que precisavam ser resolvidas antes de escrever código (forma do encerramento sem `pipeline_status`, e faixa do jitter vs `humanDelayMs`) foram resolvidas por leitura das fontes de verdade (03-CONTEXT l.51, ADR-009, PATTERNS l.183) antes da implementação, e estão registradas em `key-decisions`.
- **Descoberta de plataforma:** `db.execute` cru devolve `timestamp` (naive) como **string**; por isso todas as queries do scheduler convertem via `(extract(epoch from (naive AT TIME ZONE c.timezone)) * 1000)::bigint` e comparam janela com `<= (${now}::timestamptz AT TIME ZONE c.timezone)`. Sem isso, `outbox.scheduled_for` (naive) comparado contra `now()` cru seria adiantado em 3h.

## User Setup Required

None — nenhum serviço externo, nenhuma variável de ambiente nova, nenhum pacote npm instalado (croner, drizzle, pg e os domínios da 03-01 já estavam presentes — T-03-SC).

## Next Phase Readiness

- **Pronto para o 03-03 (painel):** o motor roda sozinho e todo o estado que o painel precisa ler existe e é auditável — `scheduled_tasks` (com `cancelled_reason`), `outbox`, `status_history` (`reason='sem_resposta'`) e `conversations.closed_reason`.
- **Atenção do 03-05:** `pipeline_status` é a coluna nova que completa o funil de 9 status; o encerramento por não-resposta deste plano já grava `status_history`, então o backfill de "Perdido" tem trilha para ler.
- **Risco de banimento (R-059) mitigado, não zerado:** o dreno de catch-up é o controle desta wave. O próximo risco real é o volume de envio do reply automático, que depende da geração de resposta (fase futura) — o `drainLoop` + gate reavaliado por job já é a válvula por onde isso vai sair.
- **Nada aqui toca o WhatsApp.** Scheduler e dreno são 100% determinísticos e escrevem só no banco; o único `sendText` do processo continua sendo o `dispatcher`.

---
*Phase: 03-cad-ncia-opera-o-e-painel*
*Completed: 2026-10-16*

## Self-Check: PASSED

- Arquivos do plano: 8/8 encontrados em disco (`src/application/catchup-drain.ts` e `tests/application/catchup-drain.test.ts` criados; `queries/scheduler.ts`, `application/scheduler.ts`, `application/inbound-handler.ts`, `application/outbox-worker.ts`, `src/index.ts` e `tests/application/scheduler.test.ts` modificados).
- Commits: `24288f4`, `70e34a6`, `1136409`, `5a49f7a` — todos presentes no histórico (`git log --oneline`).
- Verificações do plano: `npm test` → 324 testes / 59 arquivos verdes; `npm run typecheck` limpo; `npm run lint` → 0 erros.
- AC da Task 3: `grep` de `startScheduler|drainLoop|drenarCatchup` em `src/index.ts` → 13 ocorrências (≥ 1); ordem `openDb`(151) → `channel_ready`(392) → `drenarCatchup`(532) → `drainLoop`(556) → `startScheduler`(584) confirmada.
- Invariante de choke-point: `grep -c sendText` em `src/index.ts` → 0; `grep -c "sendText|dispatch\("` em `src/application/scheduler.ts` + `src/application/catchup-drain.ts` → 0.
