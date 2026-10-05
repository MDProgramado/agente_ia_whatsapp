---
phase: 01-funda-o-canal-e-gate-de-envio
plan: 02
subsystem: infra
tags: [postgres, drizzle, triggers, append-only, opt-out, lgpd, pg-hba, backup, adr]

requires:
  - phase: 01-funda-o-canal-e-gate-de-envio
    provides: "6 tabelas + 3 migrations do plano 01-01, PolicyGate pura com ordem invariante, dispatcher como choke-point, DATA_ROOT fora do OneDrive"
provides:
  - "9 tabelas restantes no schema Drizzle (15 no total), migration 0003_phase01_02_tabelas.sql"
  - "0004_guards_and_audit.sql: invariantes de R-043 (append-only), R-024 (opt-out irreversivel) e LEAD-04 (lead com handoff nao pode ser excluido) impostas por trigger no banco"
  - "src/infra/db/queries/blocked-attempts.ts: a trilha de auditoria R-022 que o plano 01-01 provou estar vazia"
  - "scripts/pg-hba-apply.ps1 + docs/adr/003-pg-hba-higiene.md: higiene do PostgreSQL (COMP-04)"
  - "Dossie LGPD operacional: encarregado-dpo, canal-do-titular, retencao-e-eliminacao, teste-balanceamento"
  - "ADR-002 (risco aceito de R-033) reescrito com condicoes de reabertura"
  - "PostgreSQL real endurecido: listen_addresses=localhost, senha SCRAM no role, 4 bancos preexistentes intactos"
  - "39 testes verdes (7 arquivos); tsc limpo; biome check limpo"
affects: [01-03, 01-04, 01-05, fase-2, fase-3, fase-4, lgpd]

tech-stack:
  added: []
  patterns:
    - "Invariante de compliance no banco, nao no codigo: trigger + REVOKE, porque um bug de aplicacao nao consegue contornar"
    - "Teste de trigger usa Pool cru, nunca openDb: openDb roda migrate() antes e o teste passaria por efeito colateral do runner que aplicou o proprio trigger"
    - "Higiene de config do PostgreSQL: escrever por System.IO.File::WriteAllText + UTF8Encoding($false), nunca Set-Content/Out-File/>, porque PowerShell prepende BOM e o servidor recusa subir"

key-files:
  created:
    - "src/infra/db/migrations/0003_phase01_02_tabelas.sql — as 9 tabelas do plano (138 linhas)"
    - "src/infra/db/migrations/0004_guards_and_audit.sql — triggers de R-043/R-024/LEAD-04 + REVOKE de DELETE/UPDATE (235 linhas)"
    - "src/infra/db/queries/blocked-attempts.ts — gravacao da trilha R-022 (255 linhas)"
    - "src/domain/ports/ClockPort.ts — Clock injetavel para os testes de auditoria (118 linhas)"
    - "scripts/pg-hba-apply.ps1 — higiene do PostgreSQL, 3 scopes, idempotente (343 linhas)"
    - "docs/adr/003-pg-hba-higiene.md — ADR-003"
    - "docs/lgpd/encarregado-dpo.md, docs/lgpd/canal-do-titular.md, docs/lgpd/retencao-e-eliminacao.md, docs/lgpd/teste-balanceamento.md"
  modified:
    - "src/infra/db/schema.ts — +404 linhas: as 9 tabelas, sem tocar nas 6 existentes"
    - "tests/gate/kill-switch.test.ts — 430 linhas de testes vermelhos (cfc3962) + ajuste de assercao (73b66fd)"
    - "docs/adr/002-risco-aceito-r033.md — reescrito com Status Aceito, 5 condicoes e comparacao de riscos"
    - ".planning/STATE.md — posicao, decisoes e pendencias do plano"

key-decisions:
  - "Invariantes de R-043, R-024 e LEAD-04 moram em trigger + REVOKE, nao em codigo de aplicacao: um bug de aplicacao vira erro de banco, nao uma violacao silenciosa de LGPD"
  - "opt_out_ledger e handoff_events tem retencao INDEFINIDA: expirar a prova de um opt-out faz o backfill do caça-leads ressuscitar o bloqueio, e um opt-out perdido nao tem segunda chance para o titular"
  - "O canal de atendimento do titular e o e-mail do encarregado ou o telefone do Admin — NUNCA a conversa de WhatsApp: responder eliminacao de dentro do bot gravaria o pedido no historico append-only que ele pediu para apagar"
  - "Os 9 testes de trigger de kill-switch conectam por Pool cru, nao por openDb, porque openDb executa migrate() e o teste confirmaria o trigger por efeito colateral do proprio runner"
  - "listen_addresses=localhost e mitigacao REAL e verificavel de R-033, mas menor que o risco de autenticacao do Baileys: a pasta auth_info_baileys e o proprio numero dedicado"

patterns-established:
  - "Compliance no banco: trigger impede e REVOKE remove a permissao, de modo que nem um INSERT/UPDATE/DELETE acidental passa"
  - "Migrations .sql versionadas com meta/_journal.json; 0003 = tabelas do plano, 0004 = guards de auditoria"
  - "Documento LGPD como procedimento operacional com o que o encarregado NAO faz, nao como resumo de artigo"

requirements-completed: [NFRQ-01, NFRQ-06, COMP-02, COMP-03, COMP-04]

# Metrics
duration: 240min
completed: 2026-10-05
---

# Phase 01-02: Invariantes no banco e dossie LGPD Summary

**15 tabelas e 3 invariantes de compliance impostas por trigger no PostgreSQL (historico append-only, opt-out irreversivel, lead com handoff nao excluido), mais o dossie LGPD reescrito como procedimento que o encarregado consegue executar.**

## Performance

- **Duration:** ~240 min (execucao em duas janelas + revisao da Task 4)
- **Started:** 2026-09-30T13:59:00-03:00
- **Completed:** 2026-10-05T11:00:00-03:00
- **Tasks:** 4 (Tasks 1–3 aprovadas em checkpoint; Task 4 reescrita e aprovada)
- **Commits:** 6 de conteudo + 1 de metadata
- **Files:** 15 arquivos (8 criados, 7 modificados)

## Accomplishments

- **R-043 e inviolavel no banco.** `messages`, `event_log` e `optout_ledger` rejeitam `DELETE` e `UPDATE` por trigger *e* por `REVOKE`. Um `DELETE` devolve ERRO; nao ha caminho de aplicacao que apague o historico sem desativar o trigger deliberadamente.
- **R-024 e irreversivel no banco.** `opt_out` so admite `false -> true`. O `UPDATE opt_out true->true` passa (idempotencia), a tentativa inversa morre no trigger, e o `ON CONFLICT` da importacao do caça-leads nao contem `opt_out = EXCLUDED.opt_out` — um lead desatualizado do provedor nao ressuscita um bloqueio.
- **LEAD-04 nao pode ser burlado por cascade.** `DELETE leads` e barrado quando existe handoff aberto (parcial ou em `human_acknowledged_at IS NULL`). O indice parcial que sustenta a checagem tambem esta na migration.
- **A trilha R-022 foi finalmente preenchida.** `blocked-attempts.ts` grava todo negativo do gate. Os testes vermelhos (cfc3962) provaram que o caminho anterior era um `db.execute` com `$1..$3` sem bind dentro de um `try/catch` que so logava — o negativo era perdido em silencio.
- **O PostgreSQL real foi endurecido e a maquina nao perdeu nada.** `listen_addresses = localhost`, senha SCRAM no role `whatsapp_bot`, `postgresql.conf` sem BOM, e os 4 bancos preexistentes (`auth`, `pizzaria_db`, `vidracaria`, `vidracaria_test`) intactos.
- **O dossie LGPD virou procedimento, nao resumo de lei.** O canal do titular e explicitamente externo ao WhatsApp (e o *por que*: responder eliminacao de dentro do bot gravaria o pedido no historico append-only). O teste de balanceamento tem uma secao "quando o balanceamento deixa de fechar" com 5 condicoes e a acao do sistema em cada uma.
- **12/12 checks do gate <automated> da Task 4 passam** (a versao anterior falhava em 7).

## Task Commits

Cada task foi commitada atomicamente:

1. **Task 1: as 9 tabelas restantes do schema Drizzle** — `675c23c` (feat) — precedida de `a99e33a` (fix: comentario corrompido no JSDoc do `bypassGate`, lixo de um find/replace anterior)
2. **Task 2: invariantes de R-043, R-024 e LEAD-04 dentro do banco** — `cfc3962` (test, vermelho) -> `73b66fd` (feat)
3. **Task 3: higiene do PostgreSQL (pg_hba) + ADR-003** — `d685d6b` (chore) — parte automatizavel; o restante foi um checkpoint humano aprovado pelo Admin
4. **Task 4: dossie LGPD operacional** — `b4f31ef` (docs) — precedida de `77bb7df` ("primeiro commit", que trouxe a versao inicial dos 5 documentos)

**Plan metadata:** este commit

_Note: Task 2 seguiu TDD real — `cfc3962` gravou os testes antes de `73b66fd` implementar._

## Files Created/Modified

- `src/infra/db/schema.ts` — +404 linhas; as 9 tabelas do plano, sem tocar nas 6 do plano 01-01
- `src/infra/db/migrations/0003_phase01_02_tabelas.sql` — DDL das 9 tabelas
- `src/infra/db/migrations/0004_guards_and_audit.sql` — triggers de R-043/R-024/LEAD-04, `REVOKE`, e `fn_preencher_blocked_attempt`
- `src/infra/db/queries/blocked-attempts.ts` — gravacao da trilha R-022
- `src/domain/ports/ClockPort.ts` — Clock injetavel, para os testes de auditoria
- `tests/gate/kill-switch.test.ts` — 430 linhas; testes de trigger de banco via Pool cru
- `scripts/pg-hba-apply.ps1` — higiene do PostgreSQL em 3 scopes, idempotente
- `docs/adr/003-pg-hba-higiene.md` — ADR-003
- `docs/adr/002-risco-aceito-r033.md` — reescrito: Status Aceito, 5 condicoes de reabertura
- `docs/lgpd/encarregado-dpo.md` — prazo de 5 dias uteis, o que o encarregado NAO faz, secao "quando o Admin nao e encarregado"
- `docs/lgpd/canal-do-titular.md` — canal externo, conflito com o append-only explicado
- `docs/lgpd/retencao-e-eliminacao.md` — prazo por categoria, INDEFINIDO para as provas, `pg_dump`/`pg_restore`
- `docs/lgpd/teste-balanceamento.md` — aplicado ao caso concreto, com a secao de derrota
- `docs/lgpd/teste_balanceamento.md` — **removido** (renomeado com hifen)

## Decisions Made

- **Compliance mora no banco, nao no codigo.** Um guard em TypeScript pode ser contornado por uma query escrita a mao. Um trigger com o `REVOKE` junto nao. Para R-043, R-024 e LEAD-04 a escolha foi trigger.
- **`optout_ledger` e `handoff_events` tem retencao INDEFINIDA.** Todo o resto tem prazo. A razao e invertida em relacao ao resto do documento: uma prova de opt-out que expira e uma prova que o titular pode exigir que exista. E o `leads.opt_out` nao tem backfill — se o registro do opt-out sumir e um importador novo rodar, o bloqueio vai com ele.
- **O canal do titular nunca e a conversa de WhatsApp.** Isso e consequencia direta do R-043: se o bot confirmasse o recebimento de um pedido de eliminacao, o pedido ficaria gravado em `messages`, que e append-only. O sistema nao pode estar obliged a guardar para sempre a unica prova do que o titular pediu para apagar. Por isso o procedimento e escrito para nao depender do bot em nenhum passo.
- **Os testes de trigger nao usam `openDb`.** `openDb` roda `migrate()` antes de devolver o handle; o teste confirmaria o trigger por efeito colateral do runner que acabara de aplicar a migration. Pool cru, sem migracao, para que o teste prove o trigger e nao a propria idempotencia do runner.
- **`fn_preencher_blocked_attempt` preenche o guard no banco.** `blocked_attempts.guard_id` e NOT NULL porque um negativo sem guard identificado nao e auditavel; a funcao deriva o guard a partir do motivo em vez de confiar no chamador.
- **R-033: o risco maior e a autenticacao do Baileys, nao a criptografia do banco.** `listen_addresses = localhost` mitiga de verdade e e verificavel por `SHOW`. Mas a pasta `auth_info_baileys` **e** o numero dedicado: perder a pasta faz o WhatsApp ver "dispositivo novo", que e ele proprio um sinal de ban (R-059). A ausencia de criptografia em repouso e um risco aceito de segunda ordem.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Comentario corrompido no JSDoc do `bypassGate`**
- **Found during:** Task 1 (schema), leitura de `src/application/dispatcher.ts`
- **Issue:** um find/replace anterior deixou lixo de texto no comentario que explica a barreira de tempo de compilacao contra bypass do gate. O codigo estava certo; o texto que documenta a barreira nao.
- **Fix:** reescrito o trecho. Nenhuma mudanca de comportamento.
- **Files modified:** `src/application/dispatcher.ts`
- **Verification:** `tsc --noEmit` limpo; `biome check` limpo
- **Committed in:** `a99e33a`

**2. [Rule 1 - Bug] Migration gravada com o numero errado no plano**
- **Found during:** Task 2
- **Issue:** o plano e o SUMMARY anterior citavam `0001_guards_and_audit.sql`, mas o `0001` real ja era `channel_accounts_phone_e164_unique.sql` do plano 01-01. O nome correto e `0004_guards_and_audit.sql` porque `0002` e `0003` ja estavam aplicados.
- **Fix:** migration criada como `0004_guards_and_audit.sql` e `meta/_journal.json` atualizado; este SUMMARY cita o nome real.
- **Files modified:** `src/infra/db/migrations/0004_guards_and_audit.sql`, `meta/_journal.json`, `meta/0004_snapshot.json`
- **Verification:** `migrations_applied` = 5 no `app.log`; triggers observados no banco real
- **Committed in:** `73b66fd`

**3. [Rule 2 - Missing Critical] `blocked_attempts` perdia todo negativo do gate**
- **Found during:** Task 2, escrito pelos testes vermelhos de `cfc3962`
- **Issue:** o caminho de gravacao usava `db.execute` com uma string solta, deixando `$1..$3` sem bind, dentro de um `try/catch` que apenas logava. R-022 (todo negativo do gate vira linha auditavel) estava declarado e nao existia: o gate bloqueava em silencio e nada era registrado.
- **Fix:** `src/infra/db/queries/blocked-attempts.ts` com binds reais, e `fn_preencher_blocked_attempt` para derivar `guard_id` no banco em vez de confiar no chamador.
- **Files modified:** `src/infra/db/queries/blocked-attempts.ts`, `0004_guards_and_audit.sql`, `tests/gate/kill-switch.test.ts`
- **Verification:** 39 testes verdes (7 arquivos); o teste do `INSERT` minimo do dispatcher passa com `guard = AR-001`
- **Committed in:** `cfc3962` (teste vermelho) -> `73b66fd` (implementacao)

**4. [Rule 2 - Missing Critical] `guard_id` NOT NULL deixava a trilha inutilizavel**
- **Found during:** Task 2
- **Issue:** `blocked_attempts.guard_id` NOT NULL significa que um negativo cujo chamador nao passou o guard era descartado inteiro — e perder a trilha e perder a prova. Uma coluna NOT NULL sem caminho de preenchimento e um `NOT NULL` que so produz erros.
- **Fix:** trigger `fn_preencher_blocked_attempt` deriva o `guard_id` a partir do `reason` gravado, tornando a coluna sempre preenchivel.
- **Files modified:** `0004_guards_and_audit.sql`
- **Verification:** testes verdes cobrem o caminho de preenchimento pelo trigger
- **Committed in:** `73b66fd`

### Desviosambientais (nao auto-corrigiveis, exigiram intervencao humana)

**5. BOM UTF-8 em `postgresql.conf` — o servidor recusou subir**
- **Found during:** Task 3
- **Issue:** `scripts/pg-hba-apply.ps1` reescreveu o arquivo via PowerShell, que prepende BOM `EF BB BF`. O PostgreSQL 18 recusou subir com "erro de sintaxe na linha 1".
- **Fix:** reescrito com `[System.IO.File]::WriteAllText` usando `UTF8Encoding($false)`.
- **Acao preventiva:** proibir `Set-Content`, `Out-File` e `>` para editar `postgresql.conf`. Usar Notepad, VSCode ou `System.IO.File::WriteAllText`. **Registrado em `AGENTS.md`** (ver commit deste plano).
- **Estado:** resolvido

**6. `icacls.exe` falhou no Scope 2 — o arquivo temporario nao existia mais**
- **Found during:** Task 3
- **Issue:** o script criou um temporario em `%TEMP%`, chamou `icacls.exe` para restringir a ACL, mas o arquivo ja tinha sido deletado. O script abortou o Scope 2.
- **Fix:** `ALTER ROLE whatsapp_bot WITH PASSWORD` executado manualmente via `psql`.
- **Bug para correcao futura:** reordenar a limpeza ou capturar o erro do `icacls` no script. **Registrado em `docs/pendencias.md` (P-002).**

**7. `Restart-Service` exige PowerShell elevado**
- **Found during:** Task 3
- **Issue:** o plano nao documentava elevacao; `Restart-Service postgresql-x64-18` falhou silenciosamente como nao-admin.
- **Fix:** executado em PowerShell Admin.
- **Acao preventiva:** documentar que o restart exige elevacao.

### Desvios de rotulo (Task 4)

**8. [Rule 3 - Blocking] `teste_balanceamento.md` -> `teste-balanceamento.md`**
- **Found during:** Task 4
- **Issue:** o gate <automated> exige o nome com **hifen** (`teste-balanceamento.md`); o arquivo em disco usava underscore. Um dos 12 checks falhava por nome de arquivo.
- **Fix:** `git mv` com o nome exigido pelo gate. Git registrou como rename.
- **Files modified:** `docs/lgpd/teste_balanceamento.md` -> `docs/lgpd/teste-balanceamento.md`
- **Verification:** `Test-Path` do underscore = `False`; 12/12 checks
- **Committed in:** `b4f31ef`

**9. [Rule 1 - Bug] 7 dos 12 checks do gate <automated> falhavam na versao anterior dos documentos**
- **Found during:** Task 4
- **Issue:** os 5 documentos tinham sido escritos em um commit cujo texto estava corrompido (mojibake) e, em varios pontos, afirmava coisas que o schema nao sustenta. Reproduzido contra o commit `77bb7df`, os 7 checks que falhavam eram:
  1. `existe teste-balanceamento.md (com hifen)` — o arquivo era `teste_balanceamento.md`
  2. `canal-do-titular.md contem optout_ledger` — o documento citava `leads.opt_out` mas nao a tabela de auditoria
  3. `canal-do-titular.md contem erasure_request` — nao havia nenhum procedimento de eliminacao
  4. `retencao-e-eliminacao.md contem optout_ledger` — o prazo de retencao do opt-out nao existia
  5. `adr-002 contem listen_addresses` — o ADR afirmava o risco aceito sem citar a mitigacao real aplicada
  6. `encarregado-dpo.md contem PREENCHER` — os campos de identificacao do encarregado estavam como marcadores vazios, nao como placeholdersidentified
  7. `retencao-e-eliminacao.md contem pg_dump` — o backup nao era menciona despite R-032
- **Fix:** os 5 documentos foram reescritos como procedimento operacional, com cada claim conferido contra `src/infra/db/schema.ts` e `0004_guards_and_audit.sql`. Texto em UTF-8 limpo.
- **Files modified:** os 5 documentos de `docs/lgpd/` e `docs/adr/002-*`
- **Verification:** 12/12 checks; checker estrito de U+FFFD retorna "nenhum mojibake" nos 5
- **Committed in:** `b4f31ef`

**10. [Rule 1 - Bug] `STATE.md` perdeu o progresso no commit `77bb7df`**
- **Found during:** Task 4, leitura do estado
- **Issue:** o commit que trouxe os documentos tambem sobrescreveu `percent: 0` e `completed_plans` para 1, zerando o progresso de 20% que o plano 01-01 tinha registrado. O SUMMARY anterior (24 linhas) era um bloco de desvios, nao um SUMMARY.
- **Fix:** `STATE.md` sincronizado para `completed_plans: 2`, `percent: 40`, e o SUMMARY reescrito no template completo.
- **Files modified:** `.planning/STATE.md`, este SUMMARY
- **Verification:** contagem de SUMMARYs em disco = 2; `roadmap update-plan-progress` reexecutado
- **Committed in:** este commit

---

**Total deviations:** 10 (4 auto-fixed: 3 bugs + 1 missing critical; 1 blocking; 3 ambientais; 2 de documentacao)
**Impact on plan:** Os 4 auto-fixes sao de correção — os invariantes de R-043/R-024/LEAD-04 e a trilha R-022 estavam declarados no plano e nao existiam. Os desvios ambientais sao de infraestrutura Windows/PostgreSQL e nao alteraram escopo. Os desvios de documentacao nao acrescentaram escopo: reescreveram o que ja era Task 4.

## Issues Encountered

- **`git mv -f` sobrescreveu o conteudo novo pelo conteudo tracked antigo.** O comando `git mv -f docs/lgpd/teste_balanceamento.md docs/lgpd/teste-balanceamento.md` substituiu o arquivo recem-escrito pelo conteudo antigo que estava no index, e o check do section "quando o balanceamento deixa de fechar" voltou a falhar. Detectado porque um check extra alem dos 12 estava inconsistent. **Resolvido reescrevendo o arquivo apos o rename.** A licao: em Windows, `-f` no `git mv` resolve conflito de nome, nao de conteudo.
- **`icacls.exe` no Scope 2 do `pg-hba-apply.ps1`** — ver desvio 6. O script esta correto ate a limpeza do temporario; o bug e de ordenacao.
- **`Restart-Service` sem elevacao** — ver desvio 7.

## Estado final verificado

- `SHOW listen_addresses` = `localhost`
- `migrations_applied` = 5 no `app.log`
- 4 bancos intactos (`auth`, `pizzaria_db`, `vidracaria`, `vidracaria_test`)
- Backup do `postgresql.conf` preservado: `postgresql.conf.20261001-100404.bak`
- `npm test` = 39/39 verdes em 7 arquivos
- `npx tsc --noEmit` = sem saida
- `npx biome check src tests scripts` = `Checked 40 files`, sem erros
- Gate <automated> da Task 4 = 12/12

## User Setup Required

Nenhuma. A Task 3 teve um checkpoint humano ja aprovado pelo Admin (elevacao de PowerShell para o `Restart-Service`); nenhuma configuracao externa ficou pendente.

## Next Phase Readiness

- **Pronto para o plano 01-03:** o schema tem as 15 tabelas, o gate tem a trilha de auditoria que dependia, e o PostgreSQL esta endurecido com `listen_addresses = localhost`.
- **Atencao no 01-03:** `CHANNEL_PHONE_E164` ainda tem o placeholder `+5511999999999` e precisa do numero real **antes** do pareamento QR.
- **Atencao no 01-03:** `fetchNewChatMessageCap()` / `fetchAccountReachoutTimelock()` precisam ser confirmados nos typings do `@whiskeysockets/baileys@7.0.0-rc14` instalado (ADR-001). Sem eles, WHS-04 e LEAD-03 ficam sem implementacao.
- **Pendente do plano 01-01:** revalidar R-013 com `npm run notify -- -Title "Teste R-013" -Message "Verificacao" -Urgent` apos o reboot do Windows (`WpnUserService` estava parado).
- **Pendencias abertas:** `docs/pendencias.md` tem P-002 (`Register-Aumid` → `ArgumentException` em 6 eventos, best-effort por decisao; bug de ordenacao do `icacls` em `pg-hba-apply.ps1`).

---
*Phase: 01-funda-o-canal-e-gate-de-envio*
*Plan: 02*
*Completed: 2026-10-05*