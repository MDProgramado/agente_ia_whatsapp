# Itens diferidos — Fase 01

Itens **pré-existentes** encontrados durante a execução do 01-04 mas fora do
escopo desta task (limite de escopo de desvios: não corrigir o que não foi
causado pelas mudanças da task). Registrados aqui para a Fase 04 / verificação.

## 1. Comentário enganoso em `src/domain/gate/guards/ar-009.ts` ✅ RESOLVIDO

**Resolvido em 2026-10-13** (chore da pós-verificação da Fase 1): o comentário
foi corrigido para dizer que AR-010 precede AR-009 (posições 4 e 5 em
`guard-order.ts`). A decisão de design ficou com a precedência **executada**:
`ar010_handoff_ativo` é o motivo gravado quando os dois estão ligados.

O comentário de `ar-009.ts` afirma que "`ar-009` vem **antes** na ordem, então
`pendingMediaBlock` tem a precedência quando os dois [AR-009 e AR-010] estão
ligados". Isso está **incorreto**: em `GUARD_ORDER`/`GUARD_SLOTS`, `ar-010` está
no índice 5 e `ar-009` no índice 6 — ou seja, AR-010 precede AR-009.

Consequência: com `handoffActive = true` **e** `pendingMediaBlock = true` juntos,
o motivo gravado é `ar010_handoff_ativo`, não `ar009_midia_recebida`.

- **Causa:** comentário adicionado no 01-01; não foi introduzido pelo 01-04.
- **Impacto:** apenas de documentação — a ordem executada é a correta e está
  fixada por `tests/gate/order.test.ts`. Nenhuma task `asserta` o caso combinado
  justamente para não fixar um comportamento descrito errado no comentário.
- **Ação sugerida (fora do escopo do 01-04):** corrigir o comentário de
  `ar-009.ts` para dizer que AR-010 precede, ou mover o slot se a precedência
  desejada for a outra. Decisão de design, não bug de implementação.
