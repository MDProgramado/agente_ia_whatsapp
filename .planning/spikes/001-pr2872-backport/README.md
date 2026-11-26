---
spike: 001
name: pr2872-backport
type: standard
validates: "Given @whiskeysockets/baileys@7.0.0-rc14 still has the three pairing bugs fixed by upstream PR #2872, when the official patch is backported via patch-package, then typecheck/tests pass and the WHS-04/LEAD-03 APIs remain intact"
verdict: PARTIAL
related: []
tags: [baileys, pairing, patch-package, p007]
---

# Spike 001: PR #2872 backport no rc14

## What This Validates
Given o pin imutável do rc14 e o `401` imediato em `pairing_code`, quando o patch oficial do PR #2872 é backportado, então o pacote compila, as APIs críticas continuam expostas e o pareamento pode ser retestado sem trocar de dependência.

## Research

| Approach | Tool/Library | Pros | Cons | Status |
|---|---|---|---|---|
| Backport do patch oficial | `patch-package` + `@whiskeysockets/baileys@7.0.0-rc14` | Mantém pin, ADR-001 e APIs; diff auditável; `git apply --check` e `npm run build` passaram em temp dir | Não prova o pareamento até teste com número descartável | **Chosen** |
| Troca para fork | `@chaeulso/baileys@7.5.0` | Agrupa fixes próprios de 408/515/QR; dual ESM/CJS | Publicado em 2026-08-30; não contém os fixes do PR #2872 (2026-10-22); versão `[2,3000,1046341789]`; 1 star; exige novo ADR | Rejected |
| Subir revisão WA Web | `BAILEYS_VERSION_SOURCE=wa-web` | Teste simples | Refutado: A falhou em `rva`, B falhou em `odn` com `[2,3000,1056052669]` | Invalidated |

Bugs confirmados no rc14 instalado:

- `lib/Socket/messages-recv.js:881`: `case 'link_code_companion_reg'` sem `stage === 'primary_hello'`.
- `lib/Socket/socket.js:320`: `if (!creds.me)` escolhe login mesmo com `creds.me` provisório do `requestPairingCode()`.
- `lib/Socket/socket.js:645`: `link_code_pairing_nonce` com `content: '0'` em vez de `Buffer.alloc(1)`.
- `lib/Utils/validate-connection.js:194`: `configureSuccessfulPairing` não marca `registered: true`.

Fonte: `https://github.com/WhiskeySockets/Baileys/pull/2872.patch`. O patch foi baixado em temp dir, aplicado com `git apply --check` no tag `v7.0.0-rc14` e compilado com `npm run build` sem erro.

## How to Run

```powershell
npx patch-package
npm run typecheck
npm test
npm run lint
```

## What to Expect

- `patches/@whiskeysockets+baileys+7.0.0-rc14.patch` presente e reaplicável.
- `postinstall: patch-package` no `package.json`.
- `fetchNewChatMessageCap` e `fetchAccountReachoutTimelock` ainda presentes nos tipos do socket.
- Nenhum código de pareamento, credencial ou auth folder versionado.

## Investigation Trail

1. P-007 A/B refutou a hipótese da revisão WA Web.
2. Issue `https://github.com/WhiskeySockets/Baileys/issues/2832` mostrou `401` no mesmo cenário e sucesso do client oficial via QR.
3. PR #2872 explicou três bugs que quebram `requestPairingCode()`; os três foram confirmados no rc14 instalado.
4. Fork `@chaeulso/baileys@7.5.0` foi baixado em temp dir: exports compatíveis, mas sem os fixes #2872.
5. Patch oficial aplicou limpo no tag rc14 e o build passou.

## Results

Verdict **PARTIAL**: patch oficial aplicado no repo via `patch-package@8.0.1`, `postinstall` configurado, patch limitado às quatro mudanças do PR #2872 e ciclo reverse→reapply verificado. Build do rc14 patched passou em temp dir e as APIs críticas continuam presentes. `npm run typecheck` ✓, suíte completa `438/438` ✓, guard de auth `6/6` ✓ e `biome check` nos arquivos tocados ✓. Falta o pareamento real controlado com `+5571982166238` para virar `VALIDATED`.
