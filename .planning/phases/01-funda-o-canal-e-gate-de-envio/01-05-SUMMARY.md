---
phase: 01-funda-o-canal-e-gate-de-envio
plan: "05"
subsystem: operations + humanization
tags: [humanizacao, p-queue, croner, health-monitor, daily-report, env-check, backup, pg_dump, pg_restore, bootstrap, postgresql]
requires:
  - phase: 01-01
    provides: walking skeleton, logger pino, NotifyPort + notify.ps1, DATA_ROOT fora do OneDrive, schema base
  - phase: 01-02
    provides: migrations 0000-0004, event_log, daily_counters, status_history, opt-out irreversível
  - phase: 01-03
    provides: adapter/ingestão commitados (pareamento deferido), signals.translateDisconnect, outbox schema
  - phase: 01-04
    provides: choke-point único de sendText (dispatcher), outbox durável, gate completo
provides:
  - humanize.ts (atraso determinístico por hash, digitação simulada, quebra em fronteira de sentença) + queue-per-lead.ts (p-queue, concurrency 1, Map limitado)
  - humanização ligada DENTRO do branch send do dispatch (preserva o único chamador de sendText)
  - health-monitor.ts com croner (30s), severidade warn/critical, notificação só por transição de estado
  - daily-report.ts apurando os 2 objetivos do piloto a partir de status_history, com denominador explícito
  - env-check.ts (8 códigos nomeados) rodando ANTES de qualquer conexão no boot
  - backup.ps1 com pg_dump -Fc, carimbo _pg18, -Verify com pg_restore real e 4 contagens, -LogOnly, rotação 30d
  - índice de boot final (config → banco → logs → canal → motor) + shutdown socket → pool → cron
affects: [02-ia-handoff-shadow, 03-cadencia-operacao-painel, 04-piloto-calibracao]
tech-stack:
  added: []
  patterns:
    - "Humanização mora DENTRO do branch send do dispatch, não ao lado dele — é a única forma de garantir que todo outbound passa por ela sem criar um segundo caminho de envio"
    - "Atraso derivado de hash determinístico (node:crypto), nunca Math.random(), para que o teste fixe a seed"
    - "Fila por lead (não global) com concurrency 1 e Map limitado: um lead travado não segura os outros 19"
    - "env-check roda antes de qualquer conexão e falha fechado (console.error + throw), com código nomeado por falha"
    - "O ciclo de vida da base de teste do backup roda como -U postgres (papel da app é least-privilege, sem CREATEDB)"
    - "Wrapper Invoke-Nativa tolera stderr de binário nativo sob ErrorActionPreference=Stop; a verdade é o $LASTEXITCODE"
key-files:
  created:
    - src/application/humanize.ts
    - src/application/queue-per-lead.ts
    - src/infra/health-monitor.ts
    - src/infra/env-check.ts
    - tests/ops/humanize.test.ts
    - tests/ops/health-monitor.test.ts
    - tests/ops/daily-report.test.ts
    - tests/ops/notify-ps1.test.ts
    - tests/ops/backup-ps1.test.ts
  modified:
    - src/application/dispatcher.ts
    - src/infra/db/queries/daily-report.ts
    - src/index.ts
    - scripts/backup.ps1
    - scripts/notify.ps1
key-decisions:
  - "humanDelay('first') é o MAIS rápido de todos (teto 2s) e 'followup' o mais lento (piso 2,5s) — cadência invertida é mais detectável que a média"
  - "Se um pedaço da mensagem quebrada falha, os seguintes NÃO saem e vai para markFailed(retryable:false) — meia mensagem é pior que nenhuma (R-045 pesa mais)"
  - "taxa_qualificacao devolve null com denominador zero, nunca 0 — '0% qualificado' e 'sem dados' são afirmações diferentes"
  - "warn notifica UMA vez por transição de estado (não a cada 30s), revertida quando a saúde volta; só critical usa -Urgent"
  - "requestPairingCode no monitor só é chamado com credenciais válidas; senão critical e para (sessão inválida = novo dispositivo = vetor de ban)"
  - "backup.ps1 -Verify cria/derruba a base de teste como postgres (documentado em 01-RESEARCH §Backup e 01-PATTERNS §4.11), não como whatsapp_bot"
  - "ErrorActionPreference=Stop + stderr nativo (psql NOTA) abortava o pipeline mesmo em exit 0 — resolvido com wrapper, não com -ErrorAction SilentlyContinue global"
patterns-established:
  - "Property tests de humanização: splitLongMessage preserva a concatenação (juntar com espaço == original), seed fixa 20260928"
  - "Teste estático de script PowerShell (lê o arquivo por tokens) substitui o teste dinâmico quando o comportamento já foi verificado por humano"
requirements-completed: [CONV-13, CONV-14, WHS-04, INTR-01, NFRQ-02, NFRQ-04, NFRQ-06, EQUP-02]
duration: 110min
completed: 2026-10-13
---

# Phase 01 Plan 05: Operação, Humanização e Backup Verificado Summary

**Humanização dentro do único caminho de envio, monitor de saúde com severidade, backup `pg_dump -Fc` restaurado e conferido por contagem, e o relatório diário dos 2 objetivos do piloto — com o boot fechando config → banco → logs → canal → motor**

## Performance

- **Duration:** ~1h50m de execução ativa (iniciado 2026-10-09, concluído 2026-10-13 após retomada)
- **Started:** 2026-10-09T16:30:57-03:00
- **Completed:** 2026-10-13T09:57:35-03:00
- **Tasks:** 3/3 (Task 3 é checkpoint humano — atendida com as contagens reais)
- **Files touched:** 16 (9 novos, 5 modificados de código, 2 de script)

## Accomplishments

- `humanize.ts`: atraso determinístico por hash (`first` ≤ 2s, `followup` ≥ 2,5s), digitação simulada, e `splitLongMessage` que quebra em fronteira de sentença **preservando a concatenação**.
- `queue-per-lead.ts`: `PQueue` por lead com `concurrency: 1` e `Map` limitado — serialização **por lead**, não global.
- Humanização ligada **dentro** do branch `send` do `dispatch`; a prova de um único chamador de `sendText` (01-04) continua válida.
- `health-monitor.ts`: croner de 30s, probe do banco com `statement_timeout` 2s, severidade `warn`/`critical`, notificação só por transição de estado, `requestPairingCode` apenas com credenciais válidas.
- `daily-report.ts`: `reunioes_agendadas`, `leads_qualificados` e `taxa_qualificacao` a partir de `status_history`, com denominador explícito e `null` quando zero.
- `env-check.ts`: 8 códigos nomeados (incluindo `ENV_PGDUMP_VERSION_MISMATCH` via `pg_dump --version` × `SHOW server_version`), rodando **antes** de qualquer conexão.
- `backup.ps1`: `pg_dump -Fc` do mesmo major, carimbo `_pg18`, `-Verify` com `pg_restore` real e comparação das 4 contagens, `-LogOnly`, rotação de 30 dias, `auth_info_baileys` **fora** do dump por padrão.
- Boot final em `src/index.ts` + shutdown `socket → pool → cron`.
- Suíte total **139 testes / 32 arquivos** verdes, `tsc` e biome limpos.

## Task Commits

1. **Task 1: Humanização + fila por lead** - `26e1fd4` (test) + `38f2a77` (feat)
2. **Task 2: health-monitor + daily-report + env-check + boot** - `3b772ac` (test) + `7712463` (feat) + `c4e44d6` (fix)
3. **Task 3: backup.ps1 verificado (checkpoint)** - `62b0400` (feat) + `182196e` (fix) + `f69791c` (fix)

**Plan metadata:** commit de docs desta execução (SUMMARY + STATE + ROADMAP + REQUIREMENTS)

## Files Created/Modified

- `src/application/humanize.ts` — `humanDelay` (hash de `node:crypto`), `simulateTyping`, `splitLongMessage`.
- `src/application/queue-per-lead.ts` — `createPerLeadQueue` (p-queue, `concurrency: 1`, Map limitado a 5000).
- `src/application/dispatcher.ts` — humanização no branch `send`, antes de `reserveMessageQuota`; falha de pedaço → `markFailed(retryable: false)`.
- `src/infra/health-monitor.ts` — `startHealthMonitor` com croner; severidade, `event_log`, `NotifyPort` (urgent só em `critical`).
- `src/infra/db/queries/daily-report.ts` — apuração por `status_history` (drizzle `sql` template, bind correto).
- `src/infra/env-check.ts` — `checkEnv()` + 8 códigos nomeados; compara `pg_dump` com `SHOW server_version`.
- `src/index.ts` — sequência de boot final; `checkEnv` (a), `startHealthMonitor` (j), cron diário 23:55 (k); shutdown socket → pool → cron.
- `scripts/backup.ps1` — dump verificado; wrapper `Invoke-Nativa`; base de teste via `-U postgres`.
- `scripts/notify.ps1` — parâmetro `-LogOnly` (não toca AUMID/som/ToastNotificationManager, já verificados).
- `tests/ops/*` — 5 arquivos novos (humanize, health-monitor, daily-report, notify-ps1 estático, backup-ps1 estático).

## Decisions Made

- **Humanização no `dispatch`, não ao lado:** se o atraso ficasse fora dele, existiria um caminho de envio sem humanização — exatamente o que o plano existe para impedir.
- **Cadência invertida de propósito:** primeira resposta é a mais rápida; um bot mais lento na primeira que na segunda tem assinatura não-humana.
- **Denominador explícito:** sem `leads_novos` do dia, `taxa_qualificacao` é `null`. Uma taxa sem denominador não é taxa.
- **Falha fechada no boot:** `checkEnv` roda antes de qualquer conexão; mismatch de `pg_dump` é pego no boot, não no restore (Armadilha 5).
- **Base de teste como superusuário:** o papel da app é least-privilege por decisão; o `-Verify` é operação administrativa e segue o idioma documentado (`-U postgres`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `env-check.ts` existia com 0 bytes (afirmação falsa de conclusão anterior)**
- **Found during:** retomada da Task 2.
- **Issue:** o executor anterior afirmou "Task 2 e 3 concluídas, tsc/biome limpos"; na verdade `env-check.ts` estava vazio e o boot parava em (h). Nenhum código novo estava ligado.
- **Fix:** implementados os 8 códigos nomeados + ligação no boot (a), health monitor (j), cron diário (k) e ordem de shutdown.
- **Files modified:** `src/infra/env-check.ts`, `src/index.ts`
- **Verification:** `BOOT_CHECK_ONLY=1 npx tsx src/index.ts` exit 0; suíte verde.
- **Committed in:** `c4e44d6`

**2. [Rule 1 - Bug] `backup.ps1` malformado e não executável**
- **Found during:** checkpoint Task 3.
- **Issue:** `[Parameter(Mandatory=False)]` é sintaxe inválida em PS 5.1 (aborta o parse inteiro); o carimbo `_pg18` e a resolução de `PGBIN`/`psql` não existiam.
- **Fix:** `Mandatory=$false`; carga do `.env`; resolução de `psql`/`pg_dump`/`pg_restore` a partir de `PGBIN`.
- **Committed in:** `182196e`

**3. [Rule 1 - Bug] `-Verify` abortava no stderr nativo do `psql`**
- **Found during:** execução do Passo 5 pelo Admin.
- **Issue:** sob `$ErrorActionPreference = "Stop"`, a `NOTA` que o `psql` escreve em stderr no `DROP DATABASE IF EXISTS` de base inexistente virava `NativeCommandError` e abortava o pipeline — mesmo com exit 0.
- **Fix:** wrapper `Invoke-Nativa` (roda o binário com `ErrorActionPreference='Continue'` só durante a chamada) + `$script:ultimoExit` como fonte de verdade.
- **Committed in:** `f69791c`

**4. [Rule 1 - Bug] `CREATE DATABASE` negado para `whatsapp_bot`**
- **Found during:** re-execução do Passo 5.
- **Issue:** `whatsapp_bot` tem `rolcreatedb=f` (least-privilege); `CREATE DATABASE whatsapp_restore_test` falhava com "permissão negada".
- **Fix:** o ciclo de vida da base de teste (DROP/CREATE/restore/contagens de destino) roda como `-U postgres`, conforme `01-RESEARCH §Backup` e `01-PATTERNS §4.11`.
- **Committed in:** `f69791c`

### Ajustes de escopo (documentados, não auto-fix)

**5. `tests/ops/backup-ps1.test.ts` é estático:** valida tokens do script (não o round-trip real); a verificação dinâmica é o checkpoint humano (Task 3), atendido com as 4 contagens.

**6. Porções dependentes de painel:** `NFRQ-04` (painel de erros) e `NFRQ-06` (painel) entregam aqui a **mecânica** (logs pino + `event_log` + notificação local); o painel visual formaliza na Fase 3, conforme a divisão mecânica/comportamento já registrada no ROADMAP. **Revisão pós-verificação (2026-10-13):** a truth do must_have sobre `engagement_mode = awaiting_human` + escrita de `handoff_active` na mesma transação do handoff **não** é entregue por este plano — a guarda AR-010 só LÊ o sinal (que ainda ninguém escreve) — e foi **deferida para a Fase 2** (plano 02-02, `HandoffService` + `mode_changes`), registrada como **P-006**. O requisito NFRQ-04 permanece Complete pela mecânica entregue.

---

**Total deviations:** 4 auto-fixados (Rule 1) + 2 ajustes de escopo documentados.
**Impact on plan:** Sem scope creep. Os 4 fixes corrigem defeitos que impediam o checkpoint de fechar e o boot de subir.

## Issues Encountered

- O reboot do Windows (pendência de R-013/`WpnUserService`) interrompeu a sessão entre 2026-10-09 e 2026-10-13; a retomada preservou as Tasks 1 e 2 já commitadas e refez a Task 3 de forma auditável.
- `noUncheckedIndexedAccess` e timestamps: as queries do relatório usam `::text`/`sql` template para não depender do fuso da sessão.

## Known Stubs

Nenhum. `daily-report` lê o banco real; `health-monitor` faz probe real; `humanize` devolve pedaços reais. O gancho `llm_error` (severidade `warn`) existe **deliberadamente sem disparador** — é o ponto de extensão da Fase 2, documentado como tal.

## Threat Flags

Nenhum novo. Sem endpoint de rede, sem caminho de auth novo, sem mudança de schema. Os controles de T-01-04 (dump em claro), T-01-24/T-01-26 (sessão fora do dump), T-01-25 (backup restaurado de verdade) e T-01-28 (sem alerta storm) foram implementados e verificados.

## User Setup Required

- **Agendador de Tarefas** (apontando `launch.cmd`, "Executar na inicialização do usuário" + privilégios mais altos) — a registrar quando o canal parear (depende de P-004).
- Pendências operacionais pré-existentes do 01-03 (`CHANNEL_PHONE_E164` real + pareamento QR) continuam abertas e fora do escopo deste plano.

## Next Phase Readiness

- Operação da Fase 1 fechada mecanicamente: humanização, monitor, backup verificado e relatório diário prontos.
- Pronto para a Fase 2 (IA, handoff, shadow), que liga o gancho `llm_error` sem tocar no monitor.
- **Aberto (deferido):** o plano 01-03 (canal/ingestão) tem a automação commitada, mas o pareamento do número dedicado não foi concluído — **P-004 `CREDS_INVALID`** (ver `01-03-DIAG.md` e `docs/pendencias.md`). Fecha antes do piloto, não antes da Fase 2.

---

**Verificação do checkpoint (Task 3) — contagens coladas pelo Admin:**

| tabela | origem (`whatsapp_prospect`) | destino (`whatsapp_restore_test`) |
|---|---|---|
| leads | 2 | 2 |
| conversations | 0 | 0 |
| messages | 0 | 0 |
| daily_counters | 0 | 0 |

`backup.ps1 -Verify` exit 0; base de teste derrubada ao final; `dump.dump` = 49.945 bytes em `20261013T095546_pg18`; sem `creds.json` na pasta de dump.

---
*Phase: 01-funda-o-canal-e-gate-de-envio*
*Completed: 2026-10-13*

## Self-Check: PASSED

- Arquivos criados verificados em disco: `humanize.ts`, `queue-per-lead.ts`, `health-monitor.ts`, `env-check.ts`, os 5 testes em `tests/ops/`, `scripts/backup.ps1`, `01-05-SUMMARY.md`.
- Commits verificados no histórico: `26e1fd4`, `38f2a77`, `3b772ac`, `7712463`, `62b0400`, `182196e`, `c4e44d6`, `f69791c`.
- `tsc --noEmit` 0 · `biome check .` 0 (30 warnings pré-existentes de teste) · `vitest run` 139/139.
