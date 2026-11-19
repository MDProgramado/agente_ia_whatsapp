# Phase 4: Piloto, Calibração e Apuração - Context

**Gathered:** 2026-11-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Comprovar em operação real (~30 dias) com o Admin como único operador no número dedicado que o sistema atinge os objetivos de negócio sem cruzar fronteiras proibidas nem queimar o chip.

A Fase 4 fecha os requisitos pendentes de:
- **OPRE-02 / OPRE-03**: Operação restrita ao Admin, sem compartilhamento da lista de leads nem atribuição externa.
- **PILO-01**: Execução ponta a ponta do escopo MVP (R-060).
- **PILO-02**: Critérios de sucesso — 5 reuniões agendadas/mês e 30% de taxa de qualificação/mês (R-061).
- **PILO-03**: Apuração mensal dos indicadores e rotina de calibração de cadência baseada em dados reais (R-062).

## Planos da Fase 4:
1. **04-01-PLAN.md: Rotina Operacional do Piloto e Calibração de Cadência**
   - Procedimento diário do Admin: importação de leads, envio da 1ª mensagem manual (R-001) e monitoramento via painel.
   - Script/ferramenta de calibração de cadência (analisa tempo mediano de resposta e taxa de resposta por toque dos follow-ups 1h/1d/3d/7d).
   - Dossier de prevenção e apelação de banimento (templates, registro de legítimo interesse, opt-out ledger).
2. **04-02-PLAN.md: Apuração Mensal de Métricas e Relatório de Conformidade**
   - Endpoint e CLI de apuração mensal dos KPIs de sucesso (5 reuniões agendadas, 30% qualificação).
   - Relatório de guardrails e conformidade LGPD (verificação de que zero fronteiras AR-001..AR-012 foram violadas).
   - Documentação de encerramento do piloto e recomendações para v2.
</domain>

<decisions>
## Implementation Decisions

- **D-01: Apuração baseada nas tabelas existentes:** Os indicadores do piloto (reuniões agendadas, qualificação, toques de follow-up, opt-outs) são computados a partir de `conversations`, `status_history`, `messages` e `scheduled_tasks`, sem introduzir infraestrutura pesada de BI (cumpre PILO-02/PILO-03 de forma local e leve).
- **D-02: Single-operator rigoroso (OPRE-02/OPRE-03):** O painel permanece configurado para usuário único (`Admin`), mantendo a governança sem dispersão de leads.
- **D-03: Calibração orientada a evidência:** A análise de cadência extrai a distribuição real de tempo até a primeira resposta para sugerir eventuais ajustes nos intervalos do scheduler.
</decisions>

