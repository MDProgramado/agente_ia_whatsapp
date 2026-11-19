---
phase: 04-piloto-calibra-o-e-apura-o
plan: 02
subsystem: ops
tags: [kpis, apuracao, piloto, metricas, compliance, seguranca]

# Dependency graph
requires:
  - phase: 04-piloto-calibra-o-e-apura-o/04-01
    provides: "Estrutura do piloto real e calibração de cadência"
provides:
  - "`src/ops/pilot-metrics.ts` — motor de cálculo dos critérios de sucesso (5 reuniões, 30% qualificação) e auditoria de segurança (blocked_attempts)"
  - "`src/cli/report-pilot.ts` (`npm run pilot:report`) — CLI executável com relatório formatado do piloto"
  - "`tests/ops/pilot-metrics.test.ts` — testes automatizados do cálculo de KPIs"
affects: [PILO-02, PILO-03, R-061, R-062]
---

# Sumário do Plano 04-02: Apuração Mensal de KPIs e Conformidade

O plano **04-02** entregou a instrumentação final de apuração de métricas do piloto de prospecção:

1. **Motor de Cálculo de KPIs (`src/ops/pilot-metrics.ts`):**
   - Apura o funil completo nos últimos 30 dias: leads totais, contatados (1º contato), qualificados e reuniões agendadas.
   - Avalia as duas metas obrigatórias de sucesso (R-061):
     - Meta 1: >= 5 reuniões agendadas no mês (`metaReunioesAtingida`).
     - Meta 2: >= 30% de taxa de qualificação sobre leads contatados (`metaQualificacaoAtingida`).
   - Apura auditoria de segurança: contagem de handoffs humanos, solicitações de opt-out registradas e tentativas bloqueadas pelo gate (`blocked_attempts`).

2. **CLI de Apuração (`src/cli/report-pilot.ts` / `npm run pilot:report`):**
   - Comando direto no terminal que exibe o resumo completo formatado do piloto, status de aprovação de cada meta e auditoria de conformidade.

3. **Garantia de Qualidade:**
   - Teste unitário aprovado em `tests/ops/pilot-metrics.test.ts`.
   - `npm run typecheck` (Node + Web): 0 erros.
   - Biome linter/formatter: 0 erros / 0 warnings.

