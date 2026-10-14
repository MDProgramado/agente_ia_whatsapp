---
status: partial
phase: 02-ia-handoff-e-shadow-mode
source: [02-VERIFICATION.md]
started: 2026-10-14T15:54:17Z
updated: 2026-10-14T15:54:17Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Pareamento real (P-004) — forma do emissor para o Guard 0 (CR-01)
expected: No pareamento real do número dedicado, `normalizeJid(sock.user.id).e164` retorna não-nulo (forma E.164 `@s.whatsapp.net`). Com o bot em `shadow`, a 1ª mensagem manual do Admin ao lead seta `leads.first_contact_by_human = true` e a conversa sai de `novo` para `aquecimento`. Se o id próprio vier em forma LID (`@lid`), o boot emite exatamente uma vez `jid_proprio_sem_e164` e o Guard 0 permanece fail-closed (nenhuma transição) — o pareamento precisa ser resolvido antes do shadow ser significativo.
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
