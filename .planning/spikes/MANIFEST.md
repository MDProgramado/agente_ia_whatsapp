# Spike Manifest

## Idea
Destravar P-007 sem abandonar o pin `@whiskeysockets/baileys@7.0.0-rc14`. A hipótese da revisão WA Web foi refutada pelos Testes A/B; a nova hipótese é backportar o patch oficial do PR #2872, que corrige três defeitos de `requestPairingCode()` ainda presentes no rc14.

## Requirements

- Manter `@whiskeysockets/baileys@7.0.0-rc14` instalado com `--save-exact`.
- Preservar `fetchNewChatMessageCap`, `fetchAccountReachoutTimelock`, o tratamento do erro `463` e o hook público `CB:failure`.
- Patch deve ser auditável, versionado e reaplicável via `patch-package`.
- Não trocar para Evolution API nem para fork sem ADR explícito.
- Nenhum pareamento com o número dedicado `+5511900000001`; usar somente `+5511900000002` em ambiente isolado.

## Spikes

| # | Name | Type | Validates | Verdict | Tags |
|---|------|------|-----------|---------|------|
| 001 | pr2872-backport | standard | Given rc14 com os 3 bugs do PR #2872, when o patch oficial é aplicado via patch-package, then build/typecheck passam e as APIs críticas continuam presentes | PARTIAL | baileys, pairing, patch-package, p007 |
