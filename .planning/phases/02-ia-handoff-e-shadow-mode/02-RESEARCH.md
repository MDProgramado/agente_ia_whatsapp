# Phase 2: IA, Handoff e Shadow Mode - Research

**Researched:** 2026-10-13
**Domain:** Integração de LLM externa sob FSM determinística, handoff persistido e shadow mode (Node/TS, PostgreSQL local, Windows)
**Confidence:** HIGH (stack e restrições), MEDIUM (design do sanduíche e do shadow — precisa validação empírica via bake-off/adversarial set)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Superfície do Admin na Fase 2 (revisão de shadow + kill switch)**
- **D-01:** A superfície de admin na Fase 2 é **CLI-first** (`npm run shadow:*` para revisar/decidir, `npm run mode` para kill switch). Nenhum servidor HTTP nem painel React nesta fase — coerente com a Fase 1 (CLI + invariante "sem painel até a Fase 3") e com o volume (~20 leads/dia).
- **D-02:** O kill switch é **ação de 1 clique/1 comando** que seta `settings.operational_mode='paused'` (ou equivalente já existente de `mode_changes`) e faz o gate devolver `kill_switch_ativo`. Deve ser reversível e auditado em `mode_changes`.
- **D-03:** A revisão de shadow é registrada como **eventos append-only** (aprovar/editar/descartar), nunca como UPDATE no texto sugerido.

**Armazenamento do rascunho do copiloto (ADR-010 + R-043 histórico imutável)**
- **D-04:** O **texto do rascunho vive em `messages`** com `origin='ai_suggestion'` e `status='suggested'`. Fonte única append-only de conteúdo (retention/LGPD, "message bodies live ONLY in `messages`"). A tabela `suggestions` do ADR-010 **não** armazena o corpo do texto; fica **superseded** pela decisão Padrão-4 da ARCHITECTURE + schema da Fase 1.
- **D-05:** Metadados de execução da LLM (modelo, prompt/completion tokens, latência, custo, versão do prompt, versão da política, decisão de revisão) vão para uma **tabela companheira nova** `llm_runs` (migração nova), ligada por FK a `messages`. Writes de `llm_runs` são append-only.
- **D-06:** A decisão de revisão (aprovado/editado/descartado + timestamp + actor) é um **evento append-only**; o `messages.status` do rascunho **não** é mutado retroativamente — o par (rascunho, decisão) é reconstruível a partir de eventos.

**Autoridade da FSM e forma de invocação da LLM (sanduíche de 3 camadas)**
- **D-07:** O estado autoritativo vive em `conversations.state` (Postgres). A LLM devolve apenas um **hint** de intenção/sinais. A transição é decidida por `resolveNextState(prev, hint, ctx)` — **mapa de transições tipado em código** (per ARCHITECTURE Padrão 1 / `core/orchestrator/transitions.ts`), nunca escolhida pelo modelo. O hint não pode contornar o mapa.
- **D-08:** A invocação é um **sanduíche de 3 camadas em duas chamadas de LLM, em tiers distintos**:
  1. **Camada 1 (modelo barato/rápido):** extrai intenção + sinais estruturados de **toda** mensagem inbound (Zod `Output.object`, inclui **campos-canário** que o modelo deve ecoar para provar aderência ao schema).
  2. **Camada 2 (código local):** `resolveNextState()` + `evaluatePolicy()` decidem de forma determinística, **antes** de qualquer texto ser gerado.
  3. **Camada 3 (modelo forte):** gera o texto da resposta **sob o estado já resolvido**, então o texto não pode propor tópico proibido. Roda menos vezes que a Camada 1.
   - Isto segue ROADMAP 02-01 + STACK §LLM Integration (dois tiers). A variante de **chamada única em envelope** (ARCHITECTURE Padrão 1) fica como alternativa registrada, mas é preterida porque gera o texto *antes* da decisão do código — mais fraco para invariantes AR.
- **D-09:** O enum de intenção separa explicitamente **`pedido_preco`** (→ handoff, AR-001: *pedir* preço/proposta/orçamento) de **`objecao_preco`** (→ contorno consultivo, R-042: *objeção* "está caro"). São gatilhos opostos e não podem colapsar no mesmo valor.
- **D-10:** **Falha-fechada** em toda a camada de LLM: falha de parse Zod, canário divergente, timeout ou erro de provider → 1 reprompt → se persistir, **silêncio + notificação local**. Nunca cair para texto livre. Escolha de provider/modelo é **resultado medido do bake-off**, não congelada aqui.

**Handoff, silêncio e opt-out**
- **D-11:** `HandoffService` escreve, **em uma transação**: `handoff_events` (evento) + `mode_changes` + `conversations.engagement_mode='awaiting_human'` + flag de handoff ativo. Isto **quita P-006** (handoff→`awaiting_human` adiado da Fase 1).
- **D-12:** Gatilhos de handoff conforme skill `handoff-humano`: R-012 (preço/proposta/orçamento/condições), R-056 (lead pergunta se é bot/IA → **silêncio total**), R-065 (dúvida complexa/irritação), R-038 (mídia recebida), FLUP-09. Tratados pela **Camada 2 (código)**, com o classificador de intenção como reforço aditivo — nunca OR-negado.
- **D-13:** No handoff, **silêncio total**: o bot não envia mensagem de handoff/transição e, se o lead perguntar se é bot, **não** nega, **não** admite e **não** desvia. Silêncio na conversa **não** significa silêncio operacional — a **notificação local (som + pop-up)** ao Admin continua disparando.
- **D-14:** Detecção de opt-out (**matcher determinístico pt-BR é autoridade**) + reforço do LLM. Recusa explícita **e** recusa implícita definida (ex.: "para de me mandar", "não quero mais") → `opt_out=true` + linha em `optout_ledger` (append-only, irreversível; coluna com CHECK que nenhum código desfaz). Casos ambíguos → **handoff** para decisão humana, sem auto-opt-out.
- **D-15:** Confirmação humana de handoff é 1 clique/1 comando → grava `handoff_events.human_acknowledged_at`. O bot só volta a falar mediante **ação explícita do Admin**, nunca por timeout.

**Mascaramento de PII e relatório/saída do shadow**
- **D-16:** Mascaramento de PII (**telefone + endereço**) antes de qualquer chamada de LLM (ADR-002/012). O **nome do lead é mantido** (dado de negócio público em contexto B2B, base legal = legítimo interesse). Mascaramento concentrado em **um único choke-point do prompt-builder**, não espalhado nos call sites.
- **D-17:** O relatório de shadow é um documento gerado a partir do banco (`npm run shadow:report` → Markdown/HTML): rascunho gerado vs. o que teria sido enviado, decisões do gate, contagem aprovado/editado/descartado, **contagem de alucinações**, revelações de automação, latência e custo de tokens.
- **D-18:** Critérios de saída do shadow (conforme ADR-010) são checados **programaticamente**, mas a transição shadow→ativo exige **aprovação explícita do Admin** — o programa não promove a si mesmo. Shadow é o default da Fase 2 e **nunca envia**.

### the agent's Discretion
- Valores numéricos exatos dos critérios de saída do shadow (N de dias, taxa mínima de aprovação, teto de revelações de automação) e do orçamento de qualificação são **discretion** — devem seguir ADR-010/observabilidade e ser confirmados no plano, não nesta discussão.
- Lista de keywords pt-BR de opt-out/irritação e o conjunto adversarial de ~200 mensagens são **discretion** de implementação, desde que o matcher determinístico permaneça a autoridade.
- Nomes exatos de tabelas/colunas (`llm_runs`, campos-canário) são **discretion**, desde que respeitem append-only e FK para `messages`.

### Deferred Ideas (OUT OF SCOPE)
- **Chime Web Audio de redundância da notificação** — ROADMAP 02-02 cita como redundância, mas a Fase 1 (01-CONTEXT) adiou o chime para a Fase 3 (não há painel/browser até lá para tocar Web Audio). Resolução: notificação na Fase 2 = `notify.ps1` (som + pop-up); chime redundante fica para a Fase 3. **Conflito de roadmap marcado como resolvido** — o planner deve ajustar 02-02 para não exigir o chime.
- **Painel HTTP/React de revisão** — pertence à Fase 3 (R-046); nesta fase só CLI.
- **Cadência completa de follow-up e dreno jittered** (ADR-009) — Fase 3; a Fase 2 só toca FLUP-04/05/07/09/10 na medida da decisão de estado/handoff.
- **Migração para API oficial do WhatsApp** — fase futura.
- **Escolha definitiva de provider/modelo de LLM** — decidida pelo bake-off, não nesta fase.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Descrição (REQUIREMENTS.md) | Research Support |
|----|------------------------------|------------------|
| OPRE-04 | IA menciona serviços de forma consultiva, nunca negociando preço/prazo/escopo (R-053) | Camada 3 gera texto sob estado resolvido; gate L4 (regex pt-BR de preço/prazo) barra em código; bake-off mede tom consultivo pt-BR |
| OPRE-05 | IA não presume nicho/porte/dor; personalização na conversa (R-054) | Prompt-builder monta contexto só do que existe (nome, histórico, 1ª msg do Admin); sem campos de nicho |
| LEAD-05 | Qualifica só com verba/interesse E decisão (R-051) | `qualification` jsonb em `conversations` + `resolveNextState` exige `verba && decisao` para `aquecido` (Padrão 1) |
| LEAD-06 | Valida verba/decisão de forma híbrida, nunca interrogatório (R-052) | Schema Zod Camada 1 com `qualification:{verba,decisao,evidence}` inferido do contexto |
| CONV-01 | Bot assume quando o Admin manda a 1ª mensagem, mesmo sem resposta (R-002) | `first_contact_by_human` já existe (Guard 0, Fase 1); captura do texto da 1ª msg entra como contexto (02-01) |
| CONV-02 | IA conduz qualificação/aquecimento/diagnóstico/objeções/CTA humanizado (R-008) | Camada 3 + FSM `novo→aquecimento→qualificando→aquecido` |
| CONV-03 | API externa de LLM; local controla fluxo/limites/handoff; mascara dados (R-009) | `LlmPort` adapter; sanduíche 3 camadas; mascaramento no choke-point do prompt-builder (D-16) |
| CONV-04 | Persona consultiva, entender a dor antes de ofertar (R-010) | ADR-012 §6.1 system prompt; bake-off mede |
| CONV-05 | Condução dinâmica, sem script rígido (R-011) | Persona + temperatura 0.7 (ADR-012 §6.9); FSM hintada, não roteiro |
| CONV-06 | Reconhece objeções e contorna (R-041) | `objecao_preco`/`objecao_tempo`/`objecao_fornecedor`/`vou_pensar` no enum de intenção (D-09) |
| CONV-07 | Contorna objeção dentro de limites rígidos, sem valor/prazo/desconto/proposta/agendamento (R-042) | Post-gate L4 (regex) + gate L5; `pedido_preco` separado de `objecao_preco` |
| CONV-08 | Age como o Admin humano, sem revelar automação (R-055) | Persona `type=HUMAN` (ADR-012 §2.1); L4 barra termos de automação; adversarial set |
| CONV-09 | Pergunta direta se é bot/IA → handoff, sem negar/admitir/desviar (R-056) | Camada 1 sinal `bot_suspicion` → Camada 2 → `HandoffService` com **zero** `sendIntent`; matcher determinístico como autoridade |
| CONV-10 | Suspeita de automação → silêncio total até o Admin assumir (R-057) | `engagement_mode='awaiting_human'`; gate devolve `handoff_silent`; nenhuma msg de transição |
| CONV-12 | Mídia recebida é só registrada, notifica e aciona handoff (R-038) | `conversations.pending_media_block` (Fase 1) + `handoff_events.triggered_by='message_type'` |
| FLUP-04 | Handoff em pedido de preço/proposta/orçamento OU intenção de agendar (R-012) | Enum `pedido_preco` e `intencao_agendar` → `HandoffService` transacional (D-11) |
| FLUP-05 | Notificação local (som + pop-up) com lead, motivo e ação rápida (R-013) | `NotifyPort` → `notify.ps1` (Fase 1), payload com lead/motivo/ação |
| FLUP-07 | Bot nunca agenda sozinho; sem link/horários/confirmação (R-025) | L4 regex de data/hora/link de agenda; `intencao_agendar` → handoff |
| FLUP-09 | Handoff também em irritação/ameaça/pedido de opt-out/dúvida complexa (R-065) | `irritacao`, `ameaca`, `pedido_optout`, `duvida_complexa` no enum + matcher pt-BR |
| FLUP-10 | Em irritação/ameaça: pausa, notifica, silêncio total, sem desculpas (R-066) | Silêncio total (D-13); `HandoffService` sem `sendIntent` |
| CRM-02 | IA atualiza status com critérios claros/auditáveis; Admin corrige (R-022) | `resolveNextState` grava `status_history` com `changed_by='bot'`/`reason`; correção = evento `changed_by='admin'` |
| COMP-01 | Detecta opt-out automaticamente; base legal/finalidade; comando manual; retenção (R-024) | Matcher pt-BR (autoridade) + `llm_signal` (reforço) → `optout_ledger` (append-only, já existe); `detected_by` ∈ {`deterministic`,`llm_signal`} |
| NFRQ-03 | Modo automático total após 1ª msg manual; só chama nos handoffs; pós-handoff → copiloto (R-034) | `mode_changes` + máquina de modos; `awaiting_human`→`human`→`copilot` (Fase 2 grava; painel é Fase 3) |
</phase_requirements>

---

## Summary

A Fase 2 liga a LLM por cima da fundação já fechada na Fase 1 — **sem enviar um único byte a lead**. O que a pesquisa confirma é que quase toda a infraestrutura de controle já existe no repositório e **não deve ser reconstruída**: o gate (`evaluatePolicy` + `GUARD_ORDER` de 15 entradas), o choke-point de envio (`src/application/dispatcher.ts`, único autorizado a chamar `sendText`, garantido por lint e teste), o barramento de eventos, o `NotifyPort` → `notify.ps1`, o `outbox` transacional e as tabelas append-only (`messages`, `handoff_events`, `mode_changes`, `optout_ledger`, `blocked_attempts`, `event_log`). A Fase 2 **consome** essas peças e acrescenta três coisas: `LlmPort` + FSM hintada (sanduíche de 3 camadas), `HandoffService` + matcher pt-BR de opt-out, e o shadow mode.

A descoberta de maior impacto para o planejador é uma **armadilha de schema**: o trigger `trg_messages_append_only` (BEFORE UPDATE OR DELETE, criado em `0004_guards_and_audit.sql`) **torna impossível** `UPDATE messages SET status='sent'`. A proposta do ADR-010/Padrão 4 da ARCHITECTURE ("promove o rascunho a enviado com um UPDATE") é **incompatível com R-043** e não pode ser implementada. A decisão D-06 (a decisão de revisão é evento append-only; o `status` do rascunho nunca é mutado) é, portanto, não apenas preferível — **é a única forma que o banco permite**. A segunda armadilha: o CHECK `conversations_engagement_mode_check` **não contém `'shadow'`**, e `mode_changes.from_mode/to_mode` tampouco. Shadow como `engagement_mode` (D-18/ROADMAP 02-03) exige **migração 0006** para alterar ambos os CHECKs — sem ela, todo INSERT de shadow falha no banco.

A recomendação primária é: **construir a camada de LLM atrás de `LlmPort` com `ScriptedLlmAdapter` primeiro** e só depois plugar o provider real escolhido pelo bake-off; manter `evaluatePolicy` e `resolveNextState` como código puro determinístico que **vence** a hint; persistir rascunho em `messages(origin='ai_suggestion', status='suggested')` + `llm_runs`; e fazer a rota de shadow **nunca importar** o dispatcher (teste de lint estendido do choke-point existente).

**Primary recommendation:** `LlmPort` trocável com duas chamadas em tiers distintos (extração barata → código decide → geração forte), estado/limites no Postgres, shadow como `conversations.engagement_mode='shadow'` que grava rascunho e **nunca** alcança `sendText` — com migração 0006 acrescentando `'shadow'` aos CHECKs de modo e `llm_runs`.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Extração de intenção/sinais (Camada 1) | API/Backend (processo Node, `LlmPort`) | — | Chamada externa; roda a cada inbound; modelo barato |
| Resolução de estado (`resolveNextState`) | API/Backend (código puro) | Database/Storage (estado autoritativo) | Código decide; Postgres guarda `conversations.state` |
| Decisão de envio (`evaluatePolicy`) | API/Backend (função pura) | — | Autoridade única; pré-LLM na leitura, pós-geração em shadow |
| Geração de texto (Camada 3) | API/Backend (`LlmPort`) | — | Só sob estado já resolvido; modelo forte |
| Mascaramento de PII | API/Backend (choke-point do prompt-builder) | — | Um único ponto antes de qualquer egress |
| Persistência de rascunho (shadow) | Database/Storage (`messages` + `llm_runs`) | — | Append-only; nunca chega ao dispatcher |
| Persistência de handoff + silêncio | Database/Storage (`handoff_events`, `mode_changes`, `conversations`) | API/Backend (`HandoffService`) | Transação única; efeito do silêncio é do banco |
| Notificação local (som + pop-up) | OS/Windows (PowerShell WinRT via `NotifyPort`) | — | Soberania do SO; `notify.ps1` já existe |
| Detecção de opt-out | API/Backend (matcher pt-BR determinístico) | API/Backend (`llm_signal`, reforço aditivo) | Determinístico é autoridade; LLM só soma |
| Revisão de shadow + kill switch | Cliente/CLI local (processo Node, sem browser) | Database/Storage (eventos append-only) | CLI-first na Fase 2 (D-01); painel é Fase 3 |
| Relatório de shadow | API/Backend (gerador de doc a partir do banco) | Database/Storage | `npm run shadow:report`; gate de saída da fase |

---

## Standard Stack

> **Atenção ao gate de legitimidade:** todos os pacotes abaixo foram verificados por `slopcheck 0.6.1` (`[OK]`) e por `npm view`. Ver `## Package Legitimacy Audit`.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `ai` (Vercel AI SDK) | **7.0.138** `[VERIFIED: npm registry]` | Abstração de provider + `Output.object` | Uma interface para OpenAI/Anthropic/Google (R-009 mantém o provider aberto); `Output.object({schema: zod})` converte o LLM em função de decisão tipada — o mecanismo do sanduíche. Documentação oficial confirma `generateText({ output })` → `{ output }` e erros tipados `NoObjectGeneratedError`/`NoOutputGeneratedError` |
| `@ai-sdk/openai` | **4.0.92** `[VERIFIED: npm registry]` | Provider OpenAI | Peer do `ai@7`; um dos candidatos do bake-off |
| `@ai-sdk/anthropic` | **4.0.79** `[VERIFIED: npm registry]` | Provider Anthropic/Claude | Candidato do bake-off (tom pt-BR) |
| `@ai-sdk/google` | **4.0.94** `[VERIFIED: npm registry]` | Provider Google/Gemini | Candidato do bake-off (custo/latência) |
| `zod` | **4.6.5** (já instalado) | Validação de runtime | Peer do `ai@7` (`^3.25.76 \|\| ^4.1.8`); schema único para saída da LLM, config e fronteiras |
| `drizzle-orm` + `drizzle-kit` | **0.45.3** / **0.31.11** (já instalados) | ORM + migração | Padrão do projeto; migração 0006 (`llm_runs` + CHECK de modo) em `.sql` revisável |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | **5.0.2** (já instalado) | Testes unit/integração | Sempre; prioridade no gate e no `resolveNextState` (é onde AR/FSM regridem) |
| `fast-check` | (já instalado) | Property-based testing | Idempotência do `HandoffService`, invariantes de `resolveNextState`, matcher pt-BR |
| `pino` | **10.3.1** (já instalado) | Log estruturado | `llm_runs` para observabilidade de tokens; log **nunca** o corpo do prompt/resposta |
| `croner` | **10.0.1** (já instalado) | Ticks | Só contexto (a cadência é Fase 3) |
| `tsx` | (já instalado) | Run TS em dev | Harness do adversarial set e do bake-off |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `ai@7` + `Output.object` | SDK cru de cada provider | Só se travar em **um** provider para sempre; R-009 mantém a escolha aberta e o `Output.object` economiza validação manual. **Não usar** |
| Sanduíche de 3 camadas (2 chamadas) | Envelope único (Padrão 1 ARCHITECTURE) | Registrado como alternativa em D-08; preterido porque gera texto **antes** da decisão do código — mais fraco para AR. **Não implementar na Fase 2** |
| `LlmPort` porta/adaptador | Chamar `ai` direto no handler | Quebra o padrão do projeto (`ChannelPort`, `NotifyPort`, `ClockPort`) e o requisito de troca de provider |
| 3 SDKs de provider instalados | Só o vencedor do bake-off | Instalar os 3 permite rodar o bake-off sem editar deps; removível depois. Custo: 3 deps, sem runtime extra |

**Installation:**
```bash
npm install --save-exact ai@7.0.138 @ai-sdk/openai@4.0.92 @ai-sdk/anthropic@4.0.79 @ai-sdk/google@4.0.94
```
> `zod`, `drizzle-orm`, `drizzle-kit`, `vitest`, `fast-check`, `pino`, `croner` e `tsx` **já estão instalados** — não reinstalar. Confirmar versões com `npm view <pkg> version` antes de fixar (o `latest` do `ai` pode andar; o projeto pina por exatidão, cf. ADR-001 e STACK §Version Pinning).

**Version verification (executado 2026-10-13):**
```bash
npm view ai version             # 7.0.138
npm view @ai-sdk/openai version  # 4.0.92
npm view @ai-sdk/anthropic version # 4.0.79
npm view @ai-sdk/google version  # 4.0.94
```

---

## Package Legitimacy Audit

> Executado com `slopcheck 0.6.1` em 2026-10-13 (`slopcheck install <pkgs>`; o passo de instalação do slopcheck falha no Windows por `subprocess`, mas os **veredictos do scan** são válidos e são o que consta abaixo).

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `ai` | npm | linha 3.x→7.x, anos | milhões/semana | github.com/vercel/ai | **[OK]** | Aprovado |
| `@ai-sdk/openai` | npm | anos | milhões/semana | github.com/vercel/ai | **[OK]** | Aprovado |
| `@ai-sdk/anthropic` | npm | anos | alto | github.com/vercel/ai | **[OK]** | Aprovado |
| `@ai-sdk/google` | npm | anos | alto | github.com/vercel/ai | **[OK]** | Aprovado |

**Packages removed due to slopcheck [SLOP] verdict:** nenhum.
**Packages flagged as suspicious [SUS]:** nenhum.

---

## Architecture Patterns

### System Architecture Diagram

Fluxo do caminho quente em **shadow** (nenhum byte sai). O ramo "envio real" permanece **desligado** na Fase 2.

```
 WhatsApp (lead)
   │  messages.upsert { type:'notify' }
   ▼
 [BaileysChannelAdapter] ──► EventBus 'inbound'
   │
   ▼
 [Ingestion]  dedup idempotency_key · watermark(last_processed_at) · type append → persiste, NÃO publica
   │  message.received
   ▼
 ┌───────────────  HANDLER DE INBOUND (02-01/02-02)  ───────────────┐
 │ 1. guardas locais em CÓDIGO (nunca no prompt):                    │
 │    optout_ledger ativo? → encerrado. PARA.                        │
 │    pending_media_block? → handoff('message_type'). PARA.          │
 │    engagement_mode != bot_active? → silêncio. PARA.               │
 │ 2. MATCHER pt-BR determinístico de opt-out (AUTORIDADE)           │
 │    ├─ explícito/implícito definido → optout_ledger + encerrado    │
 │    └─ ambíguo → handoff (decisão humana)                          │
 │ 3. Camada 1 (LLM barato, Output.object):                          │
 │    {intent, signals, qualification, canary}                       │
 │    └─ parse/canário falha → 1 reprompt → falha: silêncio+notify   │
 │ 4. Camada 2 (CÓDIGO PURO, decide ANTES de gerar texto):           │
 │    resolveNextState(prev, hint, ctx)   ← guardas vencem a hint    │
 │    se sinal de handoff → HandoffService (tx) → PARA (silêncio)    │
 │ 5. Camada 3 (LLM forte): gera texto SOB o estado resolvido        │
 │    └─ prompt-builder MASCARA telefone+endereço (choke-point)      │
 │ 6. evaluatePolicy(snapshot, now, intent)  ← GATE (já existe F1)   │
 │    ├─ deny → recordBlockedAttempt (auditoria)                     │
 │    └─ allow ↓                                                     │
 │ 7. SHADOW: INSERT messages(origin='ai_suggestion',               │
 │    status='suggested') + INSERT llm_runs   ← NUNCA dispatcher     │
 └──────────────────────────────────────────────────────────────────┘
                              │
   [ADMIN CLI]  npm run shadow:list / shadow:approve|edit|discard
        │            → INSERT evento de revisão (append-only)
        └────────────  npm run mode --pausar  → kill switch (settings/mode_changes)

 (Ramo DESLIGADO na Fase 2 — só Fase 3)  dispatcher.ts → ChannelPort.sendText
```

### Recommended Project Structure
```
src/
├── domain/
│   ├── ports/
│   │   ├── LlmPort.ts            # nova porta: extract() + generate(); trocável
│   │   └── ...                   # ChannelPort, NotifyPort, ClockPort (existem)
│   ├── orchestrator/
│   │   └── transitions.ts        # NEW: State, ALLOWED, resolveNextState() — puro
│   └── llm/
│       ├── envelope.ts           # schemas Zod (intent/signals/qualification/canary)
│       └── prompt-builder.ts     # CHOKE-POINT de mascaramento PII
├── application/
│   ├── inbound-handler.ts        # EXISTE: acoplar Camada 1 + 2
│   ├── handoff-service.ts        # NEW: tx única (D-11)
│   ├── optout-matcher.ts         # NEW: matcher pt-BR determinístico (autoridade)
│   ├── shadow.ts                 # NEW: grava rascunho; NÃO importa dispatcher
│   └── dispatcher.ts             # EXISTE: único sendText (não tocar)
├── infra/
│   ├── llm/
│   │   ├── ai-sdk-adapter.ts     # implementa LlmPort via ai@7
│   │   └── scripted-adapter.ts   # NEW: determinístico p/ testes (primeiro)
│   ├── db/
│   │   ├── schema.ts             # EXISTE: + llmRuns, + reviewEvents
│   │   └── migrations/0006_*.sql # NEW: CHECK 'shadow' + llm_runs + review events
│   └── notifier.ts               # EXISTE: NotifyPort → notify.ps1
└── cli/
    └── shadow.ts                 # NEW: list/report/approve/edit/discard; mode
```

### Pattern 1: FSM com Transição Sugerida, Nunca Aceita (Hinted FSM)
**What:** o LLM produz um **hint**; a transição é decidida por `resolveNextState(prev, hint, ctx)` — código puro com guardas que vencem a hint.
**When to use:** sempre (núcleo do sistema).
**Example:**
```typescript
// Source: .planning/research/ARCHITECTURE.md §Padrão 1 + D-07
type Estado = 'novo' | 'aquecimento' | 'qualificando' | 'aquecido'
            | 'awaiting_human' | 'human' | 'copilot' | 'pausado' | 'encerrado';

const ALLOWED: Record<Estado, Estado[]> = {
  novo:           ['aquecimento', 'qualificando', 'awaiting_human', 'encerrado'],
  aquecimento:    ['qualificando', 'awaiting_human', 'encerrado'],
  qualificando:   ['aquecimento', 'aquecido', 'awaiting_human', 'encerrado'],
  aquecido:       ['qualificando', 'awaiting_human', 'encerrado'],
  awaiting_human: ['human', 'copilot', 'pausado', 'encerrado'],
  human:          ['copilot', 'pausado', 'encerrado'],
  copilot:        ['human', 'pausado', 'encerrado'],
  pausado:        ['human', 'copilot', 'encerrado'],
  encerrado:      [],
};

function resolveNextState(prev: Estado, hint: string, ctx: SinaisLocais): Estado {
  // 1. Invariantes absolutas vencem TUDO, inclusive a hint.
  if (ctx.optOutAtivo)                 return 'encerrado';       // AR-005
  if (ctx.handoffDisparado)            return 'awaiting_human';  // AR-010
  if (ctx.engagementMode !== 'bot_active' && ctx.engagementMode !== 'shadow') return prev;
  if (ctx.sequenciaEsgotada)           return 'encerrado';       // R-005
  if (ctx.qualificacao.verba && ctx.qualificacao.decisao) return 'aquecido'; // R-051
  // 2. Só então a hint, validada contra o mapa.
  return (ALLOWED[prev] as string[]).includes(hint) ? (hint as Estado) : prev;
}
```

### Pattern 2: Sanduíche de 3 camadas (D-08)
**What:** Camada 1 (extração, modelo barato) → Camada 2 (código decide) → Camada 3 (geração, modelo forte, sob o estado resolvido).
**When to use:** todo inbound em modo bot/shadow.
**Example (AI SDK 7, Camada 1):**
```typescript
// Source: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
import { generateText, Output } from 'ai';
import { z } from 'zod';

const EnvelopeExtracao = z.object({
  intent: z.enum([
    'saudacao', 'duvida_simples', 'duvida_complexa',
    'pedido_preco',        // → handoff (AR-001) — separado de objecao_preco (D-09)
    'objecao_preco', 'objecao_tempo', 'objecao_fornecedor', 'vou_pensar',
    'intencao_agendar',    // → handoff (R-025/FLUP-07)
    'bot_suspicion',       // → silêncio total (R-056)
    'irritacao', 'ameaca', // → silêncio total (R-066)
    'pedido_optout', 'midia_recebida', 'outro',
  ]),
  signals: z.object({
    pricingAsked: z.boolean(), schedulingIntent: z.boolean(),
    botSuspicion: z.boolean(), irritation: z.boolean(),
    optOutIntent: z.boolean(), mediaReceived: z.boolean(),
  }),
  qualification: z.object({ verba: z.number().int().min(0).max(2).nullable(),
                            decisao: z.number().int().min(0).max(2).nullable() }),
  nextStateHint: z.string(),
  canary: z.string(),      // campo-canário: deve ecoar um valor injetado pelo código
});

const { output } = await generateText({
  model: modeloBarato,
  output: Output.object({ schema: EnvelopeExtracao }),
  prompt: promptMontado,     // JÁ mascarado pelo choke-point
});
// output pode lançar NoObjectGeneratedError / canary divergente → 1 reprompt → silêncio+notify
```

### Pattern 3: Choke-point de mascaramento de PII (D-16)
**What:** um único módulo (`llm/prompt-builder.ts`) recebe o payload bruto e devolve o payload mascarado. Nenhum outro arquivo formata prompt.
**When to use:** sempre que montar qualquer entrada para a LLM.

### Pattern 4: Handoff como interrupção persistida (D-11)
**What:** handoff é estado gravado, não callback. `HandoffService.trigger()` numa transação grava `handoff_events` + `mode_changes` + `conversations.engagement_mode='awaiting_human'` + `handoff_active=true`, e devolve `sendIntent = NENHUMA`.
**When to use:** qualquer gatilho R-012/R-056/R-065/R-038/FLUP-09.
**Example:**
```sql
BEGIN;
  INSERT INTO handoff_events (conversation_id, lead_id, channel_account_id,
      triggered_by, trigger_detail, trigger_value, excerpt,
      simultaneous_send_blocked, bot_stopped_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7, TRUE, $now);
  UPDATE conversations
     SET engagement_mode='awaiting_human', handoff_active=TRUE
   WHERE id=$1;
  INSERT INTO mode_changes (conversation_id, from_mode, to_mode, actor, reason)
    VALUES ($1,'bot_active','awaiting_human','bot',$6);
COMMIT;
-- sendIntent NÃO existe nesta transação: o silêncio é efeito, não intenção.
```
> `conversations` **aceita** UPDATE (só `messages`/`event_log`/`optout_ledger` são append-only; `leads` barra apenas `opt_out` reverso). Logo `UPDATE conversations` e `UPDATE settings` são legítimos.

### Anti-Patterns to Avoid
- **`UPDATE messages SET status='sent'`**: **bloqueado no banco** pelo trigger `trg_messages_append_only` (0004). Use evento de revisão (D-06).
- **`UPDATE leads SET opt_out=false`**: bloqueado por `trg_leads_opt_out_irreversivel`. Reativação só via `optout_ledger(event_type='reinstate')`.
- **Auto-promoção shadow→ativo**: o programa nunca promove a si mesmo (D-18); exige comando explícito do Admin.
- **Rota de shadow que importa o dispatcher**: um import acidental fura o choke-point. Reforçar com teste de lint.
- **Gatilho de mídia/foto na Camada 3**: mídia nunca chega ao LLM; é registrada e vira handoff na Camada 2 (AR-009/CONV-12).
- **Estado no prompt / LLM escolhe transição**: o inverso de R-009/AR-010 (ARCHITECTURE §Anti-Padrão 1).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Parsing/validação de JSON do LLM | parser/regex próprio | `ai` `Output.object({schema: zod})` | Valida contra schema, tipa, e erra de forma tipada (`NoObjectGeneratedError`) |
| Retry/backoff de chamada ao provider | loop manual | `maxRetries`/tratamento no adapter — **[ASSUMED]** confirmar na doc do AI SDK | O SDK já tem retry configurável; não reintroduzir |
| Contagem de tokens/custo | contador manual | objeto `usage` do resultado (`promptTokens`/`completionTokens`) | O provider é a fonte; alimenta `llm_runs` |
| Detecção de classe de mídia | sniffing próprio | `pending_media_block` (Fase 1) | AR-009 já modelado no schema |
| Janela/cota | checagem ad-hoc | `evaluatePolicy` (Fase 1) | Autoridade única; 15 guardas canônicas |
| Fila/entrega | fila nova | `outbox` + `SKIP LOCKED` (Fase 1) | Transacional, idempotente |
| Notificação Windows | toast próprio | `notify.ps1` via `NotifyPort` (Fase 1) | WinRT/AppUserModelID já resolvido |

**Key insight:** nesta fase quase nada é construído do zero — a Fase 1 deixou o gate, o choke-point, a fila e a notificação prontos. A Fase 2 é **fiação e política**, não infraestrutura.

---

## Common Pitfalls

### Pitfall 1 (CRÍTICO): `messages` é append-only — não há promoção por UPDATE
**What goes wrong:** seguir o Padrão 4 da ARCHITECTURE ("`UPDATE messages SET status='sent' WHERE status='suggested'`") → o trigger `trg_messages_append_only` lança exceção e a promoção falha.
**Why it happens:** a ARCHITECTURE foi escrita antes do trigger de R-043; `REVOKE UPDATE, DELETE ... FROM PUBLIC` + trigger de `BEFORE UPDATE OR DELETE` fecham as duas portas.
**How to avoid:** a decisão de revisão é um **evento append-only** numa tabela própria (`llm_runs` ou `review_events`), nunca um UPDATE no rascunho (D-06). Em shadow nada é enviado, então nenhuma transição de status é sequer necessária.
**Warning signs:** um teste que espera `status='sent'` vindo de `status='suggested'`; qualquer `UPDATE messages` no código.

### Pitfall 2 (CRÍTICO): CHECK de `engagement_mode` não conhece `'shadow'`
**What goes wrong:** `INSERT`/`UPDATE` de `conversations.engagement_mode='shadow'` viola `conversations_engagement_mode_check` (valores atuais: `bot_active, awaiting_human, human, copilot, pausado`). Idem para `mode_changes.from_mode/to_mode`.
**Why it happens:** o valor `'shadow'` foi introduzido na Fase 2 (D-18/ROADMAP 02-03), depois do schema da Fase 1.
**How to avoid:** **migração 0006** com `ALTER TABLE ... DROP CONSTRAINT ... ; ADD CONSTRAINT ... CHECK (... IN ('bot_active','awaiting_human','human','copilot','pausado','shadow'))` em `conversations` e `mode_changes`.
**Warning signs:** erro de CHECK no boot/1º inbound; teste de shadow que nunca chega a gravar.

### Pitfall 3 (ALTO): três interruptores de "shadow" concorrentes
**What goes wrong:** ADR-010 propõe `settings.shadowMode` global; D-02 propõe `settings.operational_mode='paused'` (kill switch); ROADMAP 02-03/D-18 propõe `conversations.engagement_mode='shadow'` (por conversa). Implementar os três cria estados ambíguos ("shadow global ligado, conversa em `human`?").
**Why it happens:** documentos de fases diferentes nomearam o mesmo conceito.
**How to avoid:** **uma** fonte de verdade: `conversations.engagement_mode='shadow'` (por conversa) para o rascunho; `settings.operational_mode` só como **kill switch global** (D-02). O booleano global `shadowMode` do ADR-010 fica **superseded** (como a tabela `suggestions`).
**Warning signs:** gate lendo `settings.shadowMode`; duas colunas dizendo a mesma coisa.

### Pitfall 4 (ALTO): mascaramento só do `leadContext` vaza PII pelo histórico
**What goes wrong:** ADR-012 §6.2 mascara apenas `leadContext.phone/address`, mas envia `conversationHistory` e `lastMessage` **crus** — o lead pode ter escrito o próprio telefone/endereço na conversa, ou a 1ª mensagem do Admin pode conter o endereço.
**Why it happens:** o exemplo do ADR foi escrito antes da regra do choke-point único (D-16).
**How to avoid:** o choke-point mascara **todo** o payload de egresso (contexto + histórico + última mensagem + 1ª msg do Admin), não só o contexto estruturado.
**Warning signs:** teste de mascaramento que só cobre `leadContext`; telefone visível em `llm_runs`/log.

### Pitfall 5 (ALTO): prompt como controle (ADR-012 lista os 12 AR no system prompt)
**What goes wrong:** tratar o system prompt como garantia → uma alucinação de preço vaza para o rascunho e a confiança no gate cai.
**Why it happens:** ADR-012 §2.4/§6.1 listam os AR explicitamente no prompt.
**How to avoid:** o prompt é **L1 (qualidade)**, nunca controle. As garantias são L2 (`Output.object`), L3 (intenção→handoff), L4 (regex pt-BR pós-geração), L5 (gate) e L6 (adapter do canal). Medição do pitfall já registrada em PITFALLS.md: regex 60–70% / classificador 89–94% / combinado 99,1%.
**Warning signs:** confiar no "retorne apenas HANDOFF"; ausência de post-gate regex.

### Pitfall 6 (MÉDIO): custo/latência da Camada 1 em todo inbound
**What goes wrong:** a Camada 1 roda em **cada** mensagem recebida; com modelo caro, custo e latência explodem.
**How to avoid:** tier barato para extração (STACK §Provider and model selection); `llm_runs` mede tokens/latência por chamada; Camada 3 só quando o estado resolvido pede geração.
**Warning signs:** latência > 5 s no inbound; custo por lead acima do previsto no ADR-002.

### Pitfall 7 (MÉDIO): canário é aderência de schema, não defesa contra injection
**What goes wrong:** supor que o campo-canário prova resistência a prompt-injection.
**How to avoid:** o canário detecta desvio de formato/instrução, não ataque; a defesa real continua sendo o gate + post-gate + mídia bloqueada na Camada 2. Documentar como sinal fraco.

### Pitfall 8 (MÉDIO): `notify.ps1` sem chime vs ROADMAP 02-02
**What goes wrong:** o plano 02-02 cita "chime Web Audio como redundância" — impossível sem browser (Fase 3).
**How to avoid:** notificação da Fase 2 = `notify.ps1` (som + pop-up). Ajustar o texto do 02-02 (já marcado como resolvido em Deferred).

### Pitfall 9 (BAIXO): comentário de migração desatualizado
**What goes wrong:** `schema.ts` refere-se a `0003_guards_and_audit.sql`, mas o arquivo real é `0004_guards_and_audit.sql` (`0003` é `0003_phase01_02_tabelas.sql`).
**How to avoid:** apontar o arquivo correto no plano; não confiar no comentário.

---

## Code Examples

### Erros tipados do `Output.object` (fail-closed)
```typescript
// Source: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
import { generateText, Output, NoObjectGeneratedError, NoOutputGeneratedError } from 'ai';

try {
  const { output } = await generateText({ model, output: Output.object({ schema }), prompt });
  if (output.canary !== canaryEsperado) throw new Error('CANARIO_DIVERGENTE');
  return output;
} catch (erro) {
  if (NoObjectGeneratedError.isInstance(erro)) {
    // erro.cause / erro.text / erro.usage disponíveis → 1 reprompt
  } else if (NoOutputGeneratedError.isInstance(erro)) {
    // sem output (ex.: terminou em tool-calls)
  }
  // esgotou o reprompt → silêncio + notifyAdmin (NUNCA texto livre) — D-10
}
```

### Classificação com escolha fixa (alternativa para intenção)
```typescript
// Source: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
const { output } = await generateText({
  model,
  output: Output.choice({ options: ['pedido_preco','objecao_preco','outro'] }),
  prompt,
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `generateObject()` (AI SDK 4/5) | `generateText({ output: Output.object() })` | AI SDK 6→7 | A API antiga sai de foco; usar `Output.*`. `generateObject` **pode** ainda existir, mas o padrão documentado é `output` |
| Envelope único com hint (Padrão 1 ARCH.) | Sanduíche de 3 camadas / 2 chamadas (D-08) | Fase 2 (2026-10-13) | Texto gerado **depois** da decisão → menos vazamento de tópico |
| Tabela `suggestions` do ADR-010 | `messages(origin='ai_suggestion', status='suggested')` + `llm_runs` | D-04/D-05 | Fonte única append-only; corpo não duplicado |
| `suggested`→`sent` por UPDATE | Evento de revisão append-only | D-06 + trigger 0004 | Único caminho compatível com R-043 |

**Deprecated/outdated:**
- Tabela `suggestions` do ADR-010 e a flag global `settings.shadowMode`: superseded por D-04/D-05 e pela autoridade por-conversa (`engagement_mode`).
- Promoção por `UPDATE messages`: impossível (trigger).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `ai@7` expõe `maxRetries` configurável para retry do provider | Don't Hand-Roll | Baixo — confirmar na doc; se não houver, implementar retry no adapter com timeout |
| A2 | `@ai-sdk/*@4.x` são peers compatíveis com `ai@7.0.138` (mesma linha de versões) | Standard Stack | Médio — validar no `npm install` (peer warnings) antes de fixar |
| A3 | O vencedor do bake-off é um dos 3 providers instalados (OpenAI/Anthropic/Google) | Stack/Open Questions | Médio — se outro provider vencer (ex.: Groq), instalar o SDK correspondente |
| A4 | `settings.operational_mode` é a chave correta do kill switch (D-02 diz "ou equivalente") | Pitfall 3 | Médio — confirmar o nome exato da chave existente em `settings`/Fases 1 |
| A5 | O prompt pt-BR/tom consultivo de um provider específico é mensurável por bake-off | Summary/Pitfalls | Baixo — o bake-off existe justamente para medir; ADR-002 §6.2 já lista candidatos |

---

## Open Questions

1. **Chave exata do kill switch e forma de "pausado"**
   - O que sabemos: D-02 propõe `settings.operational_mode='paused'`; o gate já tem `GateReason` `kill_switch_ativo`.
   - O que é incerto: se a chave já existe seedada na Fase 1 ou se a Fase 2 precisa criar/seedá-la; se "pausado" é global (`settings`) ou por conversa (`engagement_mode='pausado'`).
   - Recomendação: kill switch **global** em `settings` (1 linha), auditado em `mode_changes` por conversa afetada; confirmar no plano 02-03.

2. **Critérios numéricos de saída do shadow (D-18/discretion)**
   - O que sabemos: ADR-010 §6.7/§7 dá defaults (`minDaysOfOperation` ex. 14, `minSuggestionsReviewed` ex. 100, `minApprovalRate` 0.80, `maxCriticalHallucinations` 0, `maxAutomationReveals` 0).
   - O que é incerto: os números finais (discretion) e de onde vêm as métricas (quantos leads/dia × quantas sugestões até 100).
   - Recomendação: fixar no plano 02-03, checar programaticamente, exigir aprovação explícita; armazenar em `settings`.

3. **Corpus e rubrica do bake-off**
   - O que sabemos: ~200 mensagens adversarial pt-BR (02-01); landmarks de custo/latência em ADR-002 §6.2.
   - O que é incerto: quem rotula "aprovado", qual métrica decide (taxa de aprovação simulada? aderência ao tom? custo?).
   - Recomendação: harness offline com o mesmo corpus pontuado por 2 critérios (aderência a AR/tom) + custo/latência; resultado registrado antes de plugar o adapter real.

4. **Forma dos eventos de revisão (D-03/D-06)**
   - O que sabemos: precisam ser append-only e reconstruíveis.
   - O que é incerto: tabela nova (`review_events`) vs colunas em `llm_runs`.
   - Recomendação: tabela `review_events(message_id, decision, actor, edited_text?, created_at)` — separa "geração" de "revisão"; ambos append-only.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | 24.21.0 (LTS "Kripton") | — |
| npm | Dependências | ✓ | 11.19.0 | — |
| PostgreSQL local | Persistência/estado | ✓ (instalado na Fase 1; 18.x) | 18.x | — |
| Rede externa (API LLM) | Camadas 1 e 3 | ✓ (assumido; requer chave `.env`) | — | Fail-closed: silêncio + notificação (D-10) |
| Chave de API do provider | Camadas 1 e 3 | ✗ (a configurar) | — | `ScriptedLlmAdapter` para testes sem rede |
| PowerShell 5.1 + WinRT | Notificação local | ✓ (Fase 1, `notify.ps1`) | — | — |
| `slopcheck` | Gate de legitimidade | ✓ | 0.6.1 | — |

**Missing dependencies with no fallback:** nenhum bloqueante.
**Missing dependencies with fallback:** chave de API do provider (se ausente, só há `ScriptedLlmAdapter`; a fase roda em shadow com o scripted adapter para desenvolvimento).

---

## Security Domain

> `security_enforcement` não está declarado como `false` no config → seção incluída.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Fase 2 é CLI local, sem servidor/HTTP (D-01). Autenticação entra com o painel (Fase 3) |
| V3 Session Management | no | Idem — sem sessão de app |
| V4 Access Control | parcial | Kill switch e revisão de shadow são ações locais do Admin; sem papéis (R-027 usuário único) |
| V5 Input Validation | **sim** | `zod` em: saída da LLM (`Output.object`), config, e matcher pt-BR; `CHECK` no banco |
| V6 Cryptography | no | R-033 aceita "sem criptografia adicional" (risco documentado) |
| V7 Error Handling / Logging | **sim** | `pino` com redact; `llm_runs` sem corpo de prompt; `event_log`/`blocked_attempts` append-only |
| V8 Data Protection | **sim** | Mascaramento de PII (telefone+endereço) no choke-point do prompt-builder; nome mantido por base legal (D-16) |
| V9 Communications | parcial | Egresso só HTTPS para o provider; chamadas locais em `127.0.0.1` |

### Known Threat Patterns for {Node/TS + LLM externa + PostgreSQL local}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection (lead tenta manipular a IA) | Tampering | Camada 2 decide em código; post-gate regex; mídia nunca chega ao LLM; canário + reprompt |
| Exfiltração de PII para o provider | Information Disclosure | Choke-point único de mascaramento cobrindo histórico + última msg; `llm_runs` sem corpo |
| Alucinação com promessa (preço/prazo/proposta) | Tampering/Repudiation | `Output.object` (L2) + `intent→handoff` (L3) + regex pt-BR (L4) + gate (L5); fail-closed |
| Envio após handoff (AR-010) | Elevation of Privilege | `HandoffService` transacional; gate lê `conversations`, nunca estado local |
| Contornar opt-out (AR-005) | Elevation of Privilege | Matcher pt-BR autoritativo; `optout_ledger` append-only; CHECK + trigger em `leads` |
| Vazamento de logs com corpo de conversa | Information Disclosure | `pino` redact; logs só IDs/contagens; corpos vivem em `messages` |

---

## Sources

### Primary (HIGH confidence)
- `ai-sdk.dev/docs/ai-sdk-core/generating-structured-data` — `Output.object/array/choice/json`, `NoObjectGeneratedError`, `NoOutputGeneratedError`, `usage`, `stopWhen`, `.describe()`. Fetched 2026-10-13.
- Código do repositório (leitura direta): `src/domain/gate/{evaluate-policy,guard-order,types,kill-switch}.ts`, `src/application/{dispatcher,inbound-handler,event-bus,outbox,humanize}.ts`, `src/infra/db/schema.ts`, `migrations/0000..0005`, `src/infra/db/migrations/0004_guards_and_audit.sql`, `biome.json`, `tests/lint/choke-point.grep.test.ts`, `package.json`, `.planning/config.json`.
- ADRs: `docs/08-adr/{002-ia-externa,010-shadow-mode,012-prompt-persona,004-gate-invariantes,009-follow-up-conservador}.md`.
- Docs: `docs/01-requisitos-funcionais.md`, `docs/09-criterios-de-aceitacao.md`, `docs/10-anti-requisitos.md`.
- `.planning/research/{ARCHITECTURE,STACK,PITFALLS,SUMMARY}.md` — Padrão 1 (Hinted FSM), Padrão 2 (choke-point), Padrão 4 (handoff persistido), guardrails L1–L6, campanha de medição de bypass.
- `.planning/{REQUIREMENTS,ROADMAP,STATE}.md` + `02-CONTEXT.md`.
- `npm view` (2026-10-13) — versões de `ai` e `@ai-sdk/*`.

### Secondary (MEDIUM confidence)
- `slopcheck 0.6.1` — veredictos `[OK]` para `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`.

### Tertiary (LOW confidence)
- Benchmark de bypass de guardrail citado em PITFALLS.md (kalviumlabs.ai) — usado só para justificar defesa em profundidade, não como métrica do projeto.

---

## Metadata

**Confidence breakdown:**
- Standard stack: **HIGH** — versões verificadas via `npm view` + slopcheck; `ai@7` API confirmada na doc oficial; `zod`/drizzle/vitest já instalados.
- Architecture: **HIGH** — quase tudo existe no repo (gate, choke-point, outbox, notifier); padrões documentados em ARCHITECTURE/D-07..D-18. Ponto de design (sanduíche 3 camadas) é decisão travada (D-08), não descoberta.
- Pitfalls: **HIGH** para os dois CRÍTICOS (verificados em `schema.ts`/`0004_guards_and_audit.sql`); **MEDIUM** para os de custo/tom (dependem do bake-off).

**Research date:** 2026-10-13
**Valid until:** ~2026-11-12 (30 dias para stack estável; revalidar versões do `ai`/`@ai-sdk/*` e o resultado do bake-off antes de fixar o provider).
