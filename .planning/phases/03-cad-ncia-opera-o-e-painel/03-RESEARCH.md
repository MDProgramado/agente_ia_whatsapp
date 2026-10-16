# Phase 3: Cadência, Operação e Painel - Research

**Researched:** 2026-10-15
**Domain:** Node.js/TypeScript — scheduler durável sobre PostgreSQL, painel Fastify+SSE+React localhost, CRM operacional
**Confidence:** HIGH (arquitetura/invariantes) · MEDIUM (versões de pacotes novos de UI) · LOW (nada de bloqueio)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

Copiadas verbatim de `03-CONTEXT.md`. **O pesquisador NÃO re-litiga nenhuma delas.**

**Motor de cadência e scheduler (03-01)**
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

**Janela de negócio, feriados e "próximo dia útil" (03-01)**
- **D-09:** **Feriados BR** resolvidos **localmente** (sem API externa): lista versionada in-repo (`src/domain/feriados-br.ts`) com feriados nacionais **fixos** + **móveis** (derivados da Páscoa: Carnaval, Sexta-feira Santa, Corpus Christi), com **override manual** via `settings.calendar.holidays`. `ehDiaUtil` passa a considerar feriado; `nextWindow` **pula** feriado e fim de semana.
- **D-10:** **"Próximo dia útil"** definido pelo negócio: vencimento em fim de semana/feriado/fora da janela → reprograma para o **próximo dia útil às 07:00** no fuso da conversa (`conversations.timezone`, default `America/Sao_Paulo`). A definição é **documentada** (é uma decisão de produto, não um detalhe de código).
- **D-11 (reconciliação RN-009 × AR-007/R-058):** o dreno "ao abrir o app" (RN-009) só **envia dentro da janela** 7h–17h em dia útil. Abrir o app **fora** da janela apenas **enfileira** — não envia. O texto do RN-009 é reconciliado no doc de regras (03-03), porque "enviado ao abrir o app mesmo fora da janela" contradiz a fronteira dura AR-007/R-058.

**Detecção de não-resposta e encerramento (03-01)**
- **D-12:** **Resposta = mensagem inbound do lead.** Read receipts **não** contam (são não confiáveis no canal tctoken/LID) e **não** resetam a cadência. O watermark de silêncio é `conversations.last_inbound_at`.
- **D-13:** **Encerramento:** após a 4ª tentativa (7d) sem inbound → cadência encerrada e lead marcado **PERDIDO** com motivo `sem_resposta` (RN-021/RN-084), com transição registrada em `status_history`. A reativação é manual (D-16).

**Modelo de pipeline/status (03-03)**
- **D-14:** O **pipeline de 9 status** (RN-078: Novo → Contatado → Respondeu → Qualificado → Aquecido → Reunião agendada → Proposta → Fechado → Perdido) vive em **`conversations.pipeline_status`** (coluna nova com CHECK dos 9 valores; default `novo`), **separado** de `conversations.state` (FSM do motor, D-07 da Fase 2) e de `conversations.stage` (sub-estágio de qualificação). Toda transição é **append-only** em `status_history` (from/to/reason/changed_by já existem).
- **D-15:** **Motivos de "Perdido"** enumerados em `conversations.closed_reason`: `sem_resposta`, `sem_interesse`, `sem_verba`, `sem_decisao`, `concorrente`, `fora_do_perfil`, `opt_out`, `bad_timing`, `outro`. Status críticos (Reunião agendada/Proposta/Fechado/Perdido) **exigem justificativa** (RN-082).
- **D-16:** **Reativação** Perdido → Novo é **manual** (RN-085) e auditada em `status_history`. `opt_out` é **terminal e irreversível** — nunca reativa, nem por correção manual (reforça AR-005).

**Painel único (03-02)**
- **D-17:** Stack do painel: **Fastify** (servidor único, bind `127.0.0.1`) + **SSE** para tempo real + SPA **React** (build via Vite) servida pelo **mesmo processo/porta** via `@fastify/static`. Sem CORS (mesma origem), sem Electron/Tauri. As dependências (`fastify`, `@fastify/static`, `react`, `vite`) **entram** nesta fase.
- **D-18:** Segurança do painel: bind **`127.0.0.1`** (**nunca** `0.0.0.0`), **validação do header `Host`**, **token único por request** (Bearer em header; token de `.env`, **nunca** em `settings`), sem CORS, single-user. R-033 aceita "sem criptografia" para dados em repouso; isso **não** autoriza expor o banco LGPD à LAN.
- **D-19:** **Layout em 3 colunas** (ADR-011): lista de leads | conversa (chat) | ações/sugestões/copiloto. Cabeçalho com **modo em tempo real** ("BOT ATIVO" vs "MÃO HUMANA ATIVA — BOT EM SILÊNCIO"), **motivo do silêncio**, **contador diário**, **janela operacional** e **fila de handoff**.
- **D-20:** **Kill switch no painel:** botão com **confirmação explícita** (type-to-confirm) que aciona o **mesmo** `settings.operational_mode='paused'` da Fase 2 (D-19), auditado em `event_log`. **Mesma fonte de verdade** do CLI `mode` — nunca um estado paralelo em memória.
- **D-21:** **Chime Web Audio** de redundância da notificação (deferido da Fase 2, agora viável porque há browser): o painel toca o chime quando um handoff chega via SSE. O `notify.ps1` (som + pop-up) continua sendo a notificação **primária**; o chime é redundância no navegador.

**CRM operacional e copiloto (03-03)**
- **D-22:** Estruturas novas de CRM: **`tags` + `lead_tags`** (N:N), **`lead_notes`** (notas do Admin e notas **automáticas da IA** — `author_type='admin'|'ia'`, append-only), **`tasks`** (tarefas/lembretes: título, `due_at`, status, `responsible_user_id` nullable). Busca/filtros **server-side** por nome/telefone/`pipeline_status`/tags, paginados.
- **D-23:** **Histórico imutável** no painel: lê `messages` (append-only), `status_history`, `handoff_events` e `blocked_attempts` — **read-only**; nenhuma edição/exclusão pela UI.
- **D-24:** **Modo copiloto pós-handoff** (FLUP-06/RN-054): em `copilot`, o painel exibe **sugestões da IA** (geradas via `LlmPort`, persistidas como `messages(origin='ai_suggestion')`); o Admin pode **aceitar/editar/ignorar**; **enviar só por ação explícita** e o envio passa pelo **mesmo gate** com `origin='admin'`. O bot **nunca** envia sozinho em copiloto.
- **D-25:** **Confirmação/lembrete pós-agendamento** (FLUP-08/RN-059..062): o Admin registra o agendamento no painel (data/hora/canal) → o sistema agenda `scheduled_tasks` tipo `confirmacao` e `lembrete` → enfileira no `outbox` (`origin='bot'`) → gate (janela/limite). Resposta do lead pedindo **remarcar/cancelar** → **handoff** (R-025/AR-003). **Sem** integração de calendário externa — o agendamento é manual.

**Documentação, ADRs e reconciliação (03-03)**
- **D-26:** Novos ADRs em `docs/08-adr/`: **`014-scheduler-cadencia.md`** e **`015-pipeline-crm-copiloto.md`** (numeração após o `013` existente). **ADR-009 permanece a autoridade** da cadência. Migração de doc: `docs/01-requisitos-funcionais.md` (R-004/R-005/R-058) e `docs/03-regras-de-negocio.md` (RN-009, D-11) reconciliados com o ADR-009 e com as decisões acima; `isCatchupDrain` documentado **como parâmetro** (D-07).

### the agent's Discretion

- Valores exatos de `settings.followup.*` (jitter, limites do dreno, tamanho de lote do tick) — desde que os tetos de D-02/D-07 permaneçam.
- Conteúdo literal das mensagens de follow-up (variadas, RN-019) e das mensagens de confirmação/lembrete — desde que respeitem ADR-012 e os AR como código.
- Fonte/forma exata da lista de feriados (fixos + móveis) e o formato de `settings.calendar.holidays` — desde que seja local (D-09) e testável.
- Detalhes de transporte/estrutura do SSE, nomes de endpoints e o desenho visual fino do painel (o **contrato visual** é responsabilidade do `/gsd-ui-phase`).
- Modelagem fina das tabelas `lead_notes`/`tasks`/`tags` (nomes, índices) — desde que append-only onde couber e com `responsible_user_id` nullable (R-028).

### Deferred Ideas (OUT OF SCOPE)

- **Break-up message no encerramento "sem resposta"** (FLUP-11, v2) — decisão com dado do piloto (Fase 4); não muda R-005 agora.
- **Migração para a API oficial do WhatsApp** (R-016) — fase futura.
- **Multiusuário ativo** (R-027/EQUP) — v2; esta fase mantém `responsible_user_id` nullable e um único operador.
- **Analytics avançado / relatórios além do contador diário e da apuração de Fase 4** — v2.
- **Aquecimento controlado / 5 fases** (R-039/R-040) — fora do MVP (R-060).
- **Electron/Tauri** como shell desktop — fase futura; o painel é localhost no browser.
- **Contrato visual detalhado do painel** — tratado pelo `/gsd-ui-phase` (UI hint = yes), não nesta discussão.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (REQUIREMENTS.md) | Research Support |
|----|-------------------------------|------------------|
| **WHS-02** | Follow-up vencido fora da janela é drenado com limite e jitter controlados assim que o app abre — nunca em rajada (misfire `FIRE_ONCE`, ADR) (R-007) | §Arquitetura de dreno (D-06/D-07); `outbox.markDeferred` + `humanize.humanDelayMs` já existentes; parâmetro `isCatchupDrain`; `scheduled_tasks.scheduled_for` no passado. |
| **FLUP-01** | Se o lead não responde, envia follow-up curto após tempo configurável (R-003) | Primeiro toque = 1h (D-01); `settings.followup.first_delay_ms` (discretion); `humanize` kind `"followup"` já separa delays. |
| **FLUP-02** | Cadência 1h→1d→3d→7d; interrompida se responder, opt-out, handoff ou pausa manual (R-004) | §Cadência; `conversations.follow_up_index`, `last_inbound_at`, `handoff_active`, `engagement_mode`; cancelamento com motivo em `scheduled_tasks.cancelled_reason`. |
| **FLUP-03** | Máx. 4 tentativas; após 7 dias sem resposta, encerra e marca "sem resposta"; 15d NÃO executa (R-005) | D-02/D-13; `settings.followup.max_touches` (default 4, teto 4); `closed_reason='sem_resposta'` + `status_history`. |
| **FLUP-06** | Após handoff quando o Admin assume, bot entra em copiloto: sugere sem enviar (R-014) | D-24; `shadow.persistDraft` (`origin='ai_suggestion'`, `status='suggested'`) + `review-events`; envio por `dispatcher` com `origin='admin'`. |
| **FLUP-08** | Após o Admin registrar agendamento, bot envia confirmação e lembrete, com confirmar/remarcar/cancelar, respeitando janela/limite (R-026) | D-25; `scheduled_tasks.task_type ∈ {confirmacao, lembrete}`; remarcar/cancelar → `dispararHandoff` (RN-062/AR-003). |
| **CRM-01** | Pipeline: Novo→Contatado→Respondeu→Qualificado→Aquecido→Reunião agendada→Proposta→Fechado→Perdido (com motivo) (R-021) | D-14/D-15; coluna `conversations.pipeline_status` + CHECK 9 valores; motivos em `closed_reason`; `status_history` append-only. |
| **CRM-03** | CRM intermediário: lista, status, histórico imutável, busca, tags, filtros, notas, tarefas, lembretes, responsável; Admin e IA criam notas (R-043) | D-22/D-23; tabelas `tags`/`lead_tags`/`lead_notes`/`tasks`; leituras read-only de `messages`/`status_history`/`handoff_events`/`blocked_attempts`. |
| **NFRQ-05** | Painel: lista + chat + sugestões + histórico + ações rápidas; modo em tempo real; sugestões só com ação explícita (R-046) | D-17..D-21 + `03-UI-SPEC.md` (3 colunas, SSE, modo, kill switch, chime); `ApiHttp` Fastify. |
</phase_requirements>

---

## Summary

A Fase 3 não introduz uma stack nova de backend — ela **estende o que já existe**. `outbox`, `scheduled_tasks`, `conversations`, `daily_counters`, `status_history`, `handoff_events`, `blocked_attempts`, `settings`, `event_log` já estão no schema e já têm consultas em `src/infra/db/queries/`. O trabalho real da fase é: (1) um **scheduler de tick** que decide *quando* agendar, enfileirar e cancelar; (2) uma **camada HTTP local** (Fastify + SSE) que serve um SPA React; (3) **tabelas de CRM** e o fluxo de copiloto.

Três fatos verificados no código mudam o desenho em relação ao que um plano genérico faria:

1. **`scheduled_tasks` já existe e nasce vazia.** Ela tem exatamente as colunas que D-03 exige (`task_type`, `scheduled_for` com fuso, `attempts`, `status ∈ {pending,done,failed,abandoned}`, `cancelled_at`, `cancelled_reason`, `last_error`) e um índice parcial `scheduled_tasks_pending_idx ON (scheduled_for, id) WHERE status='pending'`. **O único delta de schema é o índice único parcial `(conversation_id, follow_up_index)` de D-05 — e `follow_up_index` NÃO existe em `scheduled_tasks`** (existe em `conversations`). Isso é uma lacuna de schema a resolver na migração `0007`.
2. **O `outbox` já é a fila gateada** com as três barreiras de duplicata, o `FOR UPDATE SKIP LOCKED`, o lease (`requeueStale`) e `markDeferred`. O scheduler é um **produtor** do `outbox`, não um segundo mecanismo de envio. Existe até um desvio documentado em `reserveNext` (filtro opcional por conversa) que já facilita testes isolados.
3. **`business-hours.ts` já é um módulo sem I/O e testado** (`tests/domain/business-hours.test.ts`) com `ehDiaUtil`, `isWithinWindow` (half-open), `nextWindow` e um helper `instanteLocal` que resolve DST. Estender para feriados é um **acréscimo**, não uma reescrita — e `nextWindow` já pula fim de semana, faltando só "pular feriado".

**Primary recommendation:** Modelar 03-01 como *produtor do `outbox` guiado por um único tick `croner` de 30s*, com a cadência derivada por `(conversations.follow_up_index, conversations.last_outbound_at, conversations.last_inbound_at)`, ledger em `scheduled_tasks`; 03-02 como *uma instância Fastify que serve API + SSE + SPA estática em `127.0.0.1` com token Bearer*; 03-03 como *migração `0007` (pipeline_status + 4 tabelas de CRM) + rotas de CRM + copiloto reusando `shadow.persistDraft` e o `dispatcher`*.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Cadência / decisão de "quando agendar" | **API / Backend** (scheduler in-process) | Database/Storage | Decisão determinística a partir de estado no Postgres; sem browser envolvido. `croner` já é o padrão do processo (health-monitor). |
| Fila de envio durabilizada | **Database/Storage** (`outbox`) | API/Backend (worker) | A durabilidade É a feature (R-007); o worker é um consumidor. |
| Gate de envio | **API / Backend** (`evaluatePolicy` no `dispatcher`) | — | Invariante de ordem herdada (regra-mestra). Nenhum caminho novo. |
| Relógio de negócio / feriados / "próximo dia útil" | **API / Backend** (`business-hours` + `feriados-br`) | — | Já é módulo de domínio sem I/O; mesmo código serve gate e fila. |
| API HTTP + SSE do painel | **API / Backend** (Fastify, `127.0.0.1`) | — | Secure context exige `127.0.0.1`; mesma origem serve estáticos. |
| Servir assets estáticos do SPA | **API / Backend** (`@fastify/static`) | CDN/Static | Um processo, uma porta, sem CORS (D-17). CDN não se aplica a app local. |
| UI do painel (3 colunas, chat, sugestões) | **Browser / Client** (React) | API/Backend (dados) | Renderização, layout, input e `EventSource` vivem no browser. |
| Persistência do CRM | **Database/Storage** (Postgres) | — | R-031 manda Postgres local. |
| Busca/filtros/paginação do CRM | **API / Backend** (server-side) | Database/Storage | D-22 exige server-side; filtra 20–centenas de leads sem carregar tudo no cliente. |
| Geração de sugestão do copiloto | **API / Backend** (`LlmPort` via `dispatcher`) | — | O modelo é sinal, não autoridade (ADR-002); saída passa pelo gate. |
| Kill switch (botão do painel) | **API / Backend** (`settings.operational_mode`) | Browser/Client (botão) | Fonte única de verdade (`settings`), mesma do CLI `mode` (D-20). O browser só dispara. |
| Notificação local | **OS/native** (`notify.ps1`) | Browser (chime, redundância) | `notify.ps1` é primária (D-21); o chime é redundância no browser. |

---

## Standard Stack

O núcleo (Node 24, TS 7.0.2, Drizzle, `pg`, Baileys rc14, `ai` 7, `croner`, `pino`, `zod`, `vitest`) **já está instalado** — verificado: `@whiskeysockets/baileys@7.0.0-rc14`, `ai@7.0.138`, `pg@8.23.0`, `croner@10.0.1`, `pino@10.3.1`, `zod@4.6.5`, `typescript@7.0.2`, `vitest@5.0.2`, Node `v24.21.0`, npm `11.19.0`. **Esta seção só lista o que a Fase 3 ADICIONA.**

### Core (novas dependências de runtime)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `fastify` | **5.12.7** | Servidor HTTP local (API + SSE + estáticos) | Já é a decisão de stack (`STACK.md`, CONTEXT D-17). JSON-Schema-first, hook `onRequest` para validar `Host`+token. Requires Node ≥20; OK em 24. |
| `@fastify/static` | **10.1.6** | Servir o SPA compilado pelo Vite | Par oficial do Fastify 5; serve a mesma origem, sem CORS. `@fastify/static@10` declara peer `fastify@^5`. |
| `react` | **19.3.1** | UI do painel (R-046) | `STACK.md`; 3 colunas densas são layout web. |
| `react-dom` | **19.3.1** | Renderer do React no browser | Lockstep com `react`. |

### Supporting (build de UI)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vite` | **8.3.4** | Build/dev-server do SPA | `STACK.md`; type-check via `tsc`, sem API do compilador TS (compatível com TS 7). |
| `@vitejs/plugin-react` | **6.1.2** | JSX/Fast Refresh | Par oficial do Vite 8 para React. |
| `tailwindcss` | **4.3.3** | Styling | `STACK.md` §53; `03-UI-SPEC.md` fixa Tailwind v4 manual (sem component library). |
| `@tailwindcss/vite` | **4.3.3** | Plugin Tailwind v4 para Vite | Tailwind v4 usa o plugin Vite (não o PostCSS pipeline antigo). **Ver nota em Code Examples.** |
| `lucide-react` | **1.57.0** | Ícones (substitui emojis dos wireframes) | `03-UI-SPEC.md` §Design System; MIT, ISC de fato, tree-shakeable, offline. |

### Development Tools (novos)

| Tool | Version | Purpose | Notes |
|------|---------|---------|-------|
| `@types/react` / `@types/react-dom` | **19.3.0** | Tipos do React | Lockstep com React 19. |
| `jsdom` | **30.1.3** | Ambiente DOM para testes de componente | Se a fase testar componentes React (Vitest `environment: 'jsdom'`). |
| `@testing-library/react` | **16.3.3** | Testes de comportamento de UI | Opcional — o TEST-PLAN deve priorizar o **scheduler**, o **gate-through-panel** e o **CRM**; a UI de 3 colunas é melhor coberta por smoke/E2E do que por snapshot. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Fastify | Express 5 | Express não tem JSON-Schema-first nem o hook `onRequest` com a mesma ergonomia; Fastify já é decisão travada. |
| SSE | WebSocket (`ws`) | SSE é unidirecional (servidor→painel) — exatamente o tráfego do painel; reconexão automática nativa no `EventSource`. WebSocket adicionaria um protocolo bidirecional sem uso (DISCUSSION-LOG marcou SSE ✓). |
| `@tailwindcss/vite` | PostCSS `@tailwindcss/postcss` | O plugin Vite é o caminho recomendado no Tailwind v4; verify na doc oficial ao implementar (ver Open Question Q2). |
| `lucide-react` | emojis dos wireframes | Emojis quebram "nunca só cor" com rótulo de ícone consistente e não são estilizáveis; `03-UI-SPEC.md` já trocou. |

**Installation:**
```bash
# runtime
npm install fastify@5.12.7 @fastify/static@10.1.6 react@19.3.1 react-dom@19.3.1
# build de UI
npm install -D vite@8.3.4 @vitejs/plugin-react@6.1.2 tailwindcss@4.3.3 @tailwindcss/vite@4.3.3 lucide-react@1.57.0 @types/react@19.3.0 @types/react-dom@19.3.0
# testes de UI (opcional)
npm install -D jsdom@30.1.3 @testing-library/react@16.3.3
```

> **NÃO instalar:** `pg-boss` (D-03 — o `outbox` cobre), `bullmq`/`ioredis` (exige Redis; viola local-only), Chromium/Puppeteer, Sentry, LangChain. O `noRestrictedImports` do Biome já barra esses pacotes no projeto.

**Version verification:** cada versão acima foi confirmada com `npm view <pkg> version` em **2026-10-15** (ver tabela do Package Legitimacy Audit).

---

## Package Legitimacy Audit

> Executado via `slopcheck install` (disponível) + `npm view` em 2026-10-15.

| Package | Registry | License | Source Repo | slopcheck | Disposition |
|---------|----------|---------|-------------|-----------|-------------|
| `fastify` | npm | MIT | github.com/fastify/fastify | **[OK]** | Approved |
| `@fastify/static` | npm | MIT | github.com/fastify/fastify-static | **[OK]** | Approved |
| `react` | npm | MIT | github.com/react/react (`packages/react`) | **[OK]** | Approved |
| `react-dom` | npm | MIT | github.com/react/react (`packages/react-dom`) | **[OK]** | Approved |
| `vite` | npm | MIT | github.com/vitejs/vite | **[OK]** | Approved |
| `@vitejs/plugin-react` | npm | MIT | github.com/vitejs/vite-plugin-react | **[OK]** | Approved |
| `tailwindcss` | npm | MIT | github.com/tailwindlabs/tailwindcss | **[OK]** | Approved |
| `@tailwindcss/vite` | npm | MIT | github.com/tailwindlabs/tailwindcss | **[OK]** | Approved |
| `lucide-react` | npm | ISC | github.com/lucide-icons/lucide | **[OK]** | Approved |
| `jsdom` | npm | MIT | github.com/jsdom/jsdom | **[OK]** | Approved |
| `@types/react` | npm | MIT | github.com/DefinitelyTyped/DefinitelyTyped | [OK]\* | Approved |
| `@types/react-dom` | npm | MIT | github.com/DefinitelyTyped/DefinitelyTyped | [OK]\* | Approved |
| `@testing-library/react` | npm | MIT | github.com/testing-library/react-testing-library | [OK]\* | Approved |

\* Fora do lote de 10 submetido ao `slopcheck install` (limite de linha), mas verificados por `npm view` (license + repository) em 2026-10-15; nenhum tem `scripts.postinstall`. Todos são pacotes de escopo `@types`/`@testing-library` de organizações canônicas.

**Nenhum postinstall script** em nenhum dos pacotes acima (`npm view <pkg> scripts.postinstall` → vazio).

**Packages removed due to slopcheck [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

> **Nota sobre o `slopcheck`:** o scan de legitimidade dos 10 pacotes foi concluído (`10 OK`). O traceback ao final é um defeito do `slopcheck` no Windows (tenta invocar `npm install` via `CreateProcess` sem shell e não encontra o executável) — **não** é veredito sobre os pacotes. Nenhum `npm install` real foi executado pelo slopcheck.

---

## Architecture Patterns

### System Architecture Diagram

```
                         ┌─────────────────────────── BROWSER (127.0.0.1) ───────────────────────────┐
                         │  SPA React (3 colunas: Leads | Chat | Ações/Sugestões)                    │
                         │    ├─ EventSource(SSE)  ◄──── eventos de tempo real                       │
                         │    ├─ fetch(API, Authorization: Bearer <token>) ─────┐                    │
                         │    └─ Web Audio chime (redundância de handoff)       │                    │
                         └───────────────────────────────────────────────────── ┼──────────────────┘
                                                                                │  HTTP (mesma origem)
   ┌──────────────────────────── NODE PROCESS (single instance) ────────────────▼──────────────────┐
   │                                                                                                │
   │  Fastify (127.0.0.1)                                                                           │
   │   ├─ onRequest: valida Host + Bearer token ──► 401 se falhar                                   │
   │   ├─ GET /api/*  ─► queries (CRM, chat, contadores, fila)  ──┐                                 │
   │   ├─ POST /api/dispatch ─► enqueue(origin='admin')           │                                 │
   │   ├─ GET /api/events (SSE) ◄── event-bus (inbound/signal/clock) + DB watcher ──────────────────┼──┐
   │   └─ @fastify/static: SPA build (dist/)                        │                               │  │
   │                                                                │                               │  │
   │  Scheduler (croner, tick 30s)                                  │                               │  │
   │   ├─ lê conversations em cadência + scheduled_tasks pendentes ─┼──────► PostgreSQL ◄────────────┼──┘
   │   ├─ FIRE_ONCE (horário passou) → catch-up OU próxima janela   │        (state autoritativo)    │
   │   ├─ enfileira outbox(origin='followup'|'catchup')             │                               │
   │   └─ reconciliador: órfãos / ledger sem job / job terminal     │                               │
   │                                                                ▼                               │
   │  Outbox worker (drainLoop 30s)                          business-hours + feriados-br          │
   │   └─ reserveNext (FOR UPDATE SKIP LOCKED) ─► dispatcher.dispatch ─► evaluatePolicy (gate)      │
   │                                                         │                                      │
   │                                              aprovado ──┼──► sendText  (ÚNICO no dispatcher)   │
   │                                                         │       + quota na MESMA tx             │
   │                                              negado   ──┘──► abandon + log + SSE (bloqueio)    │
   └───────────────────────────────────────────────────────┬────────────────────────────────────────┘
                                                           │
                                                   Baileys (rc14) ── WhatsApp ──► Lead
                                                           │
                                              notify.ps1 (som + pop-up)
```

**Como ler:** o painel **nunca** fala com o WhatsApp. Todo envio — manual, copiloto, follow-up ou catch-up — converge para `dispatcher.dispatch → evaluatePolicy → sendText`. O scheduler é apenas um **produtor** do `outbox`.

### Recommended Project Structure (novos arquivos)

```
src/
├── domain/
│   ├── feriados-br.ts             # D-09: fixos + móveis (Páscoa) — puro, testável
│   ├── cadence.ts                 # D-01/D-02: próxima tentativa por (index, last_outbound_at)
│   └── pipeline.ts                # D-14/D-15: 9 status, matriz de transição, motivos de Perdido
├── application/
│   ├── scheduler.ts               # D-04: tick croner 30s (dispatch-led) + reconciliador
│   ├── catchup-drain.ts           # D-06/D-07: FIRE_ONCE, ≤3/10min, 1/lead/dia, isCatchupDrain
│   ├── copilot.ts                 # D-24: reusa shadow.persistDraft + LlmPort
│   └── appointment.ts             # D-25: agenda confirmacao/lembrete; remarcar→handoff
├── api/
│   ├── server.ts                  # Fastify: bind 127.0.0.1, Host+token, @fastify/static
│   ├── routes/                    # leads, conversations, messages, crm, settings, dispatch
│   ├── sse.ts                     # canal SSE (event-bus → EventSource)
│   └── auth.ts                    # Bearer token (env), comparação constant-time
├── infra/db/queries/
│   ├── crm.ts                     # busca/filtros/paginação server-side; notas/tags/tasks
│   └── scheduler.ts               # seleção de candidatos + reconciliação
└── web/                           # SPA (Vite root)
    ├── index.html
    ├── main.tsx
    └── ...                        # ver 03-UI-SPEC.md §Component Inventory
src/infra/db/migrations/0007_*.sql # pipeline_status + 4 tabelas CRM + índice único parcial
```

### Pattern 1: Scheduler como *produtor* do outbox, não como segundo envio

**What:** O tick de 30s **nunca** envia. Ele só lê estado, escreve `scheduled_tasks` e chama `enqueue`. O envio continua sendo exclusivamente do `outbox-worker` → `dispatcher`.
**When to use:** Sempre; é a tradução de D-03/D-04 e a única forma de manter o choke-point.
**Example:**
```ts
// Source: src/application/outbox-worker.ts (padrão de tick já existente) + outbox.ts
const job = await reserveNext(db, { now });        // já faz SKIP LOCKED + attempts+1
if (!job) return;
const resultado = await dispatch(db, {             // reavalia o gate com snapshot fresco
  conversationId: job.conversationId,
  text: job.body,
  origin: job.origin === "catchup" ? "catchup" : "followup",
}, deps);
if (resultado.status === "sent") await markSent(db, job.id, resultado.messageId);
else if (resultado.status === "deferred") await markDeferred(db, job.id, resultado.nextAt);
else await abandon(db, job.id, resultado.reason);  // motivo canônico do gate
```

### Pattern 2: Idempotência em duas chaves (agendamento e envio)

**What:** O agendamento é idempotente por `(conversation_id, follow_up_index)` em `scheduled_tasks`; o envio por `idempotency_key = 'flup:{conversationId}:{index}'` em `outbox`. **Nota:** `follow_up_index` hoje é coluna de `conversations`, **não** de `scheduled_tasks` — a migração `0007` precisa adicioná-la (ou mover a estratégia para `task_type + index`) para o índice único parcial de D-05 existir.
**When to use:** Dois ticks concorrentes / re-boot no meio de um tick.
**Example:**
```sql
-- migração 0007 (delta sobre o que já existe em 0003)
ALTER TABLE scheduled_tasks ADD COLUMN follow_up_index smallint NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX scheduled_tasks_conv_idx_uniq
  ON scheduled_tasks (conversation_id, follow_up_index)
  WHERE status = 'pending';
```

### Pattern 3: Cancelamento como *linha auditável*, nunca como DELETE

**What:** Quando a cadência é interrompida (resposta/opt-out/handoff/pausa), o `scheduled_tasks` pendente vira `status='abandoned'` (ou `'failed'`) com `cancelled_at` + `cancelled_reason`, e o job correspondente no `outbox` é `abandon(motivo)`. O `status` do `scheduled_tasks` não tem valor `'cancelled'` (o CHECK é `pending|done|failed|abandoned`) — usar `abandoned` + `cancelled_reason`.
**When to use:** Todo caminho de interrupção; é o que torna "por que este follow-up de 3d não saiu" respondível (comentário do schema).

### Pattern 4: Fastify com guarda de `Host` + token na borda

**What:** Um único hook `onRequest` rejeita `Host` inesperado (anti-DNS-rebinding) e exige `Authorization: Bearer <token>`. Rota SSE isenta do body-limit mas **não** do token.
**When to use:** Toda rota `/api/*`; estáticos servidos pelo `@fastify/static` ficam isentos de token (asset público) **mas** com `Host` validado.

### Anti-Patterns to Avoid

- **Enviar do scheduler:** qualquer `sendText`/`dispatch` chamado pelo tick quebra o choke-point e o grep-test `tests/lint/choke-point.grep.test.ts` falha. O tick só enfileira.
- **Recalcular a cadência a partir de `now()`:** D-01 ancora em `last_outbound_at`. Ancorar em `now` a cada tick empurraria o próximo toque para sempre.
- **`CATCH_UP` / replay de misfire:** D-06 proíbe. Um `FIRE_ONCE` por ocorrência; o resto é `markDeferred` para a próxima janela.
- **`pg-boss`:** D-03 rejeita. Não adicionar.
- **Bind `0.0.0.0`:** D-18 proíbe; expõe o banco LGPD.
- **`UPDATE`/`DELETE` em `messages`/`status_history`/`llm_runs`:** triggers `fn_append_only` (migração 0003/0004/0006) **levantam exceção**. O painel é read-only sobre essas tabelas.
- **Duplicar a fonte do kill switch:** `settings.operational_mode` é a única (o `KILL_SWITCH` do `.env` é um abort de boot independente; `snapshot.ts` já combina `channel_accounts.is_active` OR `settings.operational_mode='paused'`).
- **Guardar o token do painel em `settings`:** D-18 manda `.env`; `settings` é exibido no painel.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Fila durável com lock distribuído | Tabela + `SELECT ... FOR UPDATE` na mão | `outbox.reserveNext` (já faz SKIP LOCKED + `attempts+1` numa tx) | Já implementado e testado (`tests/application/outbox.test.ts`); reimplementar reintroduz TOCTOU. |
| Agendar/agendar-de-novo com durabilidade | `setTimeout`/`node-cron` em memória | `scheduled_tasks` + tick `croner` | `setTimeout` morre no restart e não sabe "venceu enquanto o PC estava off" (R-007). |
| Detectar/data de feriado brasileiro | Parser de Páscoa escrito do zero | `feriados-br.ts` com Meeus/Jones/Butcher simplificado **ou** pacote local | A Páscoa é um cálculo astronômico com regra eclesiástica; erra por 1 ano fácil. Preferir uma implementação curta e testada contra anos conhecidos (ex.: Carnaval 2026-02-17, Sexta 2026-04-03). |
| Fuso horário / janela por hora local | `date.getHours()` | `business-hours.ts` (`Intl.DateTimeFormat` com `timeZone`) | O módulo já resolve DST e o half-open `[7,17)`; `getHours()` usa TZ do processo. |
| Server-Sent Events | `ws` + protocolo próprio de reconexão | `EventSource` do navegador + rota SSE no Fastify | `EventSource` reconecta e faz backoff sozinho; é o requisito exato (unidirecional). |
| Delays humanizados | `Math.random()` inline | `humanize.humanDelayMs(kind, seed)` | Já existe, é determinístico por seed (testável) e tem `FOLLOWUP_MIN/MAX`. |
| Reserva de cota diária | `SELECT count(*)` + `INSERT` | `counters.reserveMessageQuota` / `reserveNewContactQuota` | Atomicidade via `INSERT ... ON CONFLICT ... WHERE count < teto`; reimplementar abre corrida. |
| Comparação de token | `===` | `crypto.timingSafeEqual` | Evita timing side-channel; barato. |
| Validação de corpo da API | `if`/regexes ad-hoc | schemas Zod (já é a camada de validação do projeto) | Um só vocabulário de validação (LLM, config, HTTP). |

**Key insight:** quase tudo nesta fase já está construído. O risco não é *faltar* uma biblioteca — é **reimplementar** algo que o projeto já tornou durável e testado, ou **criar um segundo caminho de envio** que escapa do gate.

---

## Common Pitfalls

### Pitfall 1: Rajada de catch-up ao abrir o app (o risco dominante)
**What goes wrong:** O app fica fechado no fim de semana; na segunda 07:00 o scheduler encontra N follow-ups vencidos e os enfileira todos; o worker envia em rajada — padrão clássico de banimento (AR-008/R-059).
**Why it happens:** `scheduled_tasks.scheduled_for` fica no passado; sem política de misfire, cada linha vencida vira um envio imediato.
**How to avoid:** D-06/D-07 traduzidos como três travas simultâneas: (a) `FIRE_ONCE` por ocorrência; (b) dreno ≤3 nos primeiros 10 min com jitter 3–12s via `humanize`; (c) `markDeferred` para o resto — **nunca descartar**. `isCatchupDrain` é parâmetro, não `settings`.
**Warning signs:** mais de 3 linhas `origin='catchup'` em `outbox` com `scheduled_for` nos primeiros 10 min; teste de "segunda de manhã" com 20 leads vencidos.

### Pitfall 2: Recalcular a cadência em vez de ancorar no último toque
**What goes wrong:** O tick roda a cada 30s e reagenda "agora + 1h". O follow-up nunca chega, ou chega tarde demais, e o `follow_up_index` diverge do real.
**Why it happens:** Confundir "quando verificar" (tick) com "quando agendar" (ancorado em `last_outbound_at`).
**How to avoid:** D-01: `proximaTentativa = last_outbound_at + DELTAS[follow_up_index]`. O tick só **compara**, nunca **reancora**.
**Warning signs:** `scheduled_for` mudando a cada tick para o mesmo `(conversation, index)`.

### Pitfall 3: Inbound zera a cadência — mas o tick já enfileirou
**What goes wrong:** O lead responde às 08:00; o tick das 08:00:00 já tinha enfileirado o follow-up de 1d. A resposta do lead não cancela a linha em `outbox`, e o bot "fala por cima".
**Why it happens:** A interrupção (D-12) é uma escrita de estado, mas o job já está na fila.
**How to avoid:** (a) o `dispatcher` reavalia o gate a cada job (já é padrão), mas o gate **não** sabe "a cadência foi interrompida" — é preciso um `reason` de gate específico **ou** o scheduler marcar `abandon` na mesma tx do registro da interrupção; (b) `inbound-handler` já grava `last_inbound_at = now()`. **Decisão de plano:** ao processar inbound, cancelar em transação os `scheduled_tasks`/jobs de cadência pendentes da conversa.
**Warning signs:** job `origin='followup'` com `scheduled_for < last_inbound_at`.

### Pitfall 4: `messages` é append-only — `markSent` não pode atualizar `messages`
**What goes wrong:** Tentar `UPDATE messages SET status='sent' WHERE id=...` derruba a transação (trigger `trg_messages_append_only`).
**Why it happens:** Reflexo de ORM/CRUD.
**How to avoid:** Já resolvido em `outbox.markSent` (comentário explícito): gravar a mensagem **já** com `status='sent'` na tx do `dispatch`. O painel/copiloto devem seguir o mesmo caminho.
**Warning signs:** exceção `append_only` em teste de dispatch.

### Pitfall 5: Expor o banco LGPD à LAN
**What goes wrong:** Bind `0.0.0.0` ou `host: true` do Fastify publica o CRM na rede local.
**Why it happens:** Copiar exemplos que usam `0.0.0.0`.
**How to avoid:** D-18: `host: '127.0.0.1'` literal + validação de `Host` no `onRequest` (anti-DNS-rebinding) + token Bearer de `.env`. R-033 ("sem criptografia") é sobre dados em repouso, não sobre rede.
**Warning signs:** `netstat` mostrando `0.0.0.0:PORT`; resposta a `Host: evil.com`.

### Pitfall 6: `pipeline_status` × `state` × `stage` confundidos
**What goes wrong:** A FSM do motor (`state`), o sub-estágio (`stage`) e o CRM (`pipeline_status`) começam a ser setados pelo mesmo código e divergem.
**Why it happens:** Três colunas parecidas descrevendo "onde o lead está".
**How to avoid:** D-14: `pipeline_status` é **só** CRM (9 valores, default `novo`), `state` é **só** o motor (`resolveNextState`), `stage` é sub-estágio de qualificação. Toda mudança de `pipeline_status` grava `status_history` com `changed_by='ia'|'admin'` e `reason`.
**Warning signs:** um `UPDATE conversations SET state=...` alterando `pipeline_status`, ou vice-versa.

### Pitfall 7: Backfill de `pipeline_status` em base viva
**What goes wrong:** Adicionar `pipeline_status NOT NULL` a uma tabela com leads existentes falha, ou marca todos como `novo` mesmo os que já responderam.
**Why it happens:** Migração de coluna NOT NULL sem default/backfill.
**How to avoid:** `DEFAULT 'novo'` + backfill derivado de `conversations.state` e de `messages` (ex.: quem tem inbound → `respondeu`+). Documentar no plano como task de migração, separada da criação de coluna. `messages`/`status_history` são append-only: o backfill **lê**, não escreve neles.
**Warning signs:** todos os leads históricos em `novo`.

### Pitfall 8: Feriado móvel errado por 1 dia
**What goes wrong:** Carnaval/Corpus Christi calculados a partir de uma Páscoa incorreta; um follow-up tenta sair em feriado.
**Why it happens:** Algoritmo de Páscoa (Anonymous Gregorian / Meeus) mal transcrito, ou offsets trocados (Carnaval = Páscoa−47d, Corpus Christi = Páscoa+60d).
**How to avoid:** Testar contra anos conhecidos (2026: Páscoa 05/04, Carnaval 17/02, Sexta Santa 03/04, Corpus Christi 04/06) e cobrir com `tests/domain/feriados-br.test.ts`. Override manual em `settings.calendar.holidays` para feriados móveis/estaduais (D-09).
**Warning signs:** teste de Páscoa ausente; feriado fixo (01/01, 21/04, 01/05, 07/09, 12/10, 02/11, 15/11, 20/11, 25/12) sem horário.

### Pitfall 9: SSE com reconexão perdendo eventos
**What goes wrong:** O `EventSource` reconecta e perde os eventos que aconteceram no intervalo; o painel mostra estado antigo.
**Why it happens:** SSE puro é um stream sem replay.
**How to avoid:** manutenção simples (heartbeat `: ping` a cada ~15s) + o painel re-sincroniza via `GET /api/*` ao reconectar (`Last-Event-ID` opcional; um `id:` incremental por evento ajuda). Manter a fonte de verdade no Postgres (o state) e o SSE só como *hint* de atualização.
**Warning signs:** modo do painel divergindo do `settings.operational_mode`; `ConnectionIndicator` "Ao vivo" com dados velhos.

### Pitfall 10: `settings` é jsonb — leitura escalar exige `#>> '{}'`
**What goes wrong:** Comparar `settings.value = 'paused'` falha porque `value` é `jsonb` (`"paused"` com aspas).
**Why it happens:** jsonb vs text.
**How to avoid:** já resolvido em `snapshot.ts` (`s.value #>> '{}'`). Reusar o mesmo acesso para o painel e para `followup.max_touches`/`calendar.holidays`.
**Warning signs:** kill switch do painel não reflete no gate.

---

## Code Examples

Padrões verificados no próprio código (fonte: arquivos citados), que o plano deve reusar.

### Enfileirar um follow-up idempotente (reusa `outbox.enqueue`)
```ts
// Source: src/application/outbox.ts:100-118
const id = await enqueue(db, {
  conversationId,
  origin: "followup",
  body: textoVariado,
  idempotencyKey: `flup:${conversationId}:${index}`,  // D-05
  scheduledFor: proximaTentativa,                      // D-01: last_outbound_at + DELTAS[index]
});
// id === null ⇒ já estava na fila; um segundo INSERT criaria um segundo ENVIO.
```

### Próxima janela válida (reusa `nextWindow` — só falta feriado)
```ts
// Source: src/domain/business-hours.ts:139-172
// hoje: usa essa função para reprogramar.
// Fase 3: precisa pular feriado também — hoje nextWindow só pula fim de semana.
const alvo = nextWindow(vencido, tz, inicio, fim);  // D-10: próximo dia útil às 07:00
```
> **Delta de D-09:** `nextWindow` atual salta fim de semana (`diaDaSemana` 0/6). Pular feriado exige passar a lista de feriados como dependência e escolher o próximo dia que seja útil **e** não-feriado. Manter a função pura (feriados por parâmetro) para continuar testável sem I/O.

### Dreno de catch-up (limites duros de D-07)
```ts
// Esqueleto a implementar em src/application/catchup-drain.ts
// Travas: ≤3 nos primeiros 10 min; 1 follow-up/lead/dia de drenagem; jitter via humanize.
const JITTER_MIN_MS = 3_000, JITTER_MAX_MS = 12_000;   // ADR-009 L233-234
let enviadosNaJanela = 0;
for (const vencido of vencidosOrdenadosPor(scheduled_for)) {     // FIFO por vencimento
  if (enviadosNaJanela >= 3 && now - inicioDrenagem < 10 * 60_000) {
    await markDeferred(db, vencido.outboxId, nextWindow(now, tz, inicio, fim)); // adia, não descarta
    continue;
  }
  if (jaTeveFollowUpHoje(vencido.conversationId, diaDrenagem)) {
    await markDeferred(db, vencido.outboxId, nextWindow(now, tz, inicio, fim));
    continue;
  }
  await sleep(humanDelayMs("followup", vencido.seed));           // 2.5–6s + jitter
  enviadosNaJanela++;
}
```

### Guarda de borda do Fastify (Host + token)
```ts
// Esqueleto a implementar em src/api/server.ts — decisão de D-18
const TOKEN = env.PANEL_TOKEN;            // de .env, nunca de settings
app.addHook("onRequest", async (req, reply) => {
  const host = String(req.headers.host ?? "").split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") return reply.code(403).send();
  if (!timingSafeEqualStr(req.headers.authorization ?? "", `Bearer ${TOKEN}`))
    return reply.code(401).send();
});
await app.listen({ host: "127.0.0.1", port: env.PANEL_PORT });   // nunca 0.0.0.0
```

> **Nota Tailwind v4 + Vite:** a config muda em relação ao Tailwind 3 — o conteúdo é declarado no CSS via `@import "tailwindcss";` e o plugin é `@tailwindcss/vite`. **Confirmar na doc oficial do Tailwind v4 antes de implementar** (Open Question Q2) — a sintaxe do v3 (`tailwind.config.js` + `content`) não é a mesma.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `node-cron`/`setTimeout` para follow-up | Fila durável em Postgres + tick `croner` (já é o padrão do projeto) | — | Sobrevive a crash/reboot; implementa R-007. |
| `pg-boss` como fila | `outbox` próprio (SKIP LOCKED + lease + re-gate) | D-03 (2026-10-15) | Zero infra nova; uma superfície. |
| WebSocket para push | SSE (`EventSource`) | D-17 | Reconexão/backoff nativos; unidirecional é o caso. |
| Electron para app desktop | SPA em `127.0.0.1` no browser | STACK/CONTEXT | Sem segunda Chromium; `127.0.0.1` é secure context (Notifications, Web Audio, clipboard). |
| `now()`-based scheduling | Âncora em `last_outbound_at` | D-01 | Cadência estável. |

**Deprecated/outdated nesta fase:**
- Texto do plano `03-01` "máx. 2 toques" → **superseded** por D-02 (4 toques).
- RN-009 "envia ao abrir o app mesmo fora da janela" → **reconciliado** por D-11 (fora da janela só enfileira).
- `node-notifier` (já rejeitado na Fase 1) — permanece rejeitado; `notify.ps1` é a notificação primária.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `@tailwindcss/vite@4.3.3` é o plugin correto para Tailwind 4 (vs `@tailwindcss/postcss`) | Standard Stack / Code Examples | Build do CSS falha; trocar plugin é 1 linha. **Confirmar na doc Tailwind v4.** |
| A2 | `@fastify/static@10.1.6` declara peer `fastify@^5` (compatível com 5.12.7) | Standard Stack | Conflito de peer; improvável mas não verificado via `npm view peerDependencies`. |
| A3 | Offset dos feriados móveis: Carnaval = Páscoa−47d, Corpus Christi = Páscoa+60d | Pitfall 8 | Datas erradas; coberto por teste contra anos conhecidos. |
| A4 | O `dispatcher` expõe um `status` de resultado (`sent|deferred|blocked|erro_nao_mapeado`) reutilizável pelo scheduler | Pattern 1 | O planner precisa ler `src/application/dispatcher.ts` (contrato exato) antes de codar. |
| A5 | `settings` é a fonte de verdade de `followup.max_touches`/`calendar.holidays` e lê-se via `value #>> '{}'` | Pitfall 10 | Kill switch/limites divergem do painel. |
| A6 | Existe `GET` de estado single-user suficiente para o token Bearer (sem sessão) | Security Domain | Se o painel precisar de sessão, RF extra. |

**Se a tabela não podia estar vazia:** A1–A6 são áreas de *discretion* ou detalhes de implementação; nenhuma contradiz decisão travada. **Nenhuma decisão travada do CONTEXT depende de suposição não verificada.**

---

## Open Questions (RESOLVED)

1. **O `dispatcher` já devolve um resultado estruturado que o scheduler possa consumir?** **(RESOLVIDO no plano 03-02)**
   - What we know: `outbox-worker.ts` tem `DrainResult`; `dispatcher.ts` é o choke-point.
   - What's unclear: o contrato exato (`{status, reason, messageId}`) — não foi lido linha a linha nesta sessão.
   - Recommendation: o plano 03-01 abre lendo `src/application/dispatcher.ts` e `outbox-worker.ts` integralmente antes de escrever o scheduler.
   - **Resolução (03-02):** a Task 1 lê `dispatcher.ts`/`outbox-worker.ts` integralmente antes de codar; `outbox-worker` consome `resultado.action` (não `.status`) — o scheduler e o dreno não importam `dispatch`, apenas `enqueue`/`abandon`/`markDeferred`.

2. **Sintaxe exata do Tailwind v4 + Vite (`@import "tailwindcss"`, plugin `@tailwindcss/vite`)** — A1. **(RESOLVIDO no plano 03-04)**
   - Recommendation: consultar a doc oficial do Tailwind v4 ao implementar 03-02; não copiar config do v3.
   - **Resolução (03-04):** a Task 1 fixa a configuração (`@import "tailwindcss";` + `@tailwindcss/vite` plugin em `vite.config.ts`, sem `tailwind.config.js`/`content`) e o executor confirma na doc oficial ao implementar (aposta A1).

3. **Como o scheduler cancela jobs já enfileirados quando o lead responde?** **(RESOLVIDO no plano 03-02)**
   - What we know: o gate reavalia por job, mas não conhece "cadência interrompida"; `inbound-handler` grava `last_inbound_at`.
   - Recommendation: decidir no plano entre (a) um `gate reason` novo derivado de `last_inbound_at` vs. (b) cancelamento transacional dos jobs pendentes no registro do inbound. (Pitfall 3.)
   - **Resolução (03-02):** opção (b) — a Task 2 estende `inbound-handler.ts` para, na MESMA transação do registro do inbound de texto, marcar `scheduled_tasks` pendentes como `abandoned` (+`cancelled_reason`) e `abandon` dos jobs; o tick também reconcilia o interrompido. Não depende de o gate "conhecer" a interrupção.

4. **`follow_up_index` em `scheduled_tasks` vs. derivação por `task_type`** — a coluna de D-05 não existe em `scheduled_tasks`. **(RESOLVIDO no plano 03-01)**
   - Recommendation: adicionar `follow_up_index` na migração `0007` (mais simples e casa com o índice único parcial pedido).
   - **Resolução (03-01):** a Task 1 adiciona `follow_up_index smallint NOT NULL DEFAULT 0` na migração `0007_scheduler_cadence.sql` + índice único parcial `(conversation_id, follow_up_index) WHERE status='pending'`.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | v24.21.0 (LTS) | — |
| npm | Instalação | ✓ | 11.19.0 | — |
| PostgreSQL server | Dados (R-031) | ✓ | 18 (serviço `postgresql-x64-18` **Running**) | — |
| `psql` | Migrações/inspeção | ✓ | `C:\Program Files\PostgreSQL\18\bin\psql.exe` | — |
| `pg_dump` | Backup (R-032) | ✓ | `C:\Program Files\PostgreSQL\18\bin\pg_dump.exe` (**mesma major do servidor** = 18) | — |
| `DATA_ROOT` (`C:\whatsapp_prospecao`) | Sessão/backups/logs | ✓ | existe | — |
| `.env` | Segredos de dev | ✓ | existe | — |
| git | Versionamento | ✓ | 2.48.1.windows.1 | — |
| `slopcheck` / `python` | Gate de pacotes | ✓ | Python 3.13.5 / slopcheck presente | — |

**Missing dependencies with no fallback:** nenhuma.
**Missing dependencies with fallback:** nenhuma bloqueante. Nota: o pareamento físico do número (P-004/P-007) está **deferido** e é risco operacional, não dependência de build da Fase 3 (CONTEXT §deferred).

---

## Security Domain

> `security_enforcement` não está em `config.json` ⇒ **habilitado**. R-033 aceita ausência de criptografia **em repouso**; isso não dispensa os controles de rede/entrada, e o painel introduz a **primeira superfície HTTP** do projeto.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | **yes** | Bearer token único (D-18) de `.env`, validado no `onRequest`; `timingSafeEqual`. |
| V3 Session Management | no (parcial) | Não há sessão: token por request. Sem cookies, sem `Set-Cookie` ⇒ sem CSRF por sessão. |
| V4 Access Control | no | Single-user (R-027). Sem RBAC nesta fase; `responsible_user_id` fica nullable. |
| V5 Input Validation | **yes** | Zod na borda da API (mesmo vocabulário do LLM/config); Drizzle com bind params. |
| V6 Cryptography | no | R-033: sem criptografia em repouso (risco aceito e documentado). Não inventar cripto caseira. |

### Known Threat Patterns for {Fastify + React localhost + Postgres}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Exposição à LAN do banco LGPD | Information Disclosure | Bind `127.0.0.1` (D-18) + validar `Host` (anti-DNS-rebinding). |
| DNS rebinding | Spoofing | Validar `Host ∈ {127.0.0.1, localhost}` no `onRequest`. |
| Uso do painel por página/ extensão de terceiros | Elevation of Privilege | Token Bearer obrigatório em `/api/*`. |
| CSRF | Tampering | Sem cookies de sessão + token explícito em header (não-amplificável por `<form>` cross-origin). |
| XSS via texto do lead/sugestão da IA | Tampering | React escapa por padrão; **sanitizar `href` de links (R-042 permite links)** — bloquear `javascript:`/`data:`. |
| Path traversal no `@fastify/static` | Information Disclosure | Servir só `dist/` do SPA; **nunca** apontar a raiz para `DATA_ROOT` (sessão/backups). |
| SQL injection | Tampering | Drizzle `sql\`\`` com bind params (padrão atual); nada de concatenação. |
| Secrets em `settings`/log | Information Disclosure | Token no `.env`; `pino` `redact` (corpo de mensagem nunca em log). |
| Corpo gigante derrubando o processo | DoS | `bodyLimit` do Fastify; single-user. |
| SSE consumindo conexões | DoS | Heartbeat + limite de conexões SSE (single-user). |

---

## Sources

### Primary (HIGH confidence) — código e artefatos do próprio projeto (verificados nesta sessão)
- `src/application/outbox.ts` — `enqueue`/`reserveNext`/`markSent`/`markFailed`/`markDeferred`/`abandon`/`requeueStale`; comentário sobre por que `messages` é append-only.
- `src/application/outbox-worker.ts`, `src/application/humanize.ts`, `src/application/queue-per-lead.ts`, `src/application/event-bus.ts`, `src/application/handoff-service.ts`, `src/application/shadow.ts`, `src/application/inbound-handler.ts`.
- `src/domain/business-hours.ts` — `ehDiaUtil`, `isWithinWindow` (half-open), `nextWindow`, `instanteLocal`.
- `src/domain/orchestrator/transitions.ts` — `ALLOWED` (9 estados), `resolveNextState` e ordem das guardas.
- `src/infra/db/schema.ts` + `migrations/0000–0006` — `scheduled_tasks` (colunas/índice), `outbox`, `conversations`, `daily_counters`, `settings`.
- `src/infra/db/queries/snapshot.ts` — leitura única do gate; kill switch `is_active OR operational_mode='paused'`; `#>> '{}'`.
- `src/infra/health-monitor.ts` — padrão de tick `croner` in-process.
- `src/config/env.ts` — `DAILY_MESSAGE_LIMIT` (≤30), `DAILY_LEAD_LIMIT`, `WINDOW_*`, `TZ`, `CHANNEL_PHONE_E164`.
- `docs/08-adr/009-follow-up-conservador.md` — cadência, `FIRE_ONCE`, `JITTER_MIN/MAX_MS = 3000/12000`, `isCatchupDrain` como parâmetro.
- `docs/08-adr/011-painel-unico.md`, `docs/06-wireframes.md`, `docs/03-regras-de-negocio.md` (RN-015..021, RN-057..062, RN-078..085), `docs/01-requisitos-funcionais.md`.
- `.planning/phases/03-.../03-CONTEXT.md`, `03-DISCUSSION-LOG.md`, `03-UI-SPEC.md`, `.planning/ROADMAP.md` §Phase 3, `.planning/REQUIREMENTS.md`.
- `.ruler/skills/{follow-up-cadencia,crm-pipeline,handoff-humano}/SKILL.md`.

### Secondary (MEDIUM confidence)
- `npm view <pkg> version|license|repository|scripts.postinstall` (2026-10-15) — versões/lockstep dos pacotes novos.
- `slopcheck install` (2026-10-15) — 10/10 `[OK]`.
- Probe de ambiente: `node -v`, `npm -v`, `Get-Service postgresql*`, `Get-Command pg_dump`, `Test-Path DATA_ROOT`.

### Tertiary (LOW confidence)
- Nenhum. Não foi necessário recorrer a WebSearch: o domínio é interno e a stack de UI está travada em `.planning/research/STACK.md` + `03-UI-SPEC.md`.

---

## Metadata

**Confidence breakdown:**
- Standard stack: **MEDIUM** — núcleo já instalado e verificado (HIGH); versões das libs de UI novas verificadas no npm mas sem Context7/doc oficial nesta sessão (A1/A2).
- Architecture: **HIGH** — deriva do código lido (outbox, snapshot, transitions, business-hours) e de decisões travadas (D-01..D-26); o scheduler-como-produtor segue o padrão de `outbox-worker`/`health-monitor`.
- Pitfalls: **HIGH** — os riscos dominantes (rajada, choke-point, append-only, bind de rede) são verificáveis no próprio código; os de feriado/Tailwind são MEDIUM (A1/A3).

**Research date:** 2026-10-15
**Valid until:** ~2026-11-14 (stack estável; revalidar apenas versões de UI se adiar > 30 dias).
