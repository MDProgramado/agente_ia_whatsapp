---
phase: 04-piloto-calibra-o-e-apura-o
plan: 01
subsystem: ops
tags: [piloto, calibracao, cadencia, admin, manual, dossie, anti-ban]

# Dependency graph
requires:
  - phase: 03-cad-ncia-opera-o-e-painel/03-02
    provides: "Motor de follow-up, scheduler e timestamps de cadência"
provides:
  - "`src/ops/calibration.ts` — cálculo analítico de tempo mediano até resposta e taxa por toque da cadência"
  - "`src/cli/calibrate.ts` (`npm run pilot:calibrate`) — CLI para relatório de calibração"
  - "`docs/operacao/manual-do-admin.md` — manual diário de procedimentos do Admin (OPRE-02/03, R-001)"
  - "`docs/operacao/dossie-reversao-ban.md` — dossier pronto de apelação e defesa jurídica LGPD/Meta"
  - "`tests/ops/calibration.test.ts` — cobertura de testes da rotina de calibração"
affects: [PILO-01, PILO-03, OPRE-02, OPRE-03]
---

# Sumário do Plano 04-01: Instrumentação do Piloto Real e Calibração

O plano **04-01** estabeleceu os pilares operacionais do piloto real de 30 dias:

1. **Rotina e CLI de Calibração (`src/ops/calibration.ts` e `npm run pilot:calibrate`):**
   - Agrega métricas estatísticas reais do banco local para avaliar a cadência de 4 toques (1h, 1d, 3d, 7d).
   - Extrai o tempo mediano (em minutos/horas) até a 1ª resposta inbound do lead.
   - Apresenta taxa percentual de conversão e resposta por estágio da cadência.

2. **Manual Operacional do Admin (`docs/operacao/manual-do-admin.md`):**
   - Detalhamento da rotina diária matinal, diurna e encerramento.
   - Reforço do envio manual obrigatório do 1º contato (R-001) para preservar o canal.
   - Protocolo de atendimento de handoffs visuais e sonoros no painel.

3. **Dossier de Salvaguarda Anti-Banimento (`docs/operacao/dossie-reversao-ban.md`):**
   - Minuta técnica e jurídica pronta para abertura de ticket de suporte na Meta Business em caso de falso positivo de spam.
   - Enquadramento na LGPD (Art. 7º IX - Legítimo Interesse B2B) e comprovação das travas duras (20 a 30 msgs/dia, opt-out automático incondicional).

