# Phase 2: IA, Handoff e Shadow Mode - Context

**Gathered:** 2026-10-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Ligar a IA (LLM externa) por cima da fundação já fechada na Fase 1 — **sem** mandar nenhuma mensagem de verdade a lead nenhum. Esta fase entrega três capacidades e o portão de saída para a Fase 3:

1. **LlmPort + FSM hintada** — a LLM entra como *extratora de sinais e geradora de texto*, nunca como dona do estado. O estado autoritativo continua no Postgres; a transição é decidida por código determinístico (sanduíche de 3 camadas). Porta de LLM trocável, saída estruturada tipada, falha-fechada.
2. **Handoff + silêncio** — `HandoffService` que grava o handoff, emudece o bot e notifica localmente; detecção de opt-out determinística (pt-BR) como autoridade, com reforço do classificador de intenção.
3. **Shadow mode** — bot roda por inteiro (extrai sinais, resolve estado, decide pela política, gera rascunho) mas **escreve rascunho em vez de enviar**; Admin revisa. O relatório de shadow é o **gate de saída da Fase 2**.

**Entra nesta fase:** OPRE-04, OPRE-05, LEAD-05, LEAD-06, CONV-01..CONV-10, CONV-12, FLUP-04, FLUP-05, FLUP-07, FLUP-09, FLUP-10, CRM-02, COMP-01, NFRQ-03.

**NÃO entra nesta fase:** envio real em produção (Fase 3), painel HTTP/UI (Fase 3), chime Web Audio de redundância (Fase 3 — ver Deferred), cadência completa de follow-up com dreno jittered (Fase 3/ADR-009), migração para API oficial (fase futura).

**Regra-mestra desta fase (herdada e mantida):** `evaluatePolicy` roda **antes** de qualquer fiação de LLM; `sendText` só existe no choke-point `src/application/dispatcher.ts`. Em shadow, o caminho de "envio" resolve para *persistir rascunho*, nunca para o dispatcher.

</domain>

<decisions>
## Implementation Decisions

### Superfície do Admin na Fase 2 (revisão de shadow + kill switch)
- **D-01:** A superfície de admin na Fase 2 é **CLI-first** (`npm run shadow:*` para revisar/decidir, `npm run mode` para kill switch). Nenhum servidor HTTP nem painel React nesta fase — coerente com a Fase 1 (CLI + invariante "sem painel até a Fase 3") e com o volume (~20 leads/dia).
- **D-02:** O kill switch é **ação de 1 clique/1 comando** que seta `settings.operational_mode='paused'` (ou equivalente já existente de `mode_changes`) e faz o gate devolver `kill_switch_ativo`. Deve ser reversível e auditado em `mode_changes`.
- **D-03:** A revisão de shadow é registrada como **eventos append-only** (aprovar/editar/descartar), nunca como UPDATE no texto sugerido.
  - `[auto] Superfície do Admin — Q: "CLI-first vs endpoint HTTP mínimo vs painel React?" → Selecionado: "CLI-first (recomendado)"`

### Armazenamento do rascunho do copiloto (ADR-010 + R-043 histórico imutável)
- **D-04:** O **texto do rascunho vive em `messages`** com `origin='ai_suggestion'` e `status='suggested'`. Fonte única append-only de conteúdo (retention/LGPD, "message bodies live ONLY in `messages`"). A tabela `suggestions` do ADR-010 **não** armazena o corpo do texto; fica **superseded** pela decisão Padrão-4 da ARCHITECTURE + schema da Fase 1.
- **D-05:** Metadados de execução da LLM (modelo, prompt/completion tokens, latência, custo, versão do prompt, versão da política, decisão de revisão) vão para uma **tabela companheira nova** `llm_runs` (migração nova), ligada por FK a `messages`. Writes de `llm_runs` são append-only.
- **D-06:** A decisão de revisão (aprovado/editado/descartado + timestamp + actor) é um **evento append-only**; o `messages.status` do rascunho **não** é mutado retroativamente — o par (rascunho, decisão) é reconstruível a partir de eventos.
  - `[auto] Armazenamento do rascunho — Q: "reusar messages(status='suggested') vs tabela suggestions do ADR-010?" → Selecionado: "reusar messages + tabela companheira llm_runs (recomendado)"`

### Autoridade da FSM e forma de invocação da LLM (sanduíche de 3 camadas)
- **D-07:** O estado autoritativo vive em `conversations.state` (Postgres). A LLM devolve apenas um **hint** de intenção/sinais. A transição é decidida por `resolveNextState(prev, hint, ctx)` — **mapa de transições tipado em código** (per ARCHITECTURE Padrão 1 / `core/orchestrator/transitions.ts`), nunca escolhida pelo modelo. O hint não pode contornar o mapa.
- **D-08:** A invocação é um **sanduíche de 3 camadas em duas chamadas de LLM, em tiers distintos**:
  1. **Camada 1 (modelo barato/rápido):** extrai intenção + sinais estruturados de **toda** mensagem inbound (Zod `Output.object`, inclui **campos-canário** que o modelo deve ecoar para provar aderência ao schema).
  2. **Camada 2 (código local):** `resolveNextState()` + `evaluatePolicy()` decidem de forma determinística, **antes** de qualquer texto ser gerado.
  3. **Camada 3 (modelo forte):** gera o texto da resposta **sob o estado já resolvido**, então o texto não pode propor tópico proibido. Roda menos vezes que a Camada 1.
  - Isto segue ROADMAP 02-01 + STACK §LLM Integration (dois tiers). A variante de **chamada única em envelope** (ARCHITECTURE Padrão 1) fica como alternativa registrada, mas é preterida porque gera o texto *antes* da decisão do código — mais fraco para invariantes AR.
- **D-09:** O enum de intenção separa explicitamente **`pedido_preco`** (→ handoff, AR-001: *pedir* preço/proposta/orçamento) de **`objecao_preco`** (→ contorno consultivo, R-042: *objeção* "está caro"). São gatilhos opostos e não podem colapsar no mesmo valor.
- **D-10:** **Falha-fechada** em toda a camada de LLM: falha de parse Zod, canário divergente, timeout ou erro de provider → 1 reprompt → se persistir, **silêncio + notificação local**. Nunca cair para texto livre. Escolha de provider/modelo é **resultado medido do bake-off**, não congelada aqui.
  - `[auto] Autoridade FSM / forma da LLM — Q: "envelope único vs sanduíche de 3 camadas; hint vs autoridade" → Selecionado: "sanduíche de 3 camadas / dois tiers; código é autoridade (recomendado)"`

### Handoff, silêncio e opt-out
- **D-11:** `HandoffService` escreve, **em uma transação**: `handoff_events` (evento) + `mode_changes` + `conversations.engagement_mode='awaiting_human'` + flag de handoff ativo. Isto **quita P-006** (handoff→`awaiting_human` adiado da Fase 1).
- **D-12:** Gatilhos de handoff conforme skill `handoff-humano`: R-012 (preço/proposta/orçamento/condições), R-056 (lead pergunta se é bot/IA → **silêncio total**), R-065 (dúvida complexa/irritação), R-038 (mídia recebida), FLUP-09. Tratados pela **Camada 2 (código)**, com o classificador de intenção como reforço aditivo — nunca OR-negado.
- **D-13:** No handoff, **silêncio total**: o bot não envia mensagem de handoff/transição e, se o lead perguntar se é bot, **não** nega, **não** admite e **não** desvia. Silêncio na conversa **não** significa silêncio operacional — a **notificação local (som + pop-up)** ao Admin continua disparando.
- **D-14:** Detecção de opt-out (**matcher determinístico pt-BR é autoridade**) + reforço do LLM. Recusa explícita **e** recusa implícita definida (ex.: "para de me mandar", "não quero mais") → `opt_out=true` + linha em `optout_ledger` (append-only, irreversível; coluna com CHECK que nenhum código desfaz). Casos ambíguos → **handoff** para decisão humana, sem auto-opt-out.
- **D-15:** Confirmação humana de handoff é 1 clique/1 comando → grava `handoff_events.human_acknowledged_at`. O bot só volta a falar mediante **ação explícita do Admin**, nunca por timeout.
  - `[auto] Handoff/silêncio/opt-out — Q: "gatilhos, silêncio vs notificação, política de recusa ambígua" → Selecionado: "código autoritativo + silêncio total com notificação local; ambíguo→handoff (recomendado)"`

### Mascaramento de PII e relatório/saída do shadow
- **D-16:** Mascaramento de PII (**telefone + endereço**) antes de qualquer chamada de LLM (ADR-002/012). O **nome do lead é mantido** (dado de negócio público em contexto B2B, base legal = legítimo interesse). Mascaramento concentrado em **um único choke-point do prompt-builder**, não espalhado nos call sites.
- **D-17:** O relatório de shadow é um documento gerado a partir do banco (`npm run shadow:report` → Markdown/HTML): rascunho gerado vs. o que teria sido enviado, decisões do gate, contagem aprovado/editado/descartado, **contagem de alucinações**, revelações de automação, latência e custo de tokens.
- **D-18:** Critérios de saída do shadow (conforme ADR-010) são checados **programaticamente**, mas a transição shadow→ativo exige **aprovação explícita do Admin** — o programa não promove a si mesmo. Shadow é o default da Fase 2 e **nunca envia**.
  - `[auto] Mascaramento PII + saída do shadow — Q: "escopo do mascaramento e critérios de saída" → Selecionado: "mascarar telefone+endereço, manter nome; relatório do banco + aprovação explícita (recomendado)"`

### the agent's Discretion
- Valores numéricos exatos dos critérios de saída do shadow (N de dias, taxa mínima de aprovação, teto de revelações de automação) e do orçamento de qualificação são **discretion** — devem seguir ADR-010/observabilidade e ser confirmados no plano, não nesta discussão.
- Lista de keywords pt-BR de opt-out/irritação e o conjunto adversarial de ~200 mensagens são **discretion** de implementação, desde que o matcher determinístico permaneça a autoridade.
- Nomes exatos de tabelas/colunas (`llm_runs`, campos-canário) são **discretion**, desde que respeitem append-only e FK para `messages`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Roadmap e requisitos da fase
- `.planning/ROADMAP.md` — Fase 2: critérios de sucesso + planos 02-01/02-02/02-03.
- `.planning/REQUIREMENTS.md` — OPRE-04, OPRE-05, LEAD-05, LEAD-06, CONV-01..CONV-10, CONV-12, FLUP-04/05/07/09/10, CRM-02, COMP-01, NFRQ-03.
- `docs/01-requisitos-funcionais.md` — R-001 a R-067 (texto canônico).
- `docs/09-criterios-de-aceitacao.md` — critérios de aceitação verificáveis.

### ADRs que governam esta fase
- `docs/08-adr/002-ia-externa.md` — IA externa como extratora/geradora, nunca dona do estado; mascaramento de PII.
- `docs/08-adr/010-shadow-mode.md` — shadow mode, tabela de sugestões, critérios de saída (a linha "suggestions table" é superseded por D-04).
- `docs/08-adr/012-prompt-persona.md` — persona/prompt, tom consultivo, enquadramento anti-tópicos-proibidos.
- `docs/08-adr/004-gate-invariantes.md` — gate de envio com os 12 anti-requisitos como invariantes de código.
- `docs/08-adr/009-follow-up-conservador.md` — cadência conservadora + dreno jittered (contexto para FLUP-*, Fase 3).
- `docs/08-adr/001-pin-baileys-rc14.md` — pin do canal (contexto, não decisão desta fase).
- `docs/10-anti-requisitos.md` — AR-001..AR-012, ordem canônica.

### Pesquisa que fundamenta as decisões
- `.planning/research/ARCHITECTURE.md` — Padrão 1 (FSM hintada/transições em código), Padrão 4 (sugestões em `messages`), chokepoint único de envio, vazamento de vocabulário Baileys.
- `.planning/research/STACK.md` — AI SDK 7 + `Output.object` + Zod; dois tiers de modelo; sanduíche de guardrails L1–L6.
- `.planning/research/PITFALLS.md` — riscos de prompt-injection/hallucination e falha-fechada.
- `.planning/research/FEATURES.md`, `.planning/research/SUMMARY.md` — escopo e features do produto.

### Skills (fonte de verdade comportamental)
- `.ruler/skills/handoff-humano/SKILL.md` — gatilhos, silêncio obrigatório, notificação, modo copiloto.
- `.ruler/skills/ia-conversa-consultiva/SKILL.md` — tom consultivo, qualificação dinâmica, contorno de objeção.
- `.ruler/skills/lgpd-optout/SKILL.md` — opt-out, base legal, registro de origem, retenção/exclusão.
- `.ruler/skills/follow-up-cadencia/SKILL.md` — cadência e encerramento (contexto para FLUP-*).
- `.ruler/skills/crm-pipeline/SKILL.md` — status do pipeline e atualização automática pela IA (CRM-02).

### Prior context (fase 1)
- `.planning/phases/01-funda-o-canal-e-gate-de-envio/01-CONTEXT.md` — invariantes travadas, deferrals (incl. chime → Fase 3).
- `.planning/STATE.md` — progresso, P-004/P-005/P-006.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/domain/gate/evaluate-policy.ts` + `GUARD_ORDER` (15 entradas canônicas): a decisão de envio já existe e roda antes da LLM; a Fase 2 **consome** essa decisão (em shadow ela vira "não enviar, persistir rascunho").
- `src/domain/gate/types.ts` — `GateReason` (inclui `kill_switch_ativo`, `envio_sem_gate`, `timeout`, `erro_nao_mapeado`, `ar001..ar012`) e `GateInput`; use os motivos existentes para o kill switch e a saída do shadow.
- `src/application/dispatcher.ts` — choke-point único; único lugar autorizado a chamar `sendText`. Em shadow, a nova rota **não** chega aqui.
- `src/application/inbound-handler.ts` — ponto de entrada de inbound; é onde a Camada 1 (extração) e a Camada 2 (resolução/registro) devem se acoplar.
- `src/application/event-bus.ts` — canais `inbound`/`signal`/`clock` já definidos; use para desacoplar geração de rascunho e notificação.
- `src/domain/ports/` — `ChannelPort`, `NotifyPort`, `ClockPort`, `LeadSourcePort`: o padrão de porta/adaptador a replicar para o novo `LlmPort`.
- `src/domain/ports/NotifyPort.ts` — abstração já existente para o `notify.ps1` (som + pop-up) do handoff.

### Established Patterns
- **Fail-closed** em toda a cadeia: já é o comportamento do gate; a camada de LLM deve seguir o mesmo padrão (erro → silêncio + evento, nunca envio não sanitizado).
- **Append-only**: `messages`, `handoff_events`, `mode_changes`, `blocked_attempts`, `optout_ledger`, `event_log`. Rascunhos, decisões de revisão e `llm_runs` devem seguir.
- **Porta/adaptador** para toda integração externa (canal, notificação, clock, fonte de leads) — replicar para LLM.
- **Estado autoritativo no Postgres, IA como sinal**: a Fase 1 já proibiu a IA de dirigir o fluxo; manter.
- **Anti-requisitos como código, não prompt**: nenhum AR pode depender de aderência do modelo.

### Integration Points
- `src/infra/db/schema.ts` — 15 tabelas (`conversations`, `messages`, `handoff_events`, `mode_changes`, `optout_ledger`, `status_history`, `event_log`, `settings`, `daily_counters`, ...); novas migrações para `llm_runs` e campos/metadados de sugestão. Migrações em `src/infra/db/migrations/`.
- `conversations.state` — onde o estado da FSM vive; a Camada 2 escreve aqui.
- `conversations.engagement_mode` / flag de handoff — onde `awaiting_human` aterrissa (D-11).
- `messages.origin`/`status` — onde rascunho de IA aterrissa (`origin='ai_suggestion'`, `status='suggested'`, D-04).
- `settings` / `mode_changes` — onde o kill switch e a promoção shadow→ativo são registrados (D-02, D-18).

</code_context>

<specifics>
## Specific Ideas

- **Sanduíche de 3 camadas** com texto gerado *depois* da decisão de código (D-08) — princípio explícito para impedir vazamento de tópico proibido pelo modelo.
- **Campos-canário** no schema Zod de saída para detectar prompt-injection / desvio de schema.
- **Separação dura `pedido_preco` vs `objecao_preco`** no enum de intenção (D-09) — espelha a fronteira AR-001 (handoff) x R-042 (contornar).
- **`llm_runs`** como tabela de custo/latência/observabilidade da IA, separada do conteúdo.
- **Relatório de shadow gerado do banco** (`npm run shadow:report`) como instrumento do gate de saída da fase.

</specifics>

<deferred>
## Deferred Ideas

- **Chime Web Audio de redundância da notificação** — ROADMAP 02-02 cita como redundância, mas a Fase 1 (01-CONTEXT) adiou o chime para a Fase 3 (não há painel/browser até lá para tocar Web Audio). Resolução: notificação na Fase 2 = `notify.ps1` (som + pop-up); chime redundante fica para a Fase 3. **Conflito de roadmap marcado como resolvido** — o planner deve ajustar 02-02 para não exigir o chime.
- **Painel HTTP/React de revisão** — pertence à Fase 3 (R-046); nesta fase só CLI.
- **Cadência completa de follow-up e dreno jittered** (ADR-009) — Fase 3; a Fase 2 só toca FLUP-04/05/07/09/10 na medida da decisão de estado/handoff.
- **Migração para API oficial do WhatsApp** — fase futura.
- **Escolha definitiva de provider/modelo de LLM** — decidida pelo bake-off, não nesta fase.

</deferred>

---

*Phase: 2-IA, Handoff e Shadow Mode*
*Context gathered: 2026-10-13*
