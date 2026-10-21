# ADR-015 — Pipeline de CRM e Copiloto no Painel Único

- **Status:** Aceito
- **Data:** 2026-10-21
- **Decisores:** Admin (você), System Architect
- **Contexto:** Fase 3 — Cadência, Operação e Painel
- **Relacionado a:** R-014, R-021, R-022, R-024, R-025, R-026, R-027, R-028, R-045, R-046, R-059, AR-003, AR-004, AR-005, AR-006, AR-010, AR-011, CRM-01, CRM-03, FLUP-06, FLUP-08

---

## 1. Contexto

O [ADR-011](011-painel-unico.md) definiu **um painel único** em três colunas: lista de leads |
conversa | ações e sugestões. O [ADR-010](010-shadow-mode.md) definiu o **modo copiloto**: a IA
sugere, o humano envia. O [ADR-004](004-gate-invariantes.md) definiu o **gate único**: os 12
anti-requisitos são invariantes de código, e nada sai do painel sem passar por ele.

Faltava a camada de **CRM operacional** — a parte que o Admin usa para *decidir*, não apenas
para *assistir*:

1. **Onde o lead está.** Um funil de 9 status (`novo → contatado → respondeu → qualificado →
   aquecido → reunião agendada → proposta → fechado → perdido`), com justificativa obrigatória
   nos status críticos e motivo enumerado no encerramento.
2. **O que o sistema sabe do lead.** Notas do Admin e **notas automáticas da IA**, distinguíveis
   por autoria; tarefas e lembretes com prazo e responsável.
3. **O que fazer com a sugestão.** No modo copiloto, a sugestão é exibida e o Admin decide:
   aceitar, editar, ignorar. O envio é **ação exclusiva e explícita** do Admin, e passa pelo
   mesmo gate com `origin='admin'`.
4. **O que o Admin precisa registrar.** A confirmação e o lembrete de reunião saem de um
   **agendamento manual** feito no painel — o bot confirma e lembra o que o Admin registrou, e
   nada mais.

O risco dominante desta camada não é técnico: é **o painel virar um caminho de envio
alternativo**. Um botão "aceitar" que envia, um atalho que dispara, um `fetch` direto para o
canal — qualquer um desses contorna o gate e quebra a invariante que sustenta o projeto
inteiro. Por isso o copiloto é desenhado como *sugerir*, nunca como *enviar*.

---

## 2. Decisão

### 2.1 Painel único, local, servido pelo mesmo processo

Subordinado ao ADR-011:

- **Fastify** (servidor único) + **SSE** para tempo real + SPA **React** (Vite) servida pelo
  **mesmo processo e porta** via `@fastify/static`. Sem CORS (mesma origem), sem Electron/Tauri.
- **Bind literal `127.0.0.1`** — nunca `0.0.0.0`. R-033 aceita "sem criptografia" para dados
  em repouso; isso **não** autoriza expor o banco LGPD à rede local.

### 2.2 Borda de segurança: `Host` + token Bearer

- **Validação do header `Host`**: só `127.0.0.1` e `localhost` (sem porta) são aceitos —
  anti-DNS-rebinding. Qualquer outro host devolve **403**.
- **`Authorization: Bearer <PANEL_TOKEN>`** em todas as rotas `/api/*`, comparado em **tempo
  constante**; scheme `Bearer` case-sensitive (RFC 9110). Ausente ou divergente → **401**.
- O token vem de **`env.PANEL_TOKEN`** (`.env`, gitignored) — **nunca** de `settings`, nunca
  do banco, nunca logado (o logger redige `req.headers.authorization` e `*.token`).
- O SPA compilado é servido **sem** token, mas **sempre** com o `Host` já validado pelo hook de
  borda.

### 2.3 Pipeline de 9 status, separado da máquina de estados

O funil vive em **`conversations.pipeline_status`** (CHECK com os 9 valores, default `novo`),
**separado** de:

- `conversations.state` — a FSM do motor (o estado real da máquina);
- `conversations.stage` — sub-estágio de qualificação.

Três eixos, porque "o lead avançou no funil" e "a conversa está em handoff" são fatos
diferentes: um lead pode estar `qualificado` no funil enquanto a conversa está `awaiting_human`.

- **Toda transição é append-only** em `status_history` (`from`/`to`/`reason`/`changed_by`).
- **Status críticos** (`reuniao_agendada`, `proposta`, `fechado`, `perdido`) **exigem
  justificativa** antes de gravar (RN-082).
- **`perdido` exige motivo enumerado** (RN-084/D-15): `sem_resposta`, `sem_interesse`,
  `sem_verba`, `sem_decisao`, `concorrente`, `fora_do_perfil`, `opt_out`, `bad_timing`,
  `outro`.
- **`opt_out` é terminal e irreversível**: nunca reativa, nem por correção manual
  (reforça AR-005).
- **Reativação** `perdido → novo` é **manual** e auditada (RN-085).
- Erro de transição inválida (4xx) é exibido **inline** na UI — nunca silenciado.

### 2.4 Notas com autoria explícita (append-only)

`lead_notes` é append-only, com `author_type` `'admin' | 'ia'`:

- **Nota do Admin** — escrita pelo operador no painel.
- **Nota da IA** — escrita automaticamente pelo sistema (ex.: "lead tem site, pediu preço").

A distinção é **textual** (rótulo "Nota do Admin" / "Nota da IA"), **nunca só por cor** — cor
exclusiva é invisível para daltônicos e ilegível em contraste alto. Não há edição nem
exclusão de nota pela UI.

### 2.5 Tarefas e lembretes

`tasks`: título, `due_at`, status e **`responsible_user_id` nullable** (R-028 — a coluna existe
desde já, ainda que o MVP tenha um único operador). O painel exibe prazo, status e
responsável, e permite criar, concluir e reabrir.

### 2.6 Copiloto: *suggest-never-send*

- A sugestão nasce em `messages` com `origin='ai_suggestion'` e `status='suggested'` —
  gerada via `LlmPort`, persistida, auditável.
- **Aceitar** e **Editar** só **preenchem o input** de resposta. Nenhum dos dois envia.
- O **envio** acontece **exclusivamente** pelo botão **Enviar** → `POST /api/dispatch` →
  `dispatcher` → `evaluatePolicy` → `sendText`, com `origin='admin'`.
- Em copiloto o bot **nunca** envia sozinho (RN-054, AR-010).
- O histórico é **read-only**: o painel lê `messages`, `status_history`, `handoff_events` e
  `blocked_attempts`; **nenhuma edição ou exclusão** pela UI (D-23).
- A UI **não** usa `dangerouslySetInnerHTML`: React escapa por padrão, e a sugestão da IA é
  texto de terceiro.

### 2.7 Agendamento manual, confirmação e lembrete

- O **Admin registra** a reunião no painel (data/hora/canal). Não há integração de calendário
  externa: o agendamento é manual (R-025).
- O sistema agenda `scheduled_tasks` do tipo `confirmacao` e `lembrete` e enfileira no `outbox`
  com `origin='bot'` — que passa pelo **mesmo gate** (janela e limite diário).
- A confirmação e o lembrete ficam **visíveis no histórico da conversa** (são mensagens do
  sistema, não evento silencioso).
- Resposta do lead pedindo **remarcar ou cancelar** → **handoff** (R-025/AR-003). **A UI não
  tem ação de remarcar/cancelar**: quem decide o novo horário é o Admin, com o bot em silêncio
  até lá.
- O ledger (`scheduled_tasks`) é **anulado** quando a reunião é remarcada — o lembrete do
  horário antigo não pode sair depois da reunião.

### 2.8 Choke-point: nenhum caminho novo de envio

`sendText` existe **somente** em `src/application/dispatcher.ts`. O painel e o copiloto
chamam o **dispatcher**; nunca o canal. Isso é verificável por suíte de choke-point, não por
convenção.

---

## 3. Justificativa

### Por que o funil é uma coluna separada da FSM?

- O estado da máquina responde "o que o motor pode fazer agora"; o funil responde "em que
  etapa comercial o lead está". Colapsar os dois força o `handoff` a parecer uma etapa do
  funil — e o `handoff` não é etapa, é **interrupção**.
- O `closed_reason` do encerramento por não-resposta (motor) e o `pipeline_status='perdido'`
  (funil) descrevem o mesmo evento em dois eixos; a transição fica registrada uma vez, com a
  origem clara.

### Por que motivo obrigatório nos status críticos?

- `reuniao_agendada`, `proposta` e `fechado` são afirmações sobre a **realidade comercial** do
  lead. Uma transição sem justificativa é uma opinião; com justificativa, é um registro
  auditável que responde "por que este lead está aqui?" meses depois.
- Motivo enumerado (e não texto livre) no encerramento torna o funil filtrável — é o que
  alimenta a apuração mensal do piloto (R-061/R-062).

### Por que o motivo é checado no banco?

- `opt_out` como valor de `closed_reason` é **consultável** ("quantos leads saíram por
  opt-out?") e não fica preso na prosa de uma nota.

### Por que notas da IA são `author_type='ia'` e não uma tag?

- A pergunta do Admin ao abrir um lead é "**isto eu escrevi ou a máquina escreveu?**". A
  resposta precisa estar **no dado**, não na convenção: com `author_type`, o filtro é trivial e
  o rótulo textual pode ser derivado dele.

### Por que "Aceitar" não envia?

- Aceitar uma sugestão é um gesto de **leitura**, não de **publicação**. O texto aceito pode
  precisar de ajuste, e enquanto ele está no input, o Admin ainda não disse "manda isso".
- Uma ação que envia em um clique é uma ação que o Admin dispara por reflexo — e um reflexo
  sobre uma sugestão de IA é exatamente como uma mensagem indevida chega ao lead.

### Por que o agendamento é manual?

- R-025 e AR-003 são invariantes: o bot **não** agenda e **não** confirma horário. O que o
  sistema faz é **confirmar e lembrar o que o Admin registrou** — o dado tem origem humana.
- Sem integração de calendário, não existe superfície para o bot "descobrir" um horário e
  tratá-lo como compromisso.

---

## 4. Consequências

### Positivas

- **Um lugar só:** ver, corrigir, anotar, agendar e enviar — sem sair do painel.
- **Funil confiável:** cada transição tem justificativa e histórico append-only.
- **Origem da informação explícita:** toda nota sabe se foi o Admin ou a IA.
- **Nenhum envio fora do gate:** o copiloto é um caminho de *preparação*, não de *publicação*.
- **A LGPD fica contida:** `127.0.0.1` + `Host` + token é um controle barato e real contra
  leitura do CRM pela rede local.
- **Auditoria completa:** status, handoff e tentativas bloqueadas são legíveis, nunca
  editáveis.

### Negativas

- **Densidade de informação:** a coluna da direita acumula sugestões, notas, tarefas e
  histórico — é o custo do painel único (ADR-011).
- **Um cliente HTTP a mais no bundle do SPA** (`apiPatch` para concluir/reabrir tarefa).
- **Sem calendarização:** o Admin precisa registrar data/hora/canal à mão.
- **Motivo obrigatório é atrito:** uma transição para status crítico pede um dado extra ao
  Admin.
- **Motivos enumerados limitam o vocabulário:** um motivo fora da lista vira `outro` + texto
  livre.

### Riscos residuais

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Atalho de UI enviar sugestão sem passar pelo gate | Baixa | Alto | `Aceitar`/`Editar` só preenchem o input; envio só por `Enviar` → `/api/dispatch`; grep de `api/dispatch` na verificação |
| Edição de histórico pela UI | Baixa | Alto | Histórico read-only; grep de controles de editar/excluir |
| XSS via texto de sugestão ou nota | Baixa | Alto | React escapa; `dangerouslySetInnerHTML` proibido |
| PII de notas/tarefas em log do cliente | Baixa | Médio | Sem `console.log` de corpos; erro exibido sem payload |
| Painel exposto na LAN | Baixa | Alto | Bind `127.0.0.1` + guarda de `Host` + token Bearer |
| Lead em `opt_out` reativado por correção | Baixa | Alto | `opt_out` terminal; transição recusada no servidor |
| Encolhimento da fila de tarefas | Média | Baixo | `due_at` visível e ordenação por prazo |

---

## 5. Alternativas consideradas

### Alternativa A — Enviar direto do canal pela UI (fetch ao adapter)

- **Prós:** menos latência; Fewer camadas.
- **Contrás:** contorna o gate — quebra AR-001..AR-012, AR-010 e o choke-point.
- **Por que não:** invariantes são invariantes. O painel envia **pelo dispatcher**.

### Alternativa B — "Aceitar" envia automaticamente

- **Prós:** menos cliques.
- **Contrás:** gesto de leitura vira publicação; mensagem indevida por reflexo.
- **Por que não:** separação explícita entre *preparar* e *enviar* (RN-054).

### Alternativa C — Editar status direto no card, sem diálogo

- **Prós:** mais rápido para o caso comum.
- **Contrás:** perde a justificativa obrigatória e o motivo enumerado — o funil deixa de ser
  auditável.
- **Por que não:** status crítico pede confirmação **com motivo**.

### Alternativa D — Histórico editável

- **Prós:** "corrigir" uma anotação errada.
- **Contrás:** quebra o append-only de `status_history` e `messages` (R-043/R-022); corrigir
  registro se faz com **nova** entrada, não editando a antiga.
- **Por que não:** a trilha é append-only por definição.

### Alternativa E — Integrar calendário externo (Google Calendar)

- **Prós:** confirmação e lembrete automáticos de verdade.
- **Contrás:** quarta integração, fora do escopo do MVP (R-044/R-060); cria superfície para o
  bot "descobrir" horários.
- **Por que não:** o agendamento é manual nesta fase (R-025).

### Alternativa F — Painel em `0.0.0.0` para acesso de outro dispositivo

- **Prós:** operaria o CRM do celular.
- **Contrás:** expõe a base LGPD à LAN; o R-033 não autoriza isso.
- **Por que não:** o bind local é um controle grátis.

---

## 6. Implementação

| Peça | Arquivo |
|---|---|
| Pipeline: 9 status, 9 motivos, status críticos, rótulos pt-BR, transições | `src/domain/pipeline.ts` |
| Rotas de CRM (conversações, status, tags, notas, tarefas, responsável) | `src/api/routes/crm.ts` |
| Consultas de CRM (busca server-side, paginação, histórico de status) | `src/infra/db/queries/crm.ts`, `src/infra/db/queries/status-history.ts` |
| Borda de segurança (`Host` + token Bearer) | `src/api/server.ts`, `src/api/auth.ts` |
| Sugestão e nota automática da IA | `src/application/copilot.ts` |
| Agendamento, confirmação, lembrete e resposta de reagendamento | `src/application/appointment.ts` |
| Choke-point de envio | `src/application/dispatcher.ts` |
| UI: quadro de pipeline, notas, tarefas, copiloto | `src/web/components/PipelineBoard.tsx`, `src/web/components/LeadNotes.tsx`, `src/web/components/TaskList.tsx`, `src/web/components/CopilotPanel.tsx` |
| Cliente HTTP do SPA (`apiPost`, `apiPatch`) | `src/web/api.ts` |
| Integração no painel (visão Painel/CRM, gaveta de lead, histórico compartilhado) | `src/web/App.tsx` |
| Schema do funil e das tabelas de CRM | `src/infra/db/schema.ts`, `src/infra/db/migrations/0008_pipeline_crm.sql` |

**Contrato do envio pelo painel:**

```text
UI (botão Enviar)
  → POST /api/dispatch            { conversationId, text }
  → src/api/routes/dispatch.ts    (borda: Host + Bearer)
  → src/application/dispatcher.ts (choke-point: evaluatePolicy + gate + humanize)
  → sendText                      (só aqui existe)
```

**Contrato da nota:**

```typescript
type LeadNoteAuthorType = "admin" | "ia"; // rótulo textual no painel, nunca só cor
```

---

## 7. Critérios de sucesso da decisão

- **Funil:** os 9 status aparecem com rótulo pt-BR; status crítico exige justificativa;
  `perdido` exige motivo da lista enumerada.
- **Histórico:** visível e **read-only** — nenhuma edição ou exclusão pela UI.
- **Notas:** a nota da IA aparece no lead e é distinguível da nota do Admin por **rótulo
  textual**.
- **Tarefas:** prazo, status e responsável visíveis; criação, conclusão e reabertura
  disponíveis.
- **Copiloto:** a sugestão é exibida; **Aceitar/Editar não enviam**; o envio passa por
  `/api/dispatch` e chega ao lead com `origin='admin'`.
- **Agendamento:** confirmação e lembrete saem do registro manual e aparecem no histórico da
  conversa; **remarcar/cancelar não são ações da UI** — lead que pede isso vai para handoff.
- **Borda:** `Host` fora de `127.0.0.1`/`localhost` → 403; `/api/*` sem Bearer válido → 401.
- **Choke-point:** `sendText` continua existindo **somente** em
  `src/application/dispatcher.ts`.

---

## 8. Referências

- `docs/08-adr/011-painel-unico.md` — painel único, 3 colunas, modo em tempo real
- `docs/08-adr/010-shadow-mode.md` — modo copiloto: a IA sugere, o humano envia
- `docs/08-adr/004-gate-invariantes.md` — gate único e os 12 anti-requisitos
- `docs/08-adr/009-follow-up-conservador.md` — cadência e janela (ADR-014 detalha)
- `docs/08-adr/014-scheduler-cadencia.md` — motor de cadência e dreno
- `docs/01-requisitos-funcionais.md` — R-014, R-021, R-022, R-024, R-025, R-026, R-028
- `docs/03-regras-de-negocio.md` — RN-054, RN-057..RN-062, RN-078..RN-085
- `docs/06-wireframes.md` — wireframes do painel
- `.planning/phases/03-cad-ncia-opera-o-e-painel/03-CONTEXT.md` — D-14..D-25
- R-014, R-021, R-022, R-024, R-025, R-026, R-027, R-028, R-045, R-046, R-059,
  AR-003, AR-004, AR-005, AR-006, AR-010, AR-011, CRM-01, CRM-03, FLUP-06, FLUP-08
