# Quick Task 261127-001 — SUMMARY

**Branch:** `fix/auditoria-27-11b` (base `origin/main` = `3380f3b`)
**Data:** 2026-11-27
**Status:** concluída. Os 6 itens foram fechados com TDD (vermelho → verde).

## Commits

| Item | Commit | Resumo |
|---|---|---|
| plano | `3f4e473` | PLAN.md com as decisões travadas |
| 1 | `b189a2d` | `aoAbrir` só no `connection: open` real |
| 2 | `87d7877` | biome `lf` + `.gitattributes` (CRLF só para cmd/bat/ps1); commit de format = no-op (índice já em LF) |
| 3 | `c0e1513` | mapa PII fora do Git (`.planning/local/`, gitignored) |
| 4 | `0240bb4` | backup: sessão em `backups\auth\<ts>`, piso de 3 dumps, rotação depois do verify |
| 5 | `e3e6e00` | gate de saída: preço/agenda coloquiais (guard + pós-gate) |
| 6 | `f39e4e2` | matcher de entrada: valor/proposta/orçamento/cobra/tabela/ligar/semana que vem |

## Testes novos

- `tests/channel/lifecycle.test.ts`: WS aberto sem `open` não chama `aoAbrir`; `open` na recuperação chama 1×; pareamento segue visível até o `open` real.
- `tests/ops/backup-rotation.test.ts`: piso de 3 com dumps >30d; 2 dumps antigos não apagam; 1 recente + 3 antigas apaga só a mais antiga; auth mantém 3 por contagem.
- `tests/ops/backup-ps1.test.ts`: rotação depois do dump/verify; sessão em `backups\auth`.
- `tests/gate/ar-001.test.ts`: 7 frases de preço bloqueiam; 11 frases sem preço passam.
- `tests/gate/ar-003.test.ts`: 3 frases de agenda bloqueiam; "Respondemos em até 2h." bloqueia (decisão).
- `tests/gate/post-gate-parity.test.ts`: +19 textos na paridade guard × pós-gate.
- `tests/domain/post-gate.test.ts`: +11 proibidos (inclui "Sem custo para você"), +4 liberados.
- `tests/adversarial/{corpus,adversarial.test}.ts`: +10 amostras em `pressaoPreco`, todas com bloqueio esperado.
- `tests/application/handoff-intents.test.ts`: unitário de `detectarGatilhoHandoff` (9 disparam, 4 não); E2E das 9 com LLM neutra e com LLM falhando; E2E das 4 neutras (0 handoff, LLM consultada).
- `tests/application/qualification.test.ts`: objeção sem "orçamento" segue gerando contorno; objeção com "me passa um orçamento" vira handoff.

## Verificação (Postgres local no ar)

```
npm run typecheck   → exit 0
npm run lint        → exit 0 (230 arquivos, 0 erros)
npm test            → exit 0 (85 arquivos, 598 testes)
npm run lint:verify → exit 0 (cadeias fail-closed)
npm run build       → exit 0
```

## Desvios e lacunas

- `obra` no regex do PLAN.md era erro de digitação; não entrou no código.
- **Lacuna (fora do escopo):** `scanPostGate` não consulta `CONDICAO_COMERCIAL_TERM`, então "o número de parcelas pode mudar" bloqueia no guard AR-002 e passa no pós-gate. O envio continua barrado pelo gate canônico. Ficou fora da lista de paridade e está anotado em `docs/pendencias.md`.
- Nada de `auth/`, `.env`, códigos de pareamento ou reescrita de histórico.
