---
slug: whatsapp-conexao
status: investigacao_concluida
trigger: stream_error_515_apos_pair_success
goal: find_root_cause_only
tdd_mode: false
specialist_dispatch_enabled: false
created: 2026-11-20T21:55:00-03:00
updated: 2026-11-20T21:55:00-03:00
---

## SITUACAO ATUAL

- Primeira tentativa: navegador Mac OS no Windows → erro 515/401 (CORRIGIDO via BAILEYS_BROWSER_MODE=custom)
- Segunda tentativa: navegador Windows Chrome OK, pareamento chega em "pair success recv" + "pairing configured successfully", mas então **stream error 515** → conexão cai
- O processo foi encerrado (SIGINT) no final do log
- O auth folder foi limpo antes da segunda tentativa

## EVIDENCIAS COLETADAS

### 1. Processo
- Múltiplos processos node estavam listados via tasklist (IDs: 948, 3756, 5544, 10348, 12328, 13548, 15612, 16628, 16672, 18832, 21128, 24396)
- **NO FINAL DO LOG (linha 3267-3269): processo ENCERRADO via SIGINT** — não há processo rodando atualmente

### 2. .env (C:\Users\11\...\automacao_whatsapp\.env)
- `BAILEYS_BROWSER_MODE=custom` — **CORRETO, presente na linha 11**
- `WHATSAPP_PHONE=+557189211292`
- `CHANNEL_PHONE_E164=+557189211292`
- `DATA_ROOT=C:\whatsapp_prospecao`
- `DAILY_MESSAGE_LIMIT=25`
- `WINDOW_START_HOUR=7`, `WINDOW_END_HOUR=17`
- `TZ=America/Sao_Paulo`
- `PANEL_PORT=8787`

### 3. Auth folder (C:\whatsapp_prospecao\auth\auth_info_baileys\)
- `creds.json` presente, 1729 bytes, última gravação: 20/11/2026 21:51:54
- `"registered": false` — pareamento nunca concluído com sucesso
- `"platform": "android"`
- `"me":{"id":"557189211292:19@s.whatsapp.net","lid":"165029924102261:19@lid"}`

### 4. app.log — total de 3269 linhas
### 5. notifications.log — notificações de toast/sound, sem erros específicos de conexão 515

## CRONOGRAMA COMPLETO DAS TENTATIVAS DE CONEXÃO

| # | Linha | Timestamp (epoc ms) | Browser | Resultado | Erro |
|---|-------|---------------------|---------|-----------|------|
| 1 | 88-94 | 1791566594554 | ["Mac OS","Chrome","14.4.1"] | Falha | Connection Terminated |
| 2 | 1075-1085 | 1792075287327 | ["Mac OS","Chrome","14.4.1"] | Falha | Connection Failure (noise-handler decode) |
| 3 | 1094-1104 | 1792076647079 | ["Mac OS","Chrome","14.4.1"] | Falha | Connection Failure |
| 4 | 1113-1121 | 1792077480783 | ["Mac OS","Chrome","14.4.1"] | Falha | Connection Terminated |
| 5 | 1274-1282 | 1792082825502 | ["Mac OS","Chrome","14.4.1"] | Falha | Connection Terminated |
| 6 | 1328-1339 | 1792083973562 | ["Mac OS","Chrome","14.4.1"] | Falha | CB:failure reason="401" location="vll" |
| 7 | 1348-1359 | 1792084062326 | ["Mac OS","Chrome","14.4.1"] | Falha | CB:failure reason="401" location="cln" |
| 8 | 3022-3032 | 1795099258774 | ["Mac OS","Chrome","14.4.1"] | Falha | Connection Terminated |
| 9 | 3055-3066 | 1795100433991 | ["Mac OS","Chrome","14.4.1"] | Falha | CB:failure reason="401" location="vll" |
| 10 | 3087-3095 | 1795104931846 | ["Mac OS","Chrome","14.4.1"] | Falha | CB:failure reason="401" location="atn" → logged_out terminal |
| 11 | 3110-3119 | 1795105217518 | ["Mac OS","Chrome","14.4.1"] | **pair success** | **stream error 515** |
| 12 | 3143-3152 | 1795105578700 | ["Mac OS","Chrome","14.4.1"] | **pair success** | **stream error 515** |
| 13 | 3172-3178 | 1795105712097 | ["Mac OS","Chrome","14.4.1"] | Falha | CB:failure reason="401" location="cco" |
| 14 | 3198-3205 | 1795106427179 | ["Mac OS","Chrome","14.4.1"] | **pair success** | **stream error 515** |
| 15 | 3232-3235 | 1795221949375 | ["Windows","Chrome","10.0.22631"] | Ping apenas | Sem pareamento |
| 16 | 3251-3258 | 1795222307571 | ["Windows","Chrome","10.0.22631"] | **pair success** | **stream error 515** |

## PADRÃO IDENTIFICADO

1. **Erro 515 SEMPRE ocorre APÓS "pair success recv" + "pairing configured successfully"** — tentativas 11, 12, 14 e 16 confirmam este padrão 100%.

2. **Tentativas com "Mac OS" browser (1-14):** falham antes do pareamento (Connection Terminated / Connection Failure / 401) OU atingem o pareamento e caem no 515 (11, 12, 14).

3. **Tentativas com "Windows Chrome" (15-16):** tentativa 15 só recebeu pings (sem pareamento); tentativa 16 atingiu "pair success recv" + "pairing configured successfully" e caiu no **stream error 515** — exatamente como descrito pelo usuário.

4. **O `BAILEYS_BROWSER_MODE=custom` está configurado no .env**, mas tentativas 1-14 ainda usaram browser "Mac OS". O Windows Chrome só apareceu nas tentativas 15-16, sugerindo que a mudança de browser pode ter sido feita por outra via (variável de ambiente diferente, código, ou o custom mode não sobrescreve completamente o user agent padrão).

5. **`creds.json` mostra `"registered": false`** — nenhum pareamento foi finalizado com sucesso. O `me.id` no creds.json (`557189211292:19@s.whatsapp.net`) coincide com a tentativa 16 (Windows Chrome), mas o registro nunca foi confirmado pelo WhatsApp devido ao 515.

6. **Intervalo entre tentativas com pareamento bem-sucedido + 515:** tentativa 11 → 12 (aprox. 32 min), 12 → 14 (aprox. 74 min), 14 → 16 (aprox. 26h). Não há intervalo fixo; o 515 ocorre imediatamente após o pareamento (diferença de ~1 segundo entre "pairing configured successfully" e "stream error 515").

## DESCOBERTA CRÍTICA

O usuário relatou que a "segunda tentativa" usou Windows Chrome. No log, **todas as tentativas 1-14 usam "Mac OS"**, e apenas as tentativas 15-16 usam "Windows Chrome". O Windows Chrome foi alcançado apenas na parte final do log (após a linha 3232), indicando que a configuração do browser foi alterada entre as tentativas, mas o erro 515 persistiu mesmo com Windows Chrome (tentativa 16).

## RECOMENDAÇÃO DE PRÓXIMOS PASSOS

1. **Não tentar pareamento novamente com creds.json atual** — o arquivo está em estado `"registered": false` com dados de pareamento incompleto. Limpar `auth_info_baileys/` completamente antes da próxima tentativa.

2. **Investigar o erro 515 (stream error)** — este é um erro do protocolo WhatsApp Web que indica rejeição do stream após autenticação. Causas possíveis:
   - User Agent incompatível (mesmo com Windows Chrome, o `platform` no creds.json é "android")
   - `deviceProps` no paresamento não corresponde ao browser declarado
   - Requisito de `fetchNewChatMessageCap()` / `fetchAccountReachoutTimelock()` / tratamento 463 (Baileys 6.7.x não tem; o projeto usa 7.0.0-rc14 que tem)
   - LID migração não tratada corretamente (`lidDbMigrated:false` em várias tentativas)

3. **Verificar se `BAILEYS_BROWSER_MODE=custom` está sendo efetivamente aplicado** — o código pode estar ignorando esta variável ou usando um valor padrão diferente.

4. **Considerar esperar entre tentativas** — WhatsApp pode estar rate-limiting o número após múltiplos falhas de pareamento.

## CHECKLIST DE VERIFICAÇÃO

- [x] Processo ainda rodando? → NÃO (encerrado via SIGINT na linha 3267)
- [x] app.log lido completo? → SIM (3269 linhas)
- [x] notifications.log lido? → SIM (sem erros 515 específicos)
- [x] auth folder verificado? → SIM (creds.json presente, registered=false)
- [x] .env verificado? → SIM (BAILEYS_BROWSER_MODE=custom presente)
- [x] Cada tentativa documentada com timestamp? → SIM (16 tentativas)
- [x] Padrão do erro 515 identificado? → SIM (sempre após pair success)
- [ ] Próxima tentativa com auth limpo? → PENDENTE
- [ ] Testar com diferentes user agents? → PENDENTE

## ARQUIVO DE DEBUG
`.planning/debug/whatsapp-conexao.md`