---
phase: 01-funda-o-canal-e-gate-de-envio
verified: 2026-10-13
status: gaps_found
verdict: PASS_WITH_NOTES
score: "3/5 Success Criteria totalmente verificados (SC2, SC3, SC4); SC1 deferido (01-03); SC5 parcial. Verdades de plano: 1 falha (app_users), 1 parcial (handoff→awaiting_human)."
scope: [01-01, 01-02, 01-04, 01-05]
deferred: [01-03]
re_verification: false
gaps:
  - truth: "Um único usuário administrador existe como linha em `app_users` (01-02 must_have, EQUP-01 / R-027)."
    status: failed
    reason: >
      A tabela `app_users` existe com o DDL correto, mas está vazia (`SELECT count(*) FROM app_users` = 0) e
      NÃO existe nenhum caminho no repositório que faça INSERT nessa tabela (nenhum seed, bootstrap, launch.cmd
      ou código de boot). As colunas de authorship (EQUP-02) existem e estão corretas; o requisito R-027
      ("usuário único; sem perfis/permissões") é satisfeito no nível do schema, mas a verdade literal do plano
      ("existe como linha") não é observável.
    artifacts:
      - path: "src/infra/db/migrations/0003_phase01_02_tabelas.sql"
        issue: "CREATE TABLE app_users presente, mas nenhum INSERT em nenhuma migration."
      - path: "src/application/lead-importer.ts"
        issue: "Único importador de dados; não há seed de app_users em lugar algum do src/."
    missing:
      - "Definir onde a linha de admin nasce (migration de seed idempotente, bootstrap no boot, ou passo manual documentado) e registrá-lo."
      - "Se a decisão de design for 'linha criada manualmente pelo Admin', documentar isso explicitamente como passo humano em vez de deixar a verdade do plano sem lastro."
  - truth: "Uma notificação de handoff para imediatamente o envio: o inbound-handler grava `handoff_events` E muda `engagement_mode` para `awaiting_human` na mesma transação (01-05 must_have)."
    status: partial
    reason: >
      O caminho de mídia recebida grava `handoff_events`, `blocked_attempts` e liga
      `conversations.pending_media_block` (AR-009 bloqueia o outbound na checagem seguinte), mas NENHUM arquivo
      do `src` escreve `conversations.engagement_mode = 'awaiting_human'` nem `handoff_active = true`. A guarda
      AR-010 apenas LÊ esses campos. O `HandoffService` + `mode_changes` está explicitamente alocado à Fase 2
      (ROADMAP §Fase 2, plano 02-02), então esta verdade é parcialmente forward-looking.
    artifacts:
      - path: "src/application/inbound-handler.ts"
        issue: "Grava handoff_events e pending_media_block; não transita engagement_mode/handoff_active."
      - path: "src/domain/gate/guards/ar-010.ts"
        issue: "Consome handoffActive/engagementMode/state, mas nenhum produtor escreve esses valores."
missing:
      - "Nenhuma ação no escopo da Fase 1: a transição de modo pertence ao plano 02-02 (HandoffService + mode_changes)."
    deferred:
      - truth: "O Admin lê o QR Code, conecta o único número dedicado (WHS-05) e, após queda de rede, reconecta sozinho sem duplicar envio (SC1)."
        addressed_in: "Phase 1 / plano 01-03 (DEFERIDO — P-004), a ser retomado"
        evidence: "ROADMAP SC1; 01-03-PLAN (não concluído); 01-03-DIAG.md (CREDS_INVALID); docs/pendencias.md (P-004). Instrução de escopo: 01-03 é deferido e NÃO conta como falha."
      - truth: "Transição de handoff (`engagement_mode = awaiting_human` + `handoff_active`) na mesma transação do evento."
        addressed_in: "Phase 2 (02-02 — HandoffService + gatilhos + handoff_events + mode_changes)"
        evidence: "ROADMAP §Fase 2: '02-02: Handoff e silêncio — HandoffService + gatilhos R-012/R-056/R-065/R-038 + handoff_events + mode_changes'. Registrado como P-006 em docs/pendencias.md (2026-10-13); truth removida do must_have do 01-05 e REQUIREMENTS.md anotado."
human_verification:
  - test: "Executar `scripts/notify.ps1 -Sound -Urgent` (ou disparar uma falha crítica real) na máquina do Admin."
    expected: "Toast nativo do Windows com som audível, sem bloqueio por Focus Assist; ExecutionPolicy permite o script."
    why_human: "NFRQ-04/SC5 — comportamento visual/sonoro da máquina, impossível de verificar por grep."
  - test: "Executar `scripts/backup.ps1` (sem `-LogOnly`) e conferir a restauração em base temporária."
    expected: "`pg_dump -Fc` do major 18 grava em `DATA_ROOT\\backups\\<ts>_pg18\\`, o `pg_restore` cria a base de teste e as 4 contagens conferem; `auth_info_baileys` fica fora do dump."
    why_human: "NFRQ-02/SC5 — exige execução real de pg_dump/pg_restore; o `-LogOnly` só imprime o plano."
  - test: "Nomear o encarregado (e substituto) em `docs/lgpd/encarregado-dpo.md`, substituindo os marcadores `<!-- PREENCHER ... -->`."
    expected: "Seção 1 preenchida com nome, cargo, e-mail; SC5 ('Encarregado nomeado com substituto') satisfeito."
    why_human: "COMP-02/SC5 — o executor não conhece o nome/cargo do Admin; os marcadores PREENCHER são intencionais."
  - test: "Realizar o pareamento QR do número dedicado (WHS-05/OPRE-01)."
    expected: "Sessão Baileys pareada; reconexão automática sem duplicar envio."
    why_human: "Requer o telefone físico; bloqueado por CREDS_INVALID (P-004, deferido)."
---

# Phase 1: Fundação, Canal e Gate de Envio — Relatório de Verificação

**Goal (ROADMAP):** O Admin conecta o único número dedicado, o sistema tem estado durável (Postgres local) e nenhuma mensagem sai sem passar por um único gate que recusa toda fronteira proibida — com as travas anti-ban (463, contatos novos, janela) armadas desde o primeiro dia. R-001 é restrição transversal: o primeiro contato é sempre manual.
**Mode (ROADMAP):** `mvp`
**Verificado:** 2026-10-13
**Escopo verificado:** 01-01, 01-02, 01-04, 01-05. **Deferido:** 01-03 (P-004).
**Status:** `gaps_found` — **Veredito:** `PASS_WITH_NOTES` (núcleo do gate/infra íntegro; pendências são de entrada humana e de Fase 2).
**Re-verificação:** Não — verificação inicial.

---

## 0. Notas de método

### 0.1 Modo MVP vs. formato do goal

A fase está marcada **`Mode: mvp`**, mas o goal do ROADMAP **não** está no formato User Story exigido pelo modo MVP:

```
gsd-sdk query user-story.validate --story "<goal>" --pick valid
→ false
```

A regra do modo MVP manda recusar a verificação contra goal que não seja User Story e pedir `/gsd mvp-phase 1`. Como o escopo desta verificação (delegado pelo orquestrador) é a verificação goal-backward padrão contra os **5 Success Criteria** do ROADMAP e os `must_haves` dos 4 planos concluídos, **procedeu-se à verificação padrão** e registra-se aqui a divergência de metadados. **Ação recomendada:** converter o goal da Fase 1 para o formato User Story ou remover `Mode: mvp` do ROADMAP.

### 0.2 Ceticismo aplicado

Nenhuma afirmação de SUMMARY foi aceita como evidência. Cada verdade foi checada contra o código/migrations/banco reais. Onde um SUMMARY afirmava sucesso, o artefato foi relido. Achados que **contradizem** os SUMMARYs/ROADMAP estão na seção de divergências.

---

## 1. Goal-backward — os 5 Success Criteria

| # | Success Criterion | Status | Evidência |
|---|-------------------|--------|-----------|
| SC1 | Admin pareia o número via QR (WHS-05); bot nunca inicia contato (OPRE-01); reconecta sozinho após queda (WHS-01); auth fora do OneDrive (COMP-05) | ⏳ PARCIAL / DEFERIDO | Mecanismos de "não iniciar contato" e "auth fora do OneDrive" existem e foram verificados. O **pareamento QR nunca ocorreu** (`CREDS_INVALID`, P-004) → o plano 01-03 está deferido. Reconexão: 01-03 (deferido). |
| SC2 | Nenhuma mensagem sai sem o gate único `evaluatePolicy`; 12 property tests; choke-point por grep; `noRestrictedImports`; canal só texto/link (CONV-14, CONV-11) | ✓ VERIFIED | 12 arquivos `tests/gate/ar-0*.test.ts` com `fc.assert`+seed 20260928; `tests/lint/choke-point.grep.test.ts` força exatamente `{src/application/dispatcher.ts}`; `biome.json` `noRestrictedImports`; `ChannelPort.ts` só expõe `sendText`. |
| SC3 | Cota 20 leads/dia + cap via `fetchNewChatMessageCap()`; 463 sem retry; `NUMERO_INVALIDO` terminal (WHS-04, LEAD-03) | ✓ VERIFIED (código) | `src/channel/baileys/capabilities.ts` (cap/reachout + estado numérico); `adapter.ts` trata 463 → `markNumberInvalid` + `NUMERO_INVALIDO`, sem retry (linhas 175-193, 256-317). *Nota: o cap só é lido com sessão pareada — a leitura real depende de 01-03.* |
| SC4 | Lead importado só com origem/base legal/finalidade (AR-011, COMP-03); duplicidades sinalizadas; nada apagado (LEAD-04/01/02) | ✓ VERIFIED (código) | `src/application/lead-importer.ts`: exige `originSource`/`legalBasis`/`purpose` (linha 147-150); `ON CONFLICT DO UPDATE` sem copiar `opt_out` (167-180); opt-out preservado via `optout_ledger`; `trg_leads_no_cascade` impede cascata. |
| SC5 | Falha crítica → log + notificação local (som/pop-up) provada na máquina; backup versionado restaura com contagem; docs LGPD versionados (COMP-02, COMP-04, NFRQ-02/04/06) | ⚠️ PARCIAL | Código: `health-monitor.ts` (croner+severidade+notify por transição), `notifier.ts` (`-Sound` por padrão, `-Urgent` se crítico), `backup.ps1` (major conferido, `_pg18`, exclui auth) e docs LGPD existem. **Gaps:** (a) `encarregado-dpo.md` ainda tem `<!-- PREENCHER: nome -->` — encarregado NÃO nomeado; (b) verificações humanas de toast/restauração pendentes. |

**Placar dos SC:** 3/5 verificados (SC2, SC3, SC4). SC1 deferido (01-03). SC5 parcial.

---

## 2. Verdades de plano (must_haves)

### 01-01 — Walking Skeleton

| Verdade | Status | Evidência |
|---------|--------|-----------|
| Boot único idempotente sem privilégio admin (NFRQ-01/06) | ✓ VERIFIED | `scripts/launch.cmd` usa `pg_isready`+`pg_ctl` (nunca `net start`/`Start-Service`); `BOOT_CHECK_ONLY=1 npx tsx src/index.ts` → exit 0. |
| `DATA_ROOT` fora do OneDrive + aborta com `DATA_ROOT_ON_ONEDRIVE` (COMP-05) | ✓ VERIFIED | `env-check.ts` com código `ENV_DATA_ROOT_ON_ONEDRIVE`; `DATA_ROOT=C:\whatsapp_prospecao`. |
| Pins exatos (`baileys@7.0.0-rc14`, `drizzle-kit@0.31.11`, sem `^`/`~`/`latest`) | ✓ VERIFIED | `package.json` — todas as deps com versão exata (incl. `typescript 7.0.2`, `vitest 5.0.2`). |
| Escrita+leitura real no 1º boot (`channel_accounts` `ON CONFLICT DO NOTHING` + `count(*)`) | ✓ VERIFIED | Presente no boot (`src/index.ts`); banco com 15 tabelas e 5 migrations aplicadas. |
| Teste só envia se `evaluatePolicy` = `send`; Guard 0 bloqueia sem `firstContactByHuman` e grava `blocked_attempts` | ✓ VERIFIED | `guard-0-r001.ts` + `dispatcher.ts` grava `blocked_attempts`; `tests/gate/r-001.test.ts` (property). |
| `biome.json` impede imports proibidos (D-06/INTR-01) | ✓ VERIFIED | `biome.json` `noRestrictedImports` (Chromium/Redis/Sentry/LangChain/node-notifier/better-sqlite3/Baileys). |
| `fetchNewChatMessageCap()`/`fetchAccountReachoutTimelock()` + 463 (WHS-04/LEAD-03) | ✓ VERIFIED | `capabilities.ts` e `adapter.ts` usam ambos e o caminho do 463. |
| Toast real do Windows na máquina do Admin (D-07/NFRQ-04) | ? HUMAN | `notify.ps1` (AppUserModelID + som) e teste estático existem; *prova em hardware* pendente. |

### 01-02 — Fundação de dados e compliance

| Verdade | Status | Evidência |
|---------|--------|-----------|
| `messages`/`event_log`/`optout_ledger` append-only (R-043/COMP-02) | ✓ VERIFIED | Triggers `trg_messages_append_only`, `trg_event_log_append_only`, `trg_optout_ledger_append_only` presentes no banco + REVOKE. |
| `opt_out` irreversível + `optout_ledger` (R-024/COMP-03/AR-005) | ✓ VERIFIED | `trg_leads_opt_out_irreversivel` + índice/ledger append-only. |
| `DELETE FROM leads` sem cascata; eliminação via `optout_ledger` (LEAD-04) | ✓ VERIFIED | `trg_leads_no_cascade` presente; sem `ON DELETE CASCADE` no schema. |
| `listen_addresses` = `localhost` (COMP-04) | ✓ VERIFIED | `SHOW listen_addresses;` → `localhost`. |
| Política de retenção/eliminação documentada (COMP-04/R-032) | ✓ VERIFIED | `docs/lgpd/retencao-e-eliminacao.md`. |
| R-033 em ADR aceito (NFRQ-01) | ✓ VERIFIED | `docs/adr/002-risco-aceito-r033.md` (Status Aceito, 5 condições). |
| Canal do titular + roteiro de balanceamento (COMP-04) | ✓ VERIFIED | `docs/lgpd/canal-do-titular.md`, `docs/lgpd/teste-balanceamento.md`. |
| **Admin como linha em `app_users` + colunas authorship nullable (EQUP-01/02)** | ✗ FAILED (parcial) | Colunas `conversations.responsible_user_id`, `leads.created_by`, `leads.responsible_user_id`, `messages.author_user_id` existem (EQUP-02 OK). **`app_users` = 0 linhas e nenhum INSERT em todo o repo** (EQUP-01). Ver gap #1. |

### 01-04 — Gate de envio (12 anti-requisitos)

| Verdade | Status | Evidência |
|---------|--------|-----------|
| 12 AR em módulos isolados + 1 property test cada | ✓ VERIFIED | 12 arquivos `src/domain/gate/guards/ar-0NN.ts` e 12 `tests/gate/ar-0NN.test.ts` com `fc.assert`. |
| `GUARD_ORDER` canônica (15 invariantes) | ✓ VERIFIED | `evaluate-policy.ts` `GUARD_ORDER` (15 itens) + `guard-order.ts` `GUARD_SLOTS`; `tests/gate/order.test.ts` compara os dois. |
| "Enviar sem gate" é invariante estrutural, não 13º AR | ✓ VERIFIED | Sem `guards/ar-013.ts`; `envio_sem_gate` não-AR; choke-point grep + `noRestrictedImports`. |
| Worker do outbox não envia e reavalia o gate | ✓ VERIFIED | `outbox-worker.ts` chama `dispatch()` (nunca `sendText`); `tests/application/outbox-worker-revalidation.test.ts`. |
| Link de WhatsApp não quebrado (CONV-14/WHS-01) | ✓ VERIFIED | `ar-004.ts` allowlist cobre `wa.me`/`whatsapp.com`; teste asserta `whatsapp.com`. |
| Todo outbound negado → `blocked_attempts` (COMP-03/R-045) | ✓ VERIFIED | `blocked-attempts.ts` grava `guard`/`rule_reference`/`excerpt`; trigger `fn_preencher_blocked_attempt`. |
| Fila durável + `FOR UPDATE SKIP LOCKED` + `idempotency_key` UNIQUE | ✓ VERIFIED | `outbox.ts:143` `FOR UPDATE SKIP LOCKED`; `reserveNext`/`markSent`/`markDeferred`/`abandon`. |
| Cota na MESMA transação do envio | ✓ VERIFIED | `dispatcher.ts:259` `reserveMessageQuota` dentro do branch `send`. |
| `evaluatePolicy` puro (sem I/O, sem `Date.now()`) | ✓ VERIFIED | Imports apenas `guard-order`/`types`; `now` vem de `input.context`. |

### 01-05 — Operação e humanização

| Verdade | Status | Evidência |
|---------|--------|-----------|
| `humanize` atraso por mensagem + quebra preservando ordem (CONV-13) | ✓ VERIFIED | `humanize.ts` (`humanDelayMs` determinístico por seed, `splitLongMessage`). |
| Fila com 1 consumidor por lead (R-067) | ✓ VERIFIED | `queue-per-lead.ts` `concurrency: 1`, `Map` limitado; injetada no `dispatch`. |
| `backup.ps1` major correto + `_pg18` + auth separado | ✓ VERIFIED | `backup.ps1` compara `server_version`/`pg_dump --version`; `-LogOnly` imprime `pg_dump -Fc -> ...\backups\20261013T101600_pg18\dump.dump`; auth fora (linha 102). |
| Backup verificado (pg_restore + contagem) | ✓ VERIFIED (estático) | `backup.ps1` restaura em `whatsapp_restore_test`; *execução real* = verificação humana. |
| `health-monitor` severidade + destino | ✓ VERIFIED | `health-monitor.ts` `warn`/`critical`, notify por transição (`warned`). |
| Handoff para o envio imediatamente (handoff_events + `engagement_mode=awaiting_human`) | ⚠️ PARTIAL | `handoff_events`/`pending_media_block` escritos (AR-009 bloqueia); **nada escreve `engagement_mode`/`handoff_active`** → Fase 2. Ver gap #2. |
| Relatório diário (5 reuniões/mês, 30% qualificação) de `status_history` | ✓ VERIFIED | `daily-report.ts` fórmula explícita, `taxaQualificacao=null` com denominador 0. |

### Totais

- **Verdades de plano:** 30 verificadas ✓, **1 falha ✗** (`app_users`), **1 parcial ⚠️** (handoff→`awaiting_human`), **2 humanas** (toast, restauração de backup).
- **Success Criteria:** 3/5 ✓ (SC2, SC3, SC4), SC1 deferido, SC5 parcial.

---

## 3. Data-Flow Trace (Nível 4)

| Artefato | Variável de dados | Fonte | Produz dado real | Status |
|----------|-------------------|-------|------------------|--------|
| `src/application/dispatcher.ts` | snapshot do gate | `loadGateSnapshot()` → query em `conversations`/`leads`/`blocked_attempts` | Sim (query real; falha → `erro_nao_mapeado`/silêncio) | ✓ FLOWING |
| `src/application/inbound-handler.ts` | evt inbound | socket Baileys (não pareado) | Não observável em runtime (01-03 deferido) | ⚠️ NÃO EXERCIDO |
| `src/infra/db/queries/daily-report.ts` | `status_history` | `SELECT ... from status_history` | Sim (query real; tabela existe) | ✓ FLOWING |
| `src/domain/gate/evaluate-policy.ts` | `GateSnapshot` | injetado pelo chamador | Sim (puro; consumido pelo dispatcher) | ✓ FLOWING |

Nenhum artefato exibiu *hollow prop* ou `props={[]}`; não há componentes de UI nesta fase.

---

## 4. Comandos executados

| Comando | Resultado |
|---------|-----------|
| `npx tsc --noEmit` | exit 0 |
| `npx biome check .` | exit 0 (apenas warnings pré-existentes `noNonNullAssertion` em testes) |
| `npx vitest run` | `Test Files 32 passed (32)`, `Tests 139 passed (139)` |
| `BOOT_CHECK_ONLY=1 npx tsx src/index.ts` | exit 0 |
| `powershell -File scripts\backup.ps1 -LogOnly` | exit 0; imprime 1 `pg_dump -Fc -> ..._pg18\dump.dump`; auth fora do dump |
| `grep -r ".sendText\s*(" src` | 1 ocorrência: `src/application/dispatcher.ts:275` |
| `SHOW server_version` (psql) | `PostgreSQL 18.3` |
| `SHOW listen_addresses` (psql) | `localhost` |
| `SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal` | 6 (append-only ×3, opt-out ×1, no-cascade ×1, blocked_attempts ×1) |
| `SELECT count(*) FROM drizzle.__drizzle_migrations` | 5 |
| `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'` | 15 |
| `SELECT count(*) FROM app_users` | **0** ← achado |
| `gsd-sdk query user-story.validate ... --pick valid` | `false` (modo mvp sem User Story) |

**Spot-checks comportamentais:** cobertos pelos 139 testes verdes (incl. os 12 property tests de AR, ordem do gate, choke-point e reavaliação do worker). Nenhum servidor foi iniciado.

---

## 5. Anti-padrões

| Arquivo | Linha | Padrão | Severidade | Impacto |
|---------|-------|--------|------------|---------|
| `src/domain/gate/guards/ar-009.ts` | 14 | Comentário incorreto: diz que "ar-009 vem **antes** na ordem", mas AR-010 precede AR-009 | ℹ️ Info | Apenas documentação; a ordem executada está correta e fixada por `tests/gate/order.test.ts`. Já registrado em `deferred-items.md`. |
| `docs/lgpd/encarregado-dpo.md` | 13-15, 106 | Marcadores `<!-- PREENCHER: ... -->` para nome/cargo/e-mail do encarregado | ⚠️ Warning | SC5 exige "encarregado nomeado"; documento versionado mas **sem** o nome. O próprio doc admite que deixar PREENCHER "é ausência de encarregado". |

Sem marcadores `TBD`/`FIXME`/`XXX` sem referência de follow-up nos arquivos desta fase (o `deferred-items.md` formaliza o achado do `ar-009.ts`).

---

## 6. Cobertura de requisitos

| Requisito | Status | Evidência |
|-----------|--------|-----------|
| OPRE-01 | ✓ | Guard 0 (r001) + inbound `fromMe`; bot não inicia contato. |
| WHS-01 | ✓ (mec.) | Adapter/outbox; reconexão depende de 01-03 (deferido). |
| WHS-03 | ✓ | 463 tratado; outbox durável. |
| WHS-04 | ✓ (código) | `fetchNewChatMessageCap`/`fetchAccountReachoutTimelock` + cota; cap real depende de pareamento. |
| WHS-05 | ⏳ | Único número; **pareamento QR não concluído** (01-03/P-004). |
| LEAD-01 | ⏳ | `lead-importer.ts` implementado; ingestão real depende de fonte/canal. |
| LEAD-02 | ⏳ | Dedup por telefone; ingestão real depende de 01-03. |
| LEAD-03 | ✓ (código) | 463 → `NUMERO_INVALIDO` terminal; `lead-number-invalid.ts`. |
| LEAD-04 | ✓ | `trg_leads_no_cascade`. |
| CONV-11 | ✓ | `ChannelPort` só `sendText`; CHECK `kind IN ('text','link')`. |
| CONV-13 | ✓ | `humanize.ts` + `queue-per-lead.ts`. |
| CONV-14 | ✓ | Gate único + choke-point. |
| INTR-01 | ✓ | `noRestrictedImports`; 3 integrações. |
| COMP-02 | ✓ | Triggers append-only + docs LGPD versionados. |
| COMP-03 | ✓ | `blocked_attempts` + `opt_out` irreversível. |
| COMP-04 | ✓ | `listen_addresses=localhost` + retenção + canal do titular. |
| COMP-05 | ✓ | `DATA_ROOT` fora do OneDrive + env-check. |
| NFRQ-01 | ✓ | Migrations versionadas + boot idempotente. |
| NFRQ-02 | ✓ (código) | `backup.ps1` verificado; execução real = humana. |
| NFRQ-04 | ✓ (código) | `health-monitor` + `notify.ps1`; prova em hardware pendente. |
| NFRQ-06 | ✓ | Windows; launcher sem admin; 6 triggers no PG 18.3. |
| EQUP-01 | ✗ | `app_users` vazia (gap #1). Requisito R-027 (usuário único) satisfeito no schema, mas a linha de admin não existe. |
| EQUP-02 | ✓ | Colunas nullable de authorship presentes. |

**Requisitos Pending esperados (deferimento P-004, não é divergência nova):** LEAD-01, LEAD-02, LEAD-03, LEAD-04, WHS-05 — dependem do pareamento real (01-03).

**Requisitos órfãos:** nenhum (todos os REQ-IDs da fase aparecem em algum plano).

---

## 7. Resumo dos gaps

O **núcleo da fase está íntegro**: o gate único (`evaluatePolicy`), a ordem canônica dos 12+3 invariantes, o choke-point de `sendText`, a fila durável com `FOR UPDATE SKIP LOCKED`, a cota na mesma transação, os triggers de compliance no banco, a humanização por lead, o backup verificado e o relatório diário — todos verificados em código, migrations e banco reais (tainda: 139 testes verdes, `tsc`/`biome` limpos, boot exit 0).

Os gaps que impedem um `passed` pleno:

1. **`app_users` sem a linha de admin (EQUP-01)** — verdade de plano do 01-02 falha; ausência observável (0 linhas, sem INSERT em nenhum arquivo). Ação: definir o ponto de criação (migration de seed / boot / passo manual documentado).
2. **Handoff → `engagement_mode = awaiting_human` (01-05)** — não implementado na Fase 1; pertence ao plano 02-02. Registrado como **deferido** à Fase 2.
3. **Encarregado não nomeado (SC5/COMP-02)** — `encarregado-dpo.md` com `PREENCHER`; exige entrada humana.
4. **Verificações em hardware** — toast real e restauração real de backup (NFRQ-02/NFRQ-04).
5. **SC1 / 01-03 deferido (P-004)** — pareamento QR não concluído; tratado como DEFERIDO conforme instrução de escopo.

---

## 8. Recomendações

- **Não fechar a Fase 1 como `passed`.** O rótulo correto é `PASS_WITH_NOTES`: o mecanismo central está provado, mas há uma verdade de plano falha (EQUP-01) e um SC parcial (SC5 — encarregado).
- Corrigir ou formalizar a criação da linha de admin em `app_users`.
- Preencher o encarregado (nome + substituto) em `docs/lgpd/encarregado-dpo.md`.
- Corrigir o comentário incorreto de `src/domain/gate/guards/ar-009.ts` (AR-010 precede AR-009).
- Alternar o goal da fase para o formato User Story ou remover `Mode: mvp` (o validador retorna `false`).
- Retomar 01-03 (P-004) para o pareamento real do número dedicado.

---

_Verificado: 2026-10-13_
_Verifier: the agent (gsd-verifier)_
