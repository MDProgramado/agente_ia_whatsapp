# Pendências Abertas

Registro de problemas conhecidos que **não** bloqueiam o desenvolvimento mas que não podem ser
esquecidos. Cada item diz o que foi observado, o que já se sabe, e o que seria preciso para fechar.

Uma pendência entra aqui quandocorrigi-la exigiria uma decisão que não é do plano: mudança de
comportamento,touch em arquivo de outro plano, ou decisão de produto. Defeito que o executor
consiga corrigir com segurança é corrigido e vira commit, não pendência.

---

## P-001 — Toast nativo do Windows sem AUMID registrado ✅ RESOLVIDO

**Status:** Resolvido em 2026-10-05. Decisão de não corrigir o script; a pendência fica fechada.
**Verificação humana (2026-10-05):** o toast foi **exibido de verdade** — `npm run notify -- -Title "Teste R-013" -Message "Verificacao" -Urgent` apresentou o toast "WhatsApp Prospecção" após o registro do AUMID abaixo. Não foi só `toast_sent` no log; a entrega visual foi atestada.

**Origem:** Task 6 do plano 01-01.

**Sintoma:** o toast não aparecia mesmo com notificações ativas, Foco Assistente desligado e
`explorer`/`ShellExperienceHost`/`StartMenuExperienceHost`/`RuntimeBroker` rodando. A gravação
passava (`Show()` sem erro, linha criada em `wpndatabase.db`, log `toast_sent`) e a entrega
nunca ocorria (`LastNotificationAddedTime` não era atualizado).

**Causa raiz:** o AUMID não estava registrado. `CreateToastNotifier($Aumid)` emite para um
AppUserModelID que o Windows não conhece, e o Windows descarta o toast silenciosamente — sem
erro, sem evento. É o comportamento documentado do WinRT para AUMID desconhecido.

**Solução aplicada:** registro manual do AUMID em `HKCU\SOFTWARE\Classes\AppUserModelId`:

```powershell
$Aumid = "WhatsAppProspect.Automacao"
$RegPath = "HKCU:\SOFTWARE\Classes\AppUserModelId\$Aumid"
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name "DisplayName" -Value "WhatsApp Prospecção"
```

**Decisão de não corrigir `notify.ps1`:** o registro é manual e permanente, então o caminho
automático dentro do script virou redundante. Tocar no script agora mexeria em R-013 — a
notificação de handoff, que é load-bearing — sem benefício observado. O caminho automático
permanece como best-effort (ver P-002) e o manual é o que funciona.

**Como confirmar que o toast aparece:** `npm run notify -- -Title "Teste R-013" -Message "Verificacao" -Urgent`.
O toast deve aparecer com o nome "WhatsApp Prospecção". O log deve mostrar `event=toast_sent`
(que mostra que a chamada passou, **não** que o Windows exibiu) e o log de notificações do
Windows deve registrar a entrega.

---

## P-002 — `Register-Aumid` falha sempre, mas é best-effort por decisão ⚠️ ABERTO

**Status:** Aberto. **Não é bug a ser corrigido agora** — é comportamento aceito e
documentado. Registrado para que ninguém leia o `ArgumentException` no log como regressão.

**Origem:** Task 6 do plano 01-01, observado de novo em 2026-10-05.

**Sintoma:** toda invocação de `notify.ps1` registra

```
event=aumid_registration_skipped detail=ArgumentException: O valor não recai no intervalo esperado
```

**Contagem:** 6 falhas registradas até 2026-09-30 (durante a Task 6 do plano 01-01) e outras 7
em 2026-10-05, totalizando 13 no `notifications.log`. Nenhuma delas impediu o `toast_sent`
—12 `toast_sent` no mesmo log.

**Causa provável:** o `SetValue(ref PROPERTYKEY, ref PROPVARIANT)` do `IPersistPropertyStore2`
em `notify.ps1:118` monta o `PROPVARIANT` com o `CoTaskMemAlloc` manual e passa `ref`. O
`ArgumentException` é do marshaling do `PROPVARIANT` para o shell — o tipo do variant não é
aceito por esse caminho. Isso é hipótese: **não foi depurado**, e o objetivo de depurar foi
descartado, porque o registro manual de P-001 já resolve o problema.

**Por que fica aberto e não é corrigido:**

1. **AUMID controla o nome do toast, não a emissão.** Um registro de branding que falha não pode
   impedir a notificação — R-013 exige que o Admin seja avisado. O `try/catch` em
   `notify.ps1:141` já garante isso: a falha do registro é logada e a execução segue.
2. **A causa raiz não é bastante para justificar o risco.** Consertar significa reescrever
   o marshaling de `PROPVARIANT` em C# inline dentro de um script que é a notificação de
   handoff. Se a reescrita errar, o defeito passa de "o toast se chama 'App' " para "o toast
   não é emitido" — e R-013 é load-bearing: handoff, opt-out e mídia recebida dependem de o
   Admin *saber* que precisa agir.
3. **Já existe caminho funcional.** O registro manual de P-001 é permanente.

**Como fechar, quando valer a pena:** alguém deve depurar o `PROPVARIANT` isoladamente, fora de
`notify.ps1` — um script de teste que só registra o AUMID e não emite nada. Se o
`SetValue` funcionar isolado, a correção é trocar o caminho no script. Se falhar igual, o
defeito é do shell nesta máquina e o registro manual é a resposta definitiva, e o item deve ser
fechado como "won't fix".

**Sinal de que mudou:** se `notifications.log` passar a mostrar `event=aumid_registered` em vez
de `aumid_registration_skipped`, o caminho automático voltou a funcionar e este item pode ser
fechado sem tocar em nada.

---

## P-003 — `icacls.exe` falha no Scope 2 de `pg-hba-apply.ps1` ⚠️ ABERTO

**Status:** Aberto. Não bloqueia: o efeito desejado foi alcançado manualmente.

**Origem:** Task 3 do plano 01-02, 2026-10-01.

**Sintoma:** o script cria um arquivo temporário em `%TEMP%`, chama `icacls.exe` para restringir
a ACL, e aborta o Scope 2 porque o arquivo temporário **já foi deletado** no momento da chamada.

**Correção aplicada na ocasião:** `ALTER ROLE whatsapp_bot WITH PASSWORD` executado manualmente
via `psql`. O resultado desejado (role com senha SCRAM) foi atingido; só o caminho automático
do script não é confiável ainda.

**O que falta:** reordenar o script para chamar `icacls.exe` antes de deletar o temporário, ou
capturar o erro do `icacls` e logar em vez de abortar o scope inteiro. É mudança em
`scripts/pg-hba-apply.ps1`, que pertence à Task 3 do plano 01-02 — não foi tocada para não
alterar um script de infra já validado.

**Por que não foi corrigido agora:** o script funcionou para o que importa (o PostgreSQL ficou
com `listen_addresses = localhost` e senha SCRAM), e mexer no caminho de já-aplicado tem custo
de revalidação maior que o benefício. Próxima vez que o script rodar em ambiente novo, o Scope 2
vai abortar de novo — e isso precisa ser corrigido antes de depender dele.

---

## P-004 — Pareamento companion do Baileys falha em silêncio ✅ CORRIGIDO (2026-10-15) — bloqueio restante → P-007

**Status:** **CORRIGIDO em 2026-10-15** (commit `2d64728`) — a corrida entre `requestPairingCode` e
a abertura do WebSocket (a causa da falha em silêncio) foi fechada; o boot chega a `connected to WA` →
`pairing_code` → `channel_ready`. O pareamento em si **ainda não completa**, mas o bloqueio restante é
**P-007** (socket cai logo após `channel_ready`), não mais este item. **P-004 e P-007 estão deferidos e
não bloqueiam a Fase 3.** Ainda assim bloqueia a Task 3 do plano 01-03 (checkpoint humano de pareamento
do número dedicado); **não** bloqueia 01-04/01-05, que não dependem de canal pareado (decisão do Admin,
2026-10-09). Registrado para não se perder o lastro técnico do diagnóstico.

**Origem:** Task 3 do plano 01-03, 2026-10-08/09. Diagnóstico completo em
`.planning/phases/01-funda-o-canal-e-gate-de-envio/01-03-DIAG.md`.

**Sintoma:** o Baileys gera o par de 8 dígitos em `C:\whatsapp_prospecao\logs\qr.txt`, mas ao
digitá-lo no celular (Aparelhos conectados → Conectar com número de telefone) a tela mostra
"não foi possível conectar" ou fica carregando. **Nada aparece no `app.log`.** Após relançar, o
boot aborta com `CREDS_INVALID`.

**O que já foi descartado por leitura do código (rc14):**

- `companion_platform_display` **é** enviado (`Socket/socket.js:640-643`); o default do pacote é
  `Browsers.macOS("Chrome")` → `"Chrome (Mac OS)"`. Não é campo vazio/genérico. **Corrigido:** a
  aplicação passa a anunciar `Browsers.windows("Chrome")` → `"Chrome (Windows)"` (commit T2).
- O estágio `companion_finish` **está** implementado (`Socket/messages-recv.js:881-942`).
- `companion_reg_refresh` **não** é tratado em nenhum arquivo do pacote (sem `default` no
  `processNotification`) e **não é interceptável** de dentro de `src/` — exigiria patch de vendor.

**Suspeito principal (não verificável sem retry físico):** a **versão de protocolo hardcoded**
`[2, 3000, 1043857760]` (`lib/Defaults/index.js:5`). `fetchLatestBaileysVersion()` existe
(`lib/Utils/generics.js`) e **não é usado**, então o socket pode anunciar uma revisão desatualizada
que o servidor recusa em silêncio no `link_code_companion_reg`.

**Bug nosso confirmado (relacionado) — ✅ CORRIGIDO:** `requestPairingCode` persiste `creds.json`
com `registered=false`; o boot seguinte via JSON em disco + `registered !== true` e lançava
`CREDS_INVALID`, de modo que um pareamento abandonado (Ctrl+C) envenenava todo retry. A guarda
agora distingue "creds corrompido" de "pareamento em andamento": a função pura
`avaliarGuardDeAuth` (`src/channel/baileys/session.ts`) trata `.json` + `registered=false` +
`pairingCode` como **re-pareável** (não aborta) e só aborta quando não há `pairingCode`. Coberto por
`tests/channel/session-auth-guard.test.ts`.

**Aplicado como mitigação (commit T3):** `BAILEYS_LOG_LEVEL` (default `warn`) controla o logger do
socket; `BAILEYS_LOG_LEVEL=debug` no `.env` torna a próxima tentativa auditável no `app.log` em vez
de silenciosa.

**Como fechar:** (1) retry manual do pareamento com `BAILEYS_LOG_LEVEL=debug` e inspeção do
`app.log`; (2) se ainda falhar em silêncio, `patch-package`/fork com
`version: (await fetchLatestBaileysVersion()).version` e um `case 'companion_reg_refresh'` — diff
mínimo proposto em T4 do DIAG; (3) se nenhum resolver, tratar como risco do canal (R-059). Antes de
trocar de fork, comparar a API (`makeWASocket`, `useMultiFileAuthState`, `Browsers`,
`fetchNewChatMessageCap`, `fetchAccountReachoutTimelock`) e revalidar WHS-04/LEAD-03 (ADR-001).

**Atualização (2026-10-15) — causa do silêncio encontrada e corrigida:** o boot morria no
`requestPairingCode` com `Boom('Connection Closed')` sempre que o WebSocket ainda **não** estava
aberto (`Socket/socket.js:59-61`), e `main().catch` só imprimia no console — daí "nada aparece no
`app.log`". O `requestPairingCode` gasta ~240 ms no PBKDF2 de `generatePairingKey`
(`Utils/crypto.js:112`) antes de enviar, então o handshake de rede tinha exatamente essa janela; com
rede fria (TLS medido em ~370 ms) perdia a corrida e morria no throw. Corrigido com
`aguardarSocketAberto` (`waitForSocketOpen` + timeout de 30 s) antes de todo pareamento, log de boot
no `app.log`, `SIGINT`/`SIGTERM` registrados cedo e `cd /d "%~dp0.."` no launcher (commit `2d64728`).
Boot ao vivo em 2026-10-15 11:41 chegou a `connected to WA` → `pairing_code` → `channel_ready`
(antes morria em `loaded tctoken index`). **O suspeito de versão de protocolo foi descartado** (T4a:
`fetchLatestBaileysVersion()` == hardcoded, `isLatest=true`). O bloqueio restante do pareamento é
**P-007**.

---

## P-007 — Socket cai logo após `channel_ready`, antes do pareamento completar (T6) ⚠️ ABERTO

**Status:** Aberto — **experimentos executados e ambos falharam (2026-10-15)**; critério de parada atingido.
P-007 é um **bloqueio conhecido do rc14** contra o servidor atual, **deferido como ADR-002** (avaliação de
fork futura). Bloqueia a Task 3 do plano 01-03 (pareamento do número dedicado) mas **não bloqueia a Fase 3**
(ROADMAP: "em caso de insucesso dos 2 experimentos, seguir para Fase 3"). É o **próximo
bloqueio**, revelado depois de corrigir a corrida do P-004 — o boot agora chega a `channel_ready`.
Diagnóstico em `.planning/phases/01-funda-o-canal-e-gate-de-envio/01-03-DIAG.md` (§T6 e §Resultado).

**Numeração:** referido como **T6** no DIAG; registrado aqui como **P-007** porque P-005 (app_users)
e P-006 (handoff) já existem neste arquivo.

**Origem:** validação ao vivo do P-004, 2026-10-15 11:41.

**Sintoma:** com a corrida do P-004 fechada, o boot chega a `connected to WA` → `pairing_code` →
`channel_ready`, mas o socket cai logo depois — **antes** de qualquer humano conseguir digitar o par
de 8 dígitos. Não há tempo útil para parear; `creds.json` segue `registered=false`.

**Observação (os dois boots que chegaram a `channel_ready`):**

| | 10/09 14:23 | 15/10 11:41 |
|---|---|---|
| evento após `channel_ready` | `Connection Terminated` (ws `close`, `socket.js:690`) | `Connection Failure` (stanza `CB:failure`, `socket.js:798-800`) |
| statusCode | 428 `connectionClosed` | `+(node.attrs.reason \|\| 500)` → 500 `badSession` |
| classificação | `connection_closed`, terminal=**false** | `logged_out`, terminal=**true**, critical |
| desfecho | seguiu vivo até SIGINT (~87 s) | shutdown limpo ~2,5 s depois |

O drop pós-pareamento **já existia** (10/09, 237 ms após `channel_ready`); o que muda é a
classificação. O rc14 **não loga** o `reason` real do `CB:failure` (`socket.js:798` não loga
`node.attrs`), então não há visibilidade do que o servidor recusou.

**Por que bloqueia:** o fluxo do código de pareamento exige o socket VIVO até o telefone confirmar (a
credencial chega pelo socket que pediu o par). 2,5 s (e 237 ms em 10/09) é curto demais para um
humano digitar o par.

**Pistas (não confirmadas):**

1. Timeout/teardown do pré-pareamento — mas 2,5 s é curto demais para ser timeout de humano.
2. Creds de "pareamento abandonado" (`registered=false` + `pairingCode`) podem induzir rejeição: a
   sessão de 15/10 era um pareamento abandonado; a de 10/09 era nova (`pasta_existia=false`).
3. `companion_reg_refresh` ignorado pelo rc14 (hipótese 2 do T4; patch T4c candidato).
4. Falta de visibilidade do `reason` do `CB:failure` (`socket.js:798` não loga `node.attrs`).

**Como fechar:** (Exp. 1) boot com auth 100% limpo para ver se o socket sobrevive ao pedido de par;
(Exp. 2) se cair igual, aplicar o patch T4c (`case 'companion_reg_refresh'`) via `patch-package`;
(fallback) se ambos falharem, tratar como bloqueio do rc14 contra o servidor atual (R-059) e
considerar fork (`@ndikagatengg/baileys`) como **ADR-002** — sem bloquear a Fase 3.

### Resultado dos experimentos (2026-10-15 — executado, uma variável por vez)

- **Exp. 1 (auth 100% limpo — `pasta_existia=false`):** FALHOU igual. Sequência: `connected to WA` →
  `pairing_code` → `channel_ready` → **~1,2 s depois** `Connection Failure` (stanza `CB:failure` sem
  `reason`) → `logged_out`, `terminal=true`, severity=critical → shutdown (motivo=`canal_logged_out`).
  Não é 428 transiente; é 500 terminal.
- **Exp. 2 (T4c — patch `case 'companion_reg_refresh'` no vendor):** FALHOU igual. Sequência idêntica:
  `channel_ready` → **~4,6 s depois** `Connection Failure` → `logged_out`, `terminal=true` → shutdown.
  Nenhum evento `companion_reg_refresh` chegou a ser logado (o handler não foi exercitado).

**Conclusão (critério de parada atingido — time-box):** ambos os experimentos falharam.
**P-007 confirmado como bloqueio do `@whiskeysockets/baileys@7.0.0-rc14` contra o servidor WhatsApp
atual** — o socket morre logo após `channel_ready`, antes do pareamento completar, com `CB:failure` sem
`reason` (500 → `badSession` → `logged_out`), e o rc14 não loga `node.attrs`, então não há como avançar
por este caminho sem ADR-002.

**Desfecho:** PARAR os experimentos. Considerar fork (`@ndikagatengg/baileys` ou similar) como
**ADR-002** (avaliação futura, comparando exports e revalidando WHS-04/LEAD-03 antes de trocar).
**Seguir para a Fase 3** (não bloqueia o roadmap) — o pareamento por este caminho permanece bloqueado
até uma decisão de ADR-002.

---

## P-005 — Linha do Admin em `app_users` inexistente ✅ RESOLVIDO (2026-10-13)

**Status:** Resolvido. Encontrado na verificação de fase (2026-10-13, gap #1) e correto no mesmo dia.

**Origem:** `.planning/phases/01-funda-o-canal-e-gate-de-envio/VERIFICATION.md` (gap #1).

**Sintoma:** o must_have do plano 01-02 é "um único usuário administrador existe como **linha** em
`app_users` (EQUP-01/R-027)". A tabela existe com o DDL correto (migration `0003_phase01_02_tabelas.sql`),
mas está **vazia** (`SELECT count(*) FROM app_users` = 0) e **não há nenhum INSERT** dessa linha em todo o
repositório (nenhum seed, bootstrap, `launch.cmd` ou código de boot).

**Impacto:** R-027 ("usuário único; sem perfis/permissões") está satisfeito no nível do schema, mas a
verdade literal do plano não é observável. As colunas nullable de authorship (EQUP-02) existem; sem a linha
do Admin, não há `id` para preencher `leads.created_by` / `conversations.responsible_user_id` /
`messages.author_user_id`.

**Correção aplicada (2026-10-13, commit fix(01-02)):** migration de seed idempotente
`0005_seed_admin.sql` — `INSERT INTO app_users (name, email) VALUES ('Admin', 'admin@whatsapp-prospect.local')
ON CONFLICT (email) DO NOTHING`. **Sem `role='ADMIN'` de propósito:** a tabela não tem coluna `role`
(R-027 adia perfis; adicioná-la seria mudança de schema). E-mail é placeholder porque `email` é NOT NULL e
a linha nasce aqui; o Admin pode trocá-lo depois. Prova: `tests/ops/seed-admin.test.ts` (`app_users >= 1` após
`openDb`, que roda `migrate()`). Re-verificado em 2026-10-13 — EQUP-01 fechado.

---

## P-006 — Transição de handoff → `engagement_mode = awaiting_human` ✅ RESOLVIDO (2026-10-14)

**Status:** ✅ Resolvido em **2026-10-14** — o plano **02-02** (decisão do Admin de 2026-10-13 de adiar à
Fase 2) cumpriu exatamente o que este item pedia. O `HandoffService` (`src/application/handoff-service.ts`,
`dispararHandoff`) grava as quatro escritas numa **transação única**: `handoff_events` (append-only) +
`mode_changes` (`from_mode` real lido da conversa → `awaiting_human`) +
`conversations.engagement_mode='awaiting_human'`/`handoff_active=true` + `status_history` (via
`resolveNextState` — a FSM decide o `state`). A truth do must_have do 01-05 (NFRQ-04/AR-010) é observável:
o **escritor** que faltava existe e a guarda `ar010_handoff_ativo` lê sinal real.

**Origem:** `.planning/phases/01-funda-o-canal-e-gate-de-envio/VERIFICATION.md` (gap #2) — truth do must_have
do plano 01-05 (NFRQ-04/AR-010).

**Sintoma:** a verdade de plano "uma notificação de handoff para imediatamente o envio — o `inbound-handler`
grava `handoff_events` **e** muda `engagement_mode` para `awaiting_human` na mesma transação" não é
observável na Fase 1: **nenhum código do `src` escreve** `conversations.engagement_mode = 'awaiting_human'`
nem `handoff_active = true`. A guarda **AR-010** (`ar010_handoff_ativo`) apenas **lê** esses campos.
O `HandoffService` + `mode_changes` estão explicitamente alocados à Fase 2 (ROADMAP, plano 02-02), então a
truth é parcialmente forward-looking.

**O que já está entregue na Fase 1 (mecânica):** `handoff_events`/`pending_media_block` escritos
(AR-009 bloqueia mídia recebida), guarda AR-010 pronta para bloquear quando o sinal existir, notificação
local (R-013) e logs. Falta exatamente o **escritor** do sinal, que é escopo do 02-02 junto do LLM/gatilhos
de handoff (R-012/R-038/R-056/R-065).

**Como fechar:** no plano 02-02, implementar o `HandoffService` que grava `handoff_events` + muda
`engagement_mode`/`handoff_active` na mesma transação; re-verificar a truth do must_have.
→ **Cumprido (2026-10-14, plano 02-02):** `dispararHandoff` entrega a transação única descrita acima;
prova nos testes do 02-02 (idempotência via `FOR UPDATE`, notificação fora da transação).

---

## P-008 — Defeitos de documentação da Fase 3 (R-004 × R-005, R-058 inexistente, RN-009 × AR-007) ✅ RESOLVIDO (2026-10-21)

**Status:** Resolvido em 2026-10-21 (plano 03-08, Task 2 — reconciliação D-26).

**Origem:** `.planning/research/FEATURES.md` §8 ("R-058 é citado no anti-requisito AR-007 mas não
existe no doc de requisitos") e `.planning/research/SUMMARY.md` ("Defeitos de doc"). Decisões de
fase: `03-CONTEXT.md` (D-11, D-26).

**Sintoma:** três defeitos de texto nos documentos canônicos:

1. **R-004 × R-005** — R-004 descrevia a cadência como `1h → 1d → 3d → 7d → 15d`, enquanto R-005
   dizia que o máximo é de **4 tentativas** e que o toque de 15 dias **não** deve ser executado.
   O roadmap já tinha reconciliado isso no `PROJECT.md`, mas não no doc de requisitos.
2. **R-058 não existia** — AR-007, RN-008 e AC-002 citavam "R-058" como se o requisito existisse;
   a varredura de `docs/01-requisitos-funcionais.md` não encontrava o item.
3. **RN-009 × AR-007/R-058** — RN-009 mandava enviar follow-ups vencidos "ao abrir o app, **mesmo
   fora da janela**", contradizendo a fronteira dura da janela (dias úteis, 7h–17h).

**Correção aplicada (2026-10-21, plano 03-08):**

- `docs/01-requisitos-funcionais.md` — R-004 e R-005 reconciliados (marca "reconciliado com
  ADR-009 — Fase 3" + referência cruzada ao ADR-014) e **R-058 acrescentado** ("Silêncio do bot
  fora da janela operacional"), com a mesma marca.
- `docs/03-regras-de-negocio.md` — RN-009 reconciliado (fora da janela **enfileira**, dentro dela
  **envia**; o excedente é adiado, nunca descartado) e **`isCatchupDrain` documentado como
  PARÂMETRO de boot**, não campo de `settings` nem modo global (nova seção §2.1).
- `docs/08-adr/014-scheduler-cadencia.md` (novo) e `docs/08-adr/015-pipeline-crm-copiloto.md`
  (novo) — D-26. O **ADR-009 permanece a autoridade** da cadência: o ADR-014 detalha o motor
  (âncora no último toque, teto duro de 4, dreno como válvula) sem contradizê-lo.

**Como confirmar:** `grep -c "R-058" docs/01-requisitos-funcionais.md` ≥ 1;
`grep -c "reconciliado com ADR-009" docs/01-requisitos-funcionais.md docs/03-regras-de-negocio.md`
≥ 1 em cada arquivo; `grep -c "isCatchupDrain" docs/03-regras-de-negocio.md` ≥ 1.

---

## Verificações humanas registradas

Resultados atestados por **humano** (e não por teste automatizado), com data e evidência:

- **Toast R-013 (2026-10-05):** `npm run notify` exibiu o toast "WhatsApp Prospecção" de verdade
  após o registro manual do AUMID `WhatsAppProspect.Automacao` em `HKCU\SOFTWARE\Classes\AppUserModelId`
  (P-001). Causa raiz confirmada: AUMID ausente, não o serviço `WpnUserService`.
- **Restauração de backup (2026-10-13):** `backup.ps1 -Verify` terminou com exit 0 — `pg_restore` numa
  base temporária com as 4 contagens conferidas contra a origem: leads 2=2, conversations 0=0,
  messages 0=0, daily_counters 0=0 (NFRQ-02, R-032).

---

## Como este arquivo é usado

- **Antes de dar um plano por concluído:** ler este arquivo e conferir se alguma pendência mudou
  de estado.
- **Ao tentar parear o canal (Task 3 do plano 01-03):** a falha silenciosa do P-004 está corrigida
  (`2d64728`); agora o boot chega a `channel_ready` e, se cair, aparece no `app.log`. O bloqueio
  restante é **P-007** (socket cai logo após `channel_ready`) — os experimentos Exp. 1/Exp. 2 já foram
  executados em 2026-10-15 e **ambos falharam**; não adianta repetir `BAILEYS_LOG_LEVEL=debug` por este
  caminho, o desfecho é ADR-002 (avaliação de fork).
- **Ao ver `aumid_registration_skipped` no log:** não é regressão. Ver P-002.
- **Ao rodar `pg-hba-apply.ps1`:** esperar o Scope 2 abortar. Ver P-003.
- **Ao citar a cadência de follow-up:** a leitura canônica é o ADR-009 (1h/1d/3d/7d, 4 toques) e
  o detalhe do motor é o ADR-014. O 15º dia não existe. Ver P-008.
- **Ao fechar uma pendência:** mudar o status para ✅, datar, e registrar a decisão tomada.

---

*Criado em 2026-10-05 (Task 4 do plano 01-02). P-001, P-002, P-003, P-004 e P-005 (2026-10-13); P-006 (2026-10-13, fechado 2026-10-14); P-007 (2026-10-15, experimentos concluídos 2026-10-15 — ambos falharam, desfecho ADR-002); P-008 (2026-10-21, reconciliação documental da Fase 3 — plano 03-08).*
