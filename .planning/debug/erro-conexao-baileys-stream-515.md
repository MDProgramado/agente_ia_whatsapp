---
status: resolved
trigger: "Investigue o erro de conexão do WhatsApp Baileys no projeto. Erro: stream error code 515 após pareamento bem-sucedido via QR Code. Contexto: BAILEYS_BROWSER_MODE=custom (anuncia Windows Chrome), pasta auth_info_baileys limpa. Logs mostram: 'connected to WA' com browser Windows/Chrome/10.0.22631, 'not logged in, attempting registration...', 'pair success recv', 'pairing configured successfully, expect to restart the connection...', então stream error code 515 → connection errored → socket close."
created: 2026-11-20T21:59:00-03:00
updated: 2026-11-20T22:45:00-03:00
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: Stream error 515 (restartRequired) após pairing success é comportamento ESPERADO do servidor WA (diz "expect to restart the connection"). O problema é que o app não reconecta/reenvia handshake após esse restart, deixando o socket em "close" sem recuperação. A flag restoreRequired permanece true e não há lógica de re-abertura do socket pós-pareamento.
test: Buscar por "515", "restartRequired", "restart" em todo o projeto e no node_modules do baileys. Ler capabilities.ts e adapter.ts. Verificar fluxo completo de reconexão em index.ts após pairing.
expecting: Confirmar se 515 é server-side (WA pede restart) e se há gap no client (não reconecta após restart pós-pareamento).
next_action: Buscar código 515 / restartRequired em todo o projeto e node_modules

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Pareamento via QR Code deve completar e manter conexão ativa com WhatsApp
actual: Após 'pairing configured successfully', ocorre stream error 515, connection errored, socket close
errors: "stream error code 515", "Error: Stream Errored (restart required)"
reproduction: Iniciar app, escanear QR Code, pareamento começa, recebe pair success, depois erro 515
started: Após duas correções (BAILEYS_BROWSER_MODE=custom e limpeza auth_info_baileys)

## Eliminated
<!-- APPEND only - prevents re-investigating -->

## Evidence
<!-- APPEND only - after each finding -->

- timestamp: 2026-11-20T22:05:00-03:00
  checked: src/channel/baileys/signals.ts (linhas 65, 123-131)
  found: 515 = DisconnectReason.restartRequired, mapeado como connection_closed, terminal: false, retry: true. O 515 é tratado como não-terminal e retryável.
  implication: O 515 não desliga o processo (não é terminal), mas também não dispara reconexão automática.

- timestamp: 2026-11-20T22:08:00-03:00
  checked: node_modules/@whiskeysockets/baileys/lib/Socket/socket.js (linhas 729-744, 791-796, 472-508)
  found: Após pair-success, Baileys emite 'isNewLogin: true', envia reply + sendUnifiedSession. O servidor então envia stream:error com code 515. O handler CB:stream:error chama end() que destrói o socket, remove todos os listeners e emite connection.update com connection: 'close'. NÃO há auto-reconexão no Baileys após end().
  implication: O 515 é comportamento ESPERADO do servidor WA (comentário no socket.js linha 728: "if device pairs successfully, the server asks to restart the connection"). O Baileys fecha corretamente, mas o app não recria o socket.

- timestamp: 2026-11-20T22:12:00-03:00
  checked: src/index.ts (linhas 435-465, 270-272, 406-487)
  found: aoDesconectar só age quando estadoDoSocket.terminal é true. Para 515 (terminal: false), apenas loga e define canalEstado = "close". NÃO há lógica de recriar o socket. A variável canalSock (linha 93) é setada uma vez (linha 272) e nunca atualizada. O canal (BaileysChannel, linha 602-608) guarda referência ao sock antigo e nunca é atualizado.
  implication: Após o 515, o socket fica permanentemente fechado. O app nunca se reconecta. É um GAP no client, não erro do servidor.

- timestamp: 2026-11-20T22:15:00-03:00
  checked: node_modules/@whiskeysockets/baileys/lib/Socket/socket.js (linhas 596-653, 729-744)
  found: requestPairingCode grava creds.me.id (o JID do número) e pairingCode. Após pair-success, configureSuccessfulPairing atualiza creds com me.id (dispositivo registrado). creds.update é emitido e salvo via sessao.saveCreds(). Após isso, o dispositivo está registrado no disco.
  implication: Se recriarmos o socket após o 515, ele carregará creds com me.id setado → fará login (não registro) → conexão deve abrir normalmente.

- timestamp: 2026-11-20T22:18:00-03:00
  checked: src/channel/baileys/runtime.ts (linhas 210-232)
  found: onBaileysConnectionUpdate só trata qr, connection==='open', connection==='close'. NÃO trata isNewLogin. O sinal isNewLogin emitido pelo Baileys após pair-success é ignorado pelo app.
  implication: O app não sabe que o pareamento completou e que um restart é esperado.

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: O stream error 515 (restartRequired) é comportamento ESPERADO do servidor WhatsApp após pareamento bem-sucedido via Baileys. O servidor avisa o client para reiniciar a conexão. O Baileys fecha corretamente o socket (end()), mas o app (src/index.ts) não recria o socket após esse fechamento não-terminal. O canal fica permanentemente em "close" sem tentativa de reconexão. É um GAP do lado do cliente (app), não do servidor (WhatsApp).
fix: Em src/index.ts, aoDesconectar deve detectar status 515 durante restoreRequired e recriar o socket (abrirSocketDoCanal), re-registrar handlers, atualizar canalSock e canal (BaileysChannel precisa de setter para sock). Também em src/channel/baileys/signals.ts, exportar helper para identificar 515.
files_changed: []
