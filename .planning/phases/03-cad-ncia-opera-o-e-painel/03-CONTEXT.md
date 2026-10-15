# Phase 3: Cadência, Operação e Painel - Context

**Gathered:** 2026-10-15
**Status:** Ready for planning

> **Nota de modo (`--auto`, 2026-10-15):** discussão conduzida em **passada única**. Todas as áreas cinzentas foram auto-selecionadas e a opção recomendada foi escolhida sem `question`, apenas para o registro de auditoria (ver `03-DISCUSSION-LOG.md`). As decisões travadas nas Fases 1 e 2 (`01-CONTEXT.md`, `02-CONTEXT.md` D-01..D-23) **não foram re-litigadas** — a Fase 3 as **consome**. Uma tensão real no ROADMAP (03-01 "máx. 2 toques" × SC1/FLUP-03 "4 toques") foi **resolvida** e registrada como supersession (D-02).

<domain>
## Phase Boundary

Fazer o bot **rodar sozinho dentro dos limites** e dar ao Admin **um único lugar** para operar, auditar e corrigir. A Fase 3 fecha o ciclo operacional que as Fases 1 (fundação + gate) e 2 (IA + handoff + shadow) prepararam:

1. **Cadência conservadora de follow-up** — 1h → 1d → 3d → 7d, no máximo 4 toques, encerrando "sem resposta" no 7º dia; interrompida por resposta, opt-out, handoff ou pausa. Dreno de misfire `FIRE_ONCE` com limite e jitter (nunca rajada).
2. **Scheduler e relógio de negócio** — tick de 30s com idempotência, `business-hours.ts` enriquecido com feriados BR e "próximo dia útil"; janela dias úteis 7h–17h como fronteira dura.
3. **Painel único local** (Fastify + SSE + React em `127.0.0.1`) — lista + chat + sugestões + histórico imutável + modo em tempo real + contador + janela + fila de handoff + ações rápidas + kill switch.
4. **CRM operacional e copiloto** — pipeline de 9 status com motivos, tags/notas/tarefas/lembretes, busca/filtros, notas automáticas da IA, copiloto pós-handoff (sugere, nunca envia) e confirmação/lembrete pós-agendamento.

**Entra nesta fase:** WHS-02, FLUP-01, FLUP-02, FLUP-03, FLUP-06, FLUP-08, CRM-01, CRM-03, NFRQ-05.

**NÃO entra nesta fase:** envio real do 1º contato / canal físico já pareado (P-004, Fase 1 — dependência, não escopo); break-up message (FLUP-11, v2/Fase 4); migração para API oficial (v2); multiusuário ativo (v2/EQUP); analytics avançado e relatórios além do contador diário (v2); aquecimento controlado (v2); Electron/Tauri (fase futura); contrato visual detalhado do painel (`/gsd-ui-phase` é o próximo passo de UI, não esta discussão).

**Regra-mestra herdada (invariante de ordem):** `evaluatePolicy` continua sendo o **único** gate e roda **antes** de qualquer envio; `sendText` continua existindo **só** no choke-point `src/application/dispatcher.ts`. A Fase 3 **não** cria caminho de envio novo — o painel envia **pelo gate**, com `origin='admin'`.
</domain>

<decisions>
## Implementation Decisions

### Motor de cadência e scheduler (03-01)
- **D-01:** A cadência é **ancorada no último toque** (`last_outbound_at`), não em horário fixo: após o toque *n*, o follow-up *n+1* é agendado em `+1h / +1d / +3d / +7d` (ADR-009/RN-015). `conversations.follow_up_index` é o **cursor** (avança a cada toque). Qualquer **mensagem inbound** do lead zera a cadência (D-12).
- **D-02 (supersession):** O máximo é de **4 tentativas** (FLUP-03 + ROADMAP SC1), encerrando "sem resposta" no 7º dia. O texto do plano `03-01` ("default conservador — máx. 2 toques automáticos sem resposta → handoff") fica **superseded**: o número de toques é configurável em `settings.followup.max_touches` (**default 4**, teto 4), nunca um caminho silencioso para menos. *(Resolve a única contradição interna do ROADMAP da Fase 3.)*
- **D-03:** Desenho de duas camadas, reaproveitando o que já é durável e testado:
  - **`scheduled_tasks` = ledger auditável do agendamento** — a fonte de verdade "o que estava agendado, quando disparou, e por que foi cancelado" (`task_type`, `scheduled_for`, `status`, `cancelled_at`, `cancelled_reason` já existem). Um follow-up cancelado por opt-out/handoff/pausa **não** some: vira linha cancelada com motivo.
  - **`outbox` = a fila de envio gateada** — `origin='followup'` (e `'catchup'` no dreno de misfire). Reusa o que já existe e é à prova de banimento: `idempotency_key UNIQUE`, `FOR UPDATE SKIP LOCKED`, `requeueStale` (lease), reavaliação do gate a cada job (`dispatch` sempre com snapshot fresco).
  - **Não se adota `pg-boss` nesta fase.** O `outbox` já implementa SKIP LOCKED + lease + idempotência + re-gate; `pg-boss` adicionaria dependência e uma quarta superfície sem resolver nada que o `outbox` não resolva para um operador único.
- **D-04:** O scheduler é um **tick `croner` de 30s** no **mesmo processo** (padrão já usado por `drainLoop` e `health-monitor`; single-instance, sem lease distribuído). O tick: (a) avança a cadência (escreve `scheduled_tasks` + enfileira no `outbox`), (b) cancela `scheduled_tasks` pendentes e abandona os jobs correspondentes quando a cadência é interrompida, (c) roda o **reconciliador** (varredura de órfãos: conversa em cadência sem `scheduled_tasks` pendente → recria; `scheduled_tasks` cujo job no `outbox` já é terminal → fecha o ledger).
- **D-05:** **Idempotência** por `(conversation_id, follow_up_index)` (índice único parcial em `scheduled_tasks`) e `idempotency_key = 'flup:{conversationId}:{index}'` no `outbox`. Dois ticks concorrentes não criam dois agendamentos nem dois envios (as outras duas barreiras de duplicata do `outbox`/`messages` continuam valendo).
- **D-06:** **Misfire `FIRE_ONCE` por tipo** (`CATCH_UP` **proibido**): um follow-up cujo horário passou enquanto o app estava fechado dispara **uma única vez** na próxima janela válida — nunca um replay de todas as ocorrências perdidas.
- **D-07:** **Dreno de catch-up** (WHS-02/R-007), tratado como o risco operacional dominante (RAJADA = padrão de banimento): limites duros — no máximo **3 envios de catch-up nos primeiros 10 min**; **1 follow-up por lead por dia de drenagem**; jitter 3–12s (via `humanize`); `origin='catchup'`; e o restante é **adiado, nunca descartado** (reusa `markDeferred` → próxima janela). `isCatchupDrain` é um **parâmetro booleano threadado do boot** (decisão do ADR-009) — **não** um modo global escondido em `settings`.
- **D-08:** **R-001 reforçado no scheduler:** contato frio **nunca** é automatizado. O scheduler só age sobre conversas **já em cadência** (cuja 1ª mensagem humana já foi enviada). O bot jamais inicia conversa.

### Janela de negócio, feriados e "próximo dia útil" (03-01)
- **D-09:** **Feriados BR** resolvidos **localmente** (sem API externa): lista versionada in-repo (`src/domain/feriados-br.ts`) com feriados nacionais **fixos** + **móveis** (derivados da Páscoa: Carnaval, Sexta-feira Santa, Corpus Christi), com **override manual** via `settings.calendar.holidays`. `ehDiaUtil` passa a considerar feriado; `nextWindow` **pula** feriado e fim de semana.
- **D-10:** **"Próximo dia útil"** definido pelo negócio: vencimento em fim de semana/feriado/fora da janela → reprograma para o **próximo dia útil às 07:00** no fuso da conversa (`conversations.timezone`, default `America/Sao_Paulo`). A definição é **documentada** (é uma decisão de produto, não um detalhe de código).
- **D-11 (reconciliação RN-009 × AR-007/R-058):** o dreno "ao abrir o app" (RN-009) só **envia dentro da janela** 7h–17h em dia útil. Abrir o app **fora** da janela apenas **enfileira** — não envia. O texto do RN-009 é reconciliado no doc de regras (03-03), porque "enviado ao abrir o app mesmo fora da janela" contradiz a fronteira dura AR-007/R-058.

### Detecção de não-resposta e encerramento (03-01)
- **D-12:** **Resposta = mensagem inbound do lead.** Read receipts **não** contam (são não confiáveis no canal tctoken/LID) e **não** resetam a cadência. O watermark de silêncio é `conversations.last_inbound_at`.
- **D-13:** **Encerramento:** após a 4ª tentativa (7d) sem inbound → cadência encerrada e lead marcado **PERDIDO** com motivo `sem_resposta` (RN-021/RN-084), com transição registrada em `status_history`. A reativação é manual (D-16).

### Modelo de pipeline/status (03-03)
- **D-14:** O **pipeline de 9 status** (RN-078: Novo → Contatado → Respondeu → Qualificado → Aquecido → Reunião agendada → Proposta → Fechado → Perdido) vive em **`conversations.pipeline_status`** (coluna nova com CHECK dos 9 valores; default `novo`), **separado** de `conversations.state` (FSM do motor, D-07 da Fase 2) e de `conversations.stage` (sub-estágio de qualificação). Toda transição é **append-only** em `status_history` (from/to/reason/changed_by já existem).
- **D-15:** **Motivos de "Perdido"** enumerados em `conversations.closed_reason`: `sem_resposta`, `sem_interesse`, `sem_verba`, `sem_decisao`, `concorrente`, `fora_do_perfil`, `opt_out`, `bad_timing`, `outro`. Status críticos (Reunião agendada/Proposta/Fechado/Perdido) **exigem justificativa** (RN-082).
- **D-16:** **Reativação** Perdido → Novo é **manual** (RN-085) e auditada em `status_history`. `opt_out` é **terminal e irreversível** — nunca reativa, nem por correção manual (reforça AR-005).

### Painel único (03-02)
- **D-17:** Stack do painel: **Fastify** (servidor único, bind `127.0.0.1`) + **SSE** para tempo real + SPA **React** (build via Vite) servida pelo **mesmo processo/porta** via `@fastify/static`. Sem CORS (mesma origem), sem Electron/Tauri. As dependências (`fastify`, `@fastify/static`, `react`, `vite`) **entram** nesta fase.
- **D-18:** Segurança do painel: bind **`127.0.0.1`** (**nunca** `0.0.0.0`), **validação do header `Host`**, **token único por request** (Bearer em header; token de `.env`, **nunca** em `settings`), sem CORS, single-user. R-033 aceita "sem criptografia" para dados em repouso; isso **não** autoriza expor o banco LGPD à LAN.
- **D-19:** **Layout em 3 colunas** (ADR-011): lista de leads | conversa (chat) | ações/sugestões/copiloto. Cabeçalho com **modo em tempo real** ("BOT ATIVO" vs "MÃO HUMANA ATIVA — BOT EM SILÊNCIO"), **motivo do silêncio**, **contador diário**, **janela operacional** e **fila de handoff**.
- **D-20:** **Kill switch no painel:** botão com **confirmação explícita** (type-to-confirm) que aciona o **mesmo** `settings.operational_mode='paused'` da Fase 2 (D-19), auditado em `event_log`. **Mesma fonte de verdade** do CLI `mode` — nunca um estado paralelo em memória.
- **D-21:** **Chime Web Audio** de redundância da notificação (deferido da Fase 2, agora viável porque há browser): o painel toca o chime quando um handoff chega via SSE. O `notify.ps1` (som + pop-up) continua sendo a notificação **primária**; o chime é redundância no navegador.

### CRM operacional e copiloto (03-03)
- **D-22:** Estruturas novas de CRM: **`tags` + `lead_tags`** (N:N), **`lead_notes`** (notas do Admin e notas **automáticas da IA** — `author_type='admin'|'ia'`, append-only), **`tasks`** (tarefas/lembretes: título, `due_at`, status, `responsible_user_id` nullable). Busca/filtros **server-side** por nome/telefone/`pipeline_status`/tags, paginados.
- **D-23:** **Histórico imutável** no painel: lê `messages` (append-only), `status_history`, `handoff_events` e `blocked_attempts` — **read-only**; nenhuma edição/exclusão pela UI.
- **D-24:** **Modo copiloto pós-handoff** (FLUP-06/RN-054): em `copilot`, o painel exibe **sugestões da IA** (geradas via `LlmPort`, persistidas como `messages(origin='ai_suggestion')`); o Admin pode **aceitar/editar/ignorar**; **enviar só por ação explícita** e o envio passa pelo **mesmo gate** com `origin='admin'`. O bot **nunca** envia sozinho em copiloto.
- **D-25:** **Confirmação/lembrete pós-agendamento** (FLUP-08/RN-059..062): o Admin registra o agendamento no painel (data/hora/canal) → o sistema agenda `scheduled_tasks` tipo `confirmacao` e `lembrete` → enfileira no `outbox` (`origin='bot'`) → gate (janela/limite). Resposta do lead pedindo **remarcar/cancelar** → **handoff** (R-025/AR-003). **Sem** integração de calendário externa — o agendamento é manual.

### Documentação, ADRs e reconciliação (03-03)
- **D-26:** Novos ADRs em `docs/08-adr/`: **`014-scheduler-cadencia.md`** e **`015-pipeline-crm-copiloto.md`** (numeração após o `013` existente). **ADR-009 permanece a autoridade** da cadência. Migração de doc: `docs/01-requisitos-funcionais.md` (R-004/R-005/R-058) e `docs/03-regras-de-negocio.md` (RN-009, D-11) reconciliados com o ADR-009 e com as decisões acima; `isCatchupDrain` documentado **como parâmetro** (D-07).

### the agent's Discretion
Áreas deixadas em aberto para pesquisa/planejamento, sem mudar contrato:
- Valores exatos de `settings.followup.*` (jitter, limites do dreno, tamanho de lote do tick) — desde que os tetos de D-02/D-07 permaneçam.
- Conteúdo literal das mensagens de follow-up (variadas, RN-019) e das mensagens de confirmação/lembrete — desde que respeitem ADR-012 e os AR como código.
- Fonte/forma exata da lista de feriados (fixos + móveis) e o formato de `settings.calendar.holidays` — desde que seja local (D-09) e testável.
- Detalhes de transporte/estrutura do SSE, nomes de endpoints e o desenho visual fino do painel (o **contrato visual** é responsabilidade do `/gsd-ui-phase`).
- Modelagem fina das tabelas `lead_notes`/`tasks`/`tags` (nomes, índices) — desde que append-only onde couber e com `responsible_user_id` nullable (R-028).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Roadmap e requisitos da fase
- `.planning/ROADMAP.md` §"Phase 3: Cadência, Operação e Painel" — goal, requirements (WHS-02, FLUP-01/02/03/06/08, CRM-01/03, NFRQ-05), SC1–SC5 e os 3 planos 03-01/03-02/03-03.
- `.planning/REQUIREMENTS.md` — WHS-02, FLUP-01, FLUP-02, FLUP-03, FLUP-06, FLUP-08, CRM-01, CRM-03, NFRQ-05 (texto canônico dos REQ-IDs).
- `docs/01-requisitos-funcionais.md` — R-001 a R-067 (texto canônico; R-004/R-005/R-058 são alvo de reconciliação em 03-03).
- `docs/03-regras-de-negocio.md` — RN-001..RN-110 (RN-009 é reconciliado por D-11; RN-015..021, RN-057..062, RN-078..085 governam esta fase).
- `docs/09-criterios-de-aceitacao.md` — critérios de aceitação verificáveis.

### ADRs que governam esta fase
- `docs/08-adr/009-follow-up-conservador.md` — **autoridade** da cadência (1h/1d/3d/7d, 4 tentativas, janela, dreno jittered, `isCatchupDrain` como parâmetro).
- `docs/08-adr/011-painel-unico.md` — painel único, 3 colunas, indicador de modo (AUTO/COPILOTO/PAUSADO/SILÊNCIO), kill switch, notificação local.
- `docs/08-adr/004-gate-invariantes.md` — gate único e os 12 anti-requisitos como invariantes de código (o painel envia pelo gate).
- `docs/08-adr/002-ia-externa.md` — IA como extratora/geradora; copiloto segue a mesma porta.
- `docs/10-anti-requisitos.md` — AR-001..AR-012 (ordem canônica).
- `docs/08-adr/008-preparacao-multiplos-numeros.md` — preparação (não escopo) para múltiplos números.
- ADRs **novos** a criar nesta fase: `docs/08-adr/014-scheduler-cadencia.md`, `docs/08-adr/015-pipeline-crm-copiloto.md` (D-26).

### Pesquisa que fundamenta a fase
- `.planning/research/ARCHITECTURE.md` — chokepoint único de envio, padrões de fila/scheduler, "estado autoritativo no Postgres".
- `.planning/research/STACK.md` — Fastify + `@fastify/static` + React/Vite localhost, SSE, `pg-boss` como decisão de stack (avaliado e **não** adotado nesta fase — D-03), `p-queue`/`croner`.
- `.planning/research/PITFALLS.md` — misfire/rajada, exposição de rede, PII em log.
- `.planning/research/FEATURES.md`, `.planning/research/SUMMARY.md` — escopo e features do produto.

### Skills (fonte de verdade comportamental)
- `.ruler/skills/follow-up-cadencia/SKILL.md` — cadência, encerramento, tratamento fora da janela.
- `.ruler/skills/crm-pipeline/SKILL.md` — pipeline, atualização automática pela IA, tags/filtros/notas/tarefas/responsável.
- `.ruler/skills/handoff-humano/SKILL.md` — modo copiloto pós-handoff (sugere, nunca envia).
- `.ruler/skills/lgpd-optout/SKILL.md` — opt-out irreversível (não reativar).
- `.ruler/skills/whatsapp-baileys/SKILL.md` — limites/janela do canal (contexto).

### Prior context (fases 1 e 2)
- `.planning/phases/02-ia-handoff-e-shadow-mode/02-CONTEXT.md` — D-01..D-23 (kill switch `settings.operational_mode`; FSM; handoff; shadow; chime deferido → **entra** nesta fase).
- `.planning/phases/02-ia-handoff-e-shadow-mode/02-DISCUSSION-LOG.md` — alternativas consideradas na Fase 2.
- `.planning/phases/02-ia-handoff-e-shadow-mode/deferred-items.md` (se existir) e `.planning/phases/01-funda-o-canal-e-gate-de-envio/deferred-items.md` — P-004/P-005/P-006 e deferrals (chime → Fase 3).
- `.planning/STATE.md` — progresso (2/4 fases) e pendências.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/application/outbox.ts` — a fila durável: `enqueue` (idempotency_key UNIQUE + `ON CONFLICT DO NOTHING`), `reserveNext` (`FOR UPDATE SKIP LOCKED`), `markSent`/`markFailed`/`markDeferred`/`abandon`, `requeueStale` (lease). **É a fila de envio da cadência** (D-03).
- `src/application/outbox-worker.ts` — `drainOnce`/`drainLoop(30s)` com reavaliação do gate a cada job; reusa o padrão de tick do scheduler (D-04).
- `src/domain/business-hours.ts` — `ehDiaUtil`, `isWithinWindow`, `nextWindow` (fim de semana), `formatarHoraLocal`; ponto de extensão para **feriados BR** (D-09/D-10).
- `src/application/dispatcher.ts` — choke-point único de `sendText`; o painel/copiloto enviam **por aqui**, com `origin='admin'` (D-24).
- `src/application/handoff-service.ts` + `src/infra/db/queries/snapshot.ts` + `src/domain/gate/kill-switch.ts` — handoff e kill switch (`settings.operational_mode`); o botão do painel reusa (D-20).
- `src/application/event-bus.ts` — canais `inbound`/`signal`/`clock`; base para o pipeline de eventos que alimenta o SSE do painel.
- `src/application/humanize.ts` + `queue-per-lead.ts` — jitter/typing/ordem por lead já implementados (usados pelo dreno de catch-up, D-07).
- `src/application/inbound-handler.ts`, `lead-importer.ts`, `shadow.ts` — entradas de inbound, importação de lead e fluxo de rascunho (copiloto reusa `shadow.ts`/`messages(origin='ai_suggestion')`).
- `src/infra/db/queries/` — `snapshot.ts`, `counters.ts` (contador diário), `status-history.ts`, `daily-report.ts`, `leads.ts`, `llm-runs.ts`, `review-events.ts`, `blocked-attempts.ts` — leituras prontas para o painel.
- `src/cli/` — `mode.ts` (kill switch global), `status.ts`, `handoff.ts`, `shadow.ts`: padrão de CLI a espelhar; o painel **não** substitui o CLI.
- `src/infra/db/schema.ts` — tabelas reutilizadas: `outbox`, `scheduled_tasks`, `conversations` (`follow_up_index`, `last_inbound_at`, `last_outbound_at`, `stage`, `closed_reason`), `daily_counters`, `status_history`, `handoff_events`, `blocked_attempts`, `event_log`, `mode_changes`, `settings`, `leads`, `messages`. Migrações em `src/infra/db/migrations/` (última: `0006_shadow_and_llm_runs.sql`).

### Established Patterns
- **Chokepoint único de envio** — `sendText` só em `dispatcher.ts`, garantido por grep-test; nenhum caminho novo de envio (painel/copiloto passam pelo gate).
- **Gate reavaliado a cada job** — entre enfileirar e drenar, opt-out/handoff/janela podem mudar; o worker nunca envia sem snapshot fresco.
- **Append-only** — `messages`, `handoff_events`, `mode_changes`, `blocked_attempts`, `optout_ledger`, `event_log`, `llm_runs`, `review_events`; notas de IA e histórico do painel seguem.
- **Idempotência por chave + SKIP LOCKED** — três barreiras de duplicata; a cadência reusa e adiciona a chave `flup:{conversation}:{index}` (D-05).
- **Fail-closed** — erro/timeout/parse inválido → silêncio + notificação, nunca envio não sanitizado.
- **Estado autoritativo no Postgres, IA como sinal** — vale para pipeline_status (D-14) e copiloto (D-24).
- **Porta/adaptador** para toda integração; **log estruturado com `redact`** (nunca corpo de conversa em log).

### Integration Points
- `src/infra/db/schema.ts` + migração nova (~`0007`) — `conversations.pipeline_status`, colunas/índice de `scheduled_tasks`, `tags`/`lead_tags`/`lead_notes`/`tasks` (D-14, D-22).
- `src/domain/business-hours.ts` — feriados BR + "próximo dia útil" (D-09/D-10).
- Novo scheduler (tick `croner`) — lê `conversations`/`scheduled_tasks`, enfileira em `outbox`, roda o reconciliador (D-04).
- Novo `src/api/` (Fastify + SSE) + SPA React — bind `127.0.0.1`, token + validação de `Host`, servindo o painel (D-17/D-18).
- `settings` (`operational_mode`, `followup.*`, `calendar.holidays`) e `event_log`/`mode_changes` — kill switch e auditoria do painel (D-20).
</code_context>

<specifics>
## Specific Ideas

- **Duas camadas, uma fila:** `scheduled_tasks` = ledger auditável do agendamento; `outbox` = fila gateada. Reusar o `outbox` (SKIP LOCKED + lease + re-gate) em vez de adotar `pg-boss` (D-03).
- **Dreno de misfire é o risco dominante:** `FIRE_ONCE`, ≤3 nos primeiros 10 min, 1 follow-up/lead/dia de drenagem, jitter — e **adiar, nunca descartar** (D-06/D-07).
- **`isCatchupDrain` como parâmetro booleano**, não um modo global escondido (ADR-009/D-07).
- **Feriados BR locais e testáveis** (`feriados-br.ts` + override em `settings`), sem API externa (D-09).
- **Modo em tempo real explícito** no painel ("BOT ATIVO" vs "MÃO HUMANA ATIVA — BOT EM SILÊNCIO" + motivo) — a leitura que o Admin mais precisa (D-19).
- **Copiloto nunca envia sozinho:** sugestão vira `messages(origin='ai_suggestion')`; envio só por ação explícita, pelo gate, `origin='admin'` (D-24).
- **Agendamento 100% manual:** o bot só confirma/lembra o que o Admin registrou; remarcar/cancelar → handoff (D-25).
</specifics>

<deferred>
## Deferred Ideas

- **Break-up message no encerramento "sem resposta"** (FLUP-11, v2) — decisão com dado do piloto (Fase 4); não muda R-005 agora.
- **Migração para a API oficial do WhatsApp** (R-016) — fase futura.
- **Multiusuário ativo** (R-027/EQUP) — v2; esta fase mantém `responsible_user_id` nullable e um único operador.
- **Analytics avançado / relatórios além do contador diário e da apuração de Fase 4** — v2.
- **Aquecimento controlado / 5 fases** (R-039/R-040) — fora do MVP (R-060).
- **Electron/Tauri** como shell desktop — fase futura; o painel é localhost no browser.
- **Contrato visual detalhado do painel** — tratado pelo `/gsd-ui-phase` (UI hint = yes), não nesta discussão.

**Dependência operacional (não é escopo, é risco):** o pareamento físico do número dedicado (P-004, `01-03` deferido) ainda está pendente. A Fase 3 assume o canal operacional; o dreno de misfire e a cadência só têm valor com o número pareado.
</deferred>

---

*Phase: 3-Cadência, Operação e Painel*
*Context gathered: 2026-10-15 (`--auto`, passada única)*
