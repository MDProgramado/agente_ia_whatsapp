# Phase 2: IA, Handoff e Shadow Mode - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-10-13
**Phase:** 2-IA, Handoff e Shadow Mode
**Areas discussed:** Superfície do Admin, Armazenamento do rascunho, Autoridade da FSM / forma da LLM, Handoff/silêncio/opt-out, Mascaramento de PII + saída do shadow

> **Modo `--auto`:** todas as áreas foram auto-selecionadas e a opção recomendada foi escolhida sem `question`, em passada única. Cada log abaixo marca `[auto]`.

---

## Superfície do Admin na Fase 2

| Option | Description | Selected |
|--------|-------------|----------|
| CLI-first | `npm run shadow:*` + `npm run mode`; sem HTTP/painel | ✓ |
| Endpoint HTTP mínimo | API local só para revisão/kill switch | |
| Painel React | UI completa agora (R-046) | |

**Escolha:** CLI-first.
**Notas:** `[auto]` Coerente com a Fase 1 (CLI, sem painel até Fase 3) e com o volume (~20 leads/dia). Kill switch = 1 comando → `kill_switch_ativo`, auditado em `mode_changes`. Decisões de revisão são eventos append-only.

---

## Armazenamento do rascunho do copiloto

| Option | Description | Selected |
|--------|-------------|----------|
| Reusar `messages` (`status='suggested'`) + `llm_runs` | Texto no audit trail único; metadados em tabela companheira | ✓ |
| Tabela `suggestions` do ADR-010 (corpo próprio) | Fonte separada para o corpo do texto | |

**Escolha:** Reusar `messages` + tabela companheira `llm_runs`.
**Notas:** `[auto]` "Message bodies live ONLY in `messages`" (Fase 1); R-043 histórico imutável. `suggestions` do ADR-010 fica superseded para o corpo; `llm_runs` guarda modelo/tokens/latência/custo/versão de prompt+política. Decisão de revisão = evento, não UPDATE.

---

## Autoridade da FSM e forma de invocação da LLM

| Option | Description | Selected |
|--------|-------------|----------|
| Sanduíche 3 camadas / dois tiers | LLM extrai → código decide → LLM responde; hint só | ✓ |
| Envelope único | Uma chamada gera sinais + texto; código decide depois | |

**Escolha:** Sanduíche de 3 camadas em duas chamadas (barato p/ intent, forte p/ reply).
**Notas:** `[auto]` ROADMAP 02-01 + STACK §LLM Integration. Envelope único (ARCHITECTURE Padrão 1) preterido: gera texto antes da decisão do código → mais fraco para invariantes AR. `resolveNextState(prev, hint, ctx)` em código é a autoridade; hint não contorna o mapa. Campos-canário no Zod. `pedido_preco`→handoff (AR-001) separado de `objecao_preco`→contorno (R-042). Falha-fechada: 1 reprompt → silêncio + notificação. Provider/modelo = resultado do bake-off.

---

## Handoff, silêncio e opt-out

| Option | Description | Selected |
|--------|-------------|----------|
| Código autoritativo + silêncio total + notificação local | Matcher determinístico decide; bot cala; Admin é notificado | ✓ |
| LLM decide handoff | Deixar o modelo acionar o handoff | |
| Responder handoff com mensagem de transição | Avisar o lead que um humano assume | |

**Escolha:** Código autoritativo + silêncio total com notificação local; ambíguo → handoff.
**Notas:** `[auto]` `HandoffService` grava `handoff_events` + `mode_changes` + `engagement_mode='awaiting_human'` + flag em uma transação (quita P-006). Gatilhos por `handoff-humano` (R-012/R-056/R-065/R-038/FLUP-09). Pergunta "é bot?" → silêncio total (não nega/admite/desvia), notificação continua. Opt-out: matcher pt-BR é autoridade, recusa explícita e implícita definida → `opt_out` + `optout_ledger` irreversível; ambíguo → handoff. Confirmação = `human_acknowledged_at`; bot só volta por ação explícita.

---

## Mascaramento de PII + relatório/saída do shadow

| Option | Description | Selected |
|--------|-------------|----------|
| Mascarar telefone+endereço, manter nome; relatório do banco + aprovação explícita | Escopo mínimo de PII; gate de saída com revisão humana | ✓ |
| Mascarar tudo (incl. nome) | Máxima privacidade ao custo de tom | |
| Sem mascaramento | Enviar dados crus ao provider | |

**Escolha:** Mascarar telefone + endereço, manter nome; relatório gerado do banco; saída do shadow exige aprovação explícita do Admin.
**Notas:** `[auto]` ADR-002/012; nome é dado de negócio B2B público (legítimo interesse). Mascaramento em choke-point único do prompt-builder. `npm run shadow:report` (Markdown/HTML) com contagem de alucinações/revelações de automação/latência/custo. O programa não se auto-promove a ativo.

---

## the agent's Discretion

- Valores numéricos dos critérios de saída do shadow (N de dias, taxa mínima de aprovação, teto de revelações) e do orçamento de qualificação — definir no plano, seguindo ADR-010.
- Lista de keywords pt-BR (opt-out/irritação) e o conjunto adversarial de ~200 mensagens — implementação, desde que o matcher determinístico seja a autoridade.
- Nomes exatos de tabelas/colunas (`llm_runs`, campos-canário) — desde que append-only + FK para `messages`.

## Deferred Ideas

- **Chime Web Audio** de redundância da notificação → Fase 3 (não há painel/Web Audio até lá). Conflito de ROADMAP 02-02 marcado como resolvido.
- **Painel HTTP/React** de revisão → Fase 3 (R-046).
- **Cadência completa + dreno jittered** (ADR-009) → Fase 3.
- **Migração para API oficial** do WhatsApp → fase futura.
- **Escolha definitiva de provider/modelo de LLM** → resultado do bake-off.

---

## Regather `--auto` (2026-10-14) — formalização de discretion

> Segunda passada em modo `--auto`, passada única. **Nenhuma decisão D-01..D-18 foi re-litigada.** As 5 áreas originais foram re-selecionadas automaticamente e mantidas. O valor desta passada foi fechar os itens que estavam em "the agent's Discretion", agora resolvidos por `02-RESEARCH.md` §Open Questions (RESOLVED) e `02-PATTERNS.md`.

| Item (era discretion) | Resolução | Vira |
|-----------------------|-----------|------|
| Chave e forma do kill switch `paused` | Global em `settings.operational_mode='paused'`, wireado ao snapshot/`kill-switch.ts`; auditado em `mode_changes` | **D-19** |
| Forma dos eventos de revisão do shadow | Tabela `review_events` (append-only, migração 0006); separa geração de revisão | **D-20** |
| Critérios numéricos de saída do shadow | Defaults ADR-010: ≥14 dias, ≥100 rascunhos, ≥80% aprovação, 0 alucinação crítica, 0 revelação de automação | **D-21** |
| Corpus/rubrica do bake-off | `scripts/bake-off.ts` + corpus adversarial pt-BR (~200); 2 eixos (AR/tom + custo/latência) | **D-22** |
| Fonte única de shadow / supersessions | `conversations.engagement_mode`; `suggestions` e `settings.shadowMode` do ADR-010 superseded; Pitfalls 2 e 4 corrigidos na 0006/prompt-builder | **D-23** |

**Discretion remanescente (sem impacto de contrato):** keywords pt-BR de opt-out/irritação (matcher determinístico continua autoridade); conteúdo literal dos prompts e do corpus, respeitando ADR-012 e AR-como-código.

**Deferred Ideas:** inalteradas (chime Web Audio → Fase 3; painel → Fase 3; cadência/dreno → Fase 3; API oficial → futura; provider/modelo → bake-off).
