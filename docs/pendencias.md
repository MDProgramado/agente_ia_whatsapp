# Pendências Abertas

Registro de problemas conhecidos que **não** bloqueiam o desenvolvimento mas que não podem ser
esquecidos. Cada item diz o que foi observado, o que já se sabe, e o que seria preciso para fechar.

Uma pendência entra aqui quandocorrigi-la exigiria uma decisão que não é do plano: mudança de
comportamento,touch em arquivo de outro plano, ou decisão de produto. Defeito que o executor
consiga corrigir com segurança é corrigido e vira commit, não pendência.

---

## P-001 — Toast nativo do Windows sem AUMID registrado ✅ RESOLVIDO

**Status:** Resolvido em 2026-10-05. Decisão de não corrigir o script; a pendência fica fechada.

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

## P-004 — Pareamento companion do Baileys falha em silêncio ⚠️ ABERTO

**Status:** Aberto. **Bloqueia a Task 3 do plano 01-03** (checkpoint humano de pareamento do número
dedicado); **não** bloqueia 01-04/01-05, que não dependem de canal pareado (decisão do Admin,
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

**Bug nosso confirmado (relacionado):** `requestPairingCode` persiste `creds.json` com
`registered=false`; no próximo boot `src/channel/baileys/session.ts` vê JSON em disco +
`registered !== true` e lança `CREDS_INVALID`. Um pareamento abandonado envenena o boot seguinte. A
guarda precisa distinguir "creds corrompido" de "pareamento em andamento".

**Aplicado como mitigação (commit T3):** `BAILEYS_LOG_LEVEL` (default `warn`) controla o logger do
socket; `BAILEYS_LOG_LEVEL=debug` no `.env` torna a próxima tentativa auditável no `app.log` em vez
de silenciosa.

**Como fechar:** (1) retry manual do pareamento com `BAILEYS_LOG_LEVEL=debug` e inspeção do
`app.log`; (2) se ainda falhar em silêncio, `patch-package`/fork com
`version: (await fetchLatestBaileysVersion()).version` e um `case 'companion_reg_refresh'` — diff
mínimo proposto em T4 do DIAG; (3) se nenhum resolver, tratar como risco do canal (R-059). Antes de
trocar de fork, comparar a API (`makeWASocket`, `useMultiFileAuthState`, `Browsers`,
`fetchNewChatMessageCap`, `fetchAccountReachoutTimelock`) e revalidar WHS-04/LEAD-03 (ADR-001).

---

## Como este arquivo é usado

- **Antes de dar um plano por concluído:** ler este arquivo e conferir se alguma pendência mudou
  de estado.
- **Ao tentar parear o canal (Task 3 do plano 01-03):** esperar a falha silenciosa descrita em
  P-004; rodar com `BAILEYS_LOG_LEVEL=debug` para capturar a causa.
- **Ao ver `aumid_registration_skipped` no log:** não é regressão. Ver P-002.
- **Ao rodar `pg-hba-apply.ps1`:** esperar o Scope 2 abortar. Ver P-003.
- **Ao fechar uma pendência:** mudar o status para ✅, datar, e registrar a decisão tomada.

---

*Criado em 2026-10-05 (Task 4 do plano 01-02). P-001, P-002, P-003 e P-004.*