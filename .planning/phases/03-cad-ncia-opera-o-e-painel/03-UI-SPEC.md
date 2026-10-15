---
phase: 3
slug: cad-ncia-opera-o-e-painel
status: draft
shadcn_initialized: false
preset: none
created: 2026-10-15
---

# Phase 3 — UI Design Contract

> Contrato visual e de interação do **Painel Único** (R-046 / NFRQ-05) e do **CRM operacional** (CRM-01, CRM-03) da Fase 3. Gerado por `gsd-ui-researcher`, verificado por `gsd-ui-checker`, consumido por `gsd-planner`/`gsd-executor`.
>
> **Idioma da interface: português do Brasil (pt-BR).** Todo texto visível ao Admin — rótulos, botões, estados vazios, erros, confirmações, notificações — é escrito em pt-BR. Os cabeçalhos de seção deste documento permanecem em inglês para parsing do checker.
>
> **Fonte primária das decisões visuais:** `docs/06-wireframes.md` (9 telas ASCII) e `docs/08-adr/011-painel-unico.md` (layout 3 colunas, indicadores de modo, cores, atalhos, kill switch). As decisões desta fase vêm de `03-CONTEXT.md` D-17..D-25. **Nenhuma dessas fontes é re-litigada aqui — elas são consumidas.**

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none (manual Tailwind CSS v4) |
| Preset | not applicable |
| Component library | none — primitivos nativos (`<dialog>`, `<details>`, ARIA) + utilitários Tailwind |
| Icon library | Lucide React (MIT, tree-shakeable, offline após instalar) — substitui os emojis dos wireframes |
| Font | system UI stack: `system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` (zero download, offline-safe no Windows) |

**shadcn gate — resultado:** executado. `components.json` **não existe** e a stack é React + Vite, o que normalmente pede shadcn. Porém o artefato de pesquisa **já decidiu o contrário**: `.planning/research/STACK.md` §53 escolhe Tailwind CSS 4.3.3 explicitamente para "rapid iteration on a dense 4-pane layout **without a component library dependency**", e o SUMMARY §38 confirma "Fastify 5.12.5 + React 19 + Vite 8 + Tailwind 4". Como só existe **uma** fase de UI (a Fase 4 reusa o painel sem analytics), o benefício de consistência cross-fase do shadcn é baixo. **Decisão: `Tool: none`, Tailwind CSS v4 configurado manualmente.** Registry safety gate: **not applicable**.

**Stack de UI (pré-populado de `03-CONTEXT.md` D-17/D-18 + `STACK.md`):**
- React 19 + Vite 8 (SPA compilada para estáticos), servida por **Fastify + `@fastify/static`** no **mesmo processo/porta**, bind **`127.0.0.1`** (nunca `0.0.0.0`), **sem CORS**.
- Tempo real por **SSE** (`EventSource`, reconexão automática) — **não** WebSocket. Eventos: nova mensagem inbound, mudança de modo, handoff, sugestão da IA, contador diário, janela, erro crítico.
- **Tema:** dark por padrão (wireframes §11 + ADR-011 §7). Tema claro **fora do escopo** desta fase — o contrato fixa o dark.
- **Desktop-only** (Windows). Mobile/responsividade **fora de escopo** (ADR-011 §4).
- **Sem Electron/Tauri.** O painel é uma aba do navegador em `127.0.0.1`.

---

## Spacing Scale

Escala de 8 pontos (múltiplos de 4 apenas):

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Gaps entre ícone e rótulo, padding inline de chips/tags, separação de linhas de metadados |
| sm | 8px | Espaçamento compacto entre elementos, padding interno de badges/dots, padding vertical de linha de lista |
| md | 16px | Espaçamento padrão: padding de coluna, gaps entre blocos do painel lateral, padding de bolha de chat |
| lg | 24px | Padding de seção, separação entre sub-painéis do painel lateral, altura de respiro do cabeçalho |
| xl | 32px | Gaps de layout entre as 3 colunas, padding de estado vazio |
| 2xl | 48px | Quebras maiores de seção (ex.: separação entre painel principal e rodapé de auditoria) |
| 3xl | 64px | Espaçamento de nível de página (só usado em estados vazios de tela cheia) |

**Exceptions:**
- **Alturas de linha e controles densos (painel desktop mouse-driven):** linha da lista de leads `56px` (2 linhas: nome + status/tags); linha de tabela do CRM `40px`; linha de item de menu/dropdown `32px`; altura do compositor de chat `48px`.
- **Alvos clicáveis de ícone:** mínimo **32×32px** (alvo de mouse). **Não** se aplica o alvo tátil de 44px — a interface é desktop-only (ADR-011 §4). Botões de ação rápida com rótulo usam mínimo `36px` de altura.
- **Largura das colunas do painel:** lista de leads `320px` (colapsável), painel lateral direito `360px` (colapsável), coluna central `flex-1` com mínimo `480px`. Colunas colapsáveis atendem o risco "tela sobrecarregada" (ADR-011 §4).
- **Cabeçalho fixo:** `56px`; banners de estado (kill switch ativo / handoff) são full-width abaixo dele.

---

## Typography

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body | 14px | 400 | 1.5 |
| Label | 14px | 400 | 1.4 |
| Heading | 16px | 600 | 1.3 |
| Display | 20px | 600 | 1.2 |

- **3 tamanhos** (14 / 16 / 20) e **2 pesos** (400 regular / 600 semibold). **Nenhum uso de 700/bold.**
- **Minimum 14px** respeitado em toda a UI (wireframes §11: "tamanho mínimo 14px"). Sem texto abaixo de 14px.
- **Label** distingue-se do Body por **caixa alta + `letter-spacing` 0.04em + cor muted** (não por tamanho nem por novo peso). Uso: cabeçalhos de coluna, rótulos de metadado ("STATUS", "ORIGEM", "BASE LEGAL"), timestamps.
- **Display** é exclusivo de: título da tela ativa, e o **indicador de modo** ("BOT ATIVO" / "MÃO HUMANA ATIVA — BOT EM SILÊNCIO").
- **Números tabulares** (`font-variant-numeric: tabular-nums`) em: contador diário (`12 / 30`), timestamps de mensagem, contagem de handoffs, valores de data das tarefas.
- **Fonte:** system UI stack (Segoe UI no Windows). **Nenhum web font baixado** — offline-first e zero flash de fonte.

---

## Color

Tema **dark** (padrão do projeto). Base: paleta Tailwind *slate* + *blue*.

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `#0F172A` (slate-900) | Fundo da aplicação, superfície base, fundo do chat |
| Secondary (30%) | `#1E293B` (slate-800) | Superfícies de coluna/painel/cabeçalho, itens de lista, modais; bordas `#334155` (slate-700) |
| Accent (10%) | `#3B82F6` (blue-500) | Ver lista "Accent reserved for" abaixo |
| Destructive | `#EF4444` (red-500) | Kill switch, registrar opt-out, falha crítica, lead bloqueado |

**Texto:** primário `#E2E8F0` (slate-200); muted/secundário `#94A3B8` (slate-400); invertido sobre accent `#F8FAFC`.

**Accent reserved for (lista exata — nunca "todos os elementos interativos"):**
1. Botão primário **"Enviar"** (ação explícita de envio — R-046/NFRQ-05).
2. **Indicador de modo "BOT ATIVO"** (o modo AUTO usa accent como sua cor de estado).
3. **Linha do lead selecionado** na lista.
4. **Anel de foco** (`focus-visible`, 2px).
5. **Links** dentro do chat e do histórico (R-042 permite links).
6. **Indicador "Ao vivo"** da conexão SSE quando ativa.

Todo o resto (botões secundários, ícones, cabeçalhos, bordas) usa neutros slate — **não** o accent.

**Cores semânticas de estado** (distintas do split 60/30/10; são o núcleo informacional do painel — ADR-011 §6.2 + wireframes §11):

| Estado | Cor | Onde |
|--------|-----|------|
| Positivo — Qualificado / Aquecido / Reunião agendada / Fechado | `#22C55E` (green-500) | Dot de status na lista, badge de pipeline |
| Atenção — Respondeu / modo **COPILOTO** | `#F59E0B` (amber-500) | Dot de status, pill de modo |
| Handoff — pendente/aguardando Admin | `#F97316` (orange-500) | Badge de fila de handoff, banner de handoff |
| Perigo — **SILÊNCIO** / bloqueio de gate / falha crítica | `#EF4444` (red-500) | Pill de modo, banner de bloqueio, erros |
| Neutro — Novo / Contatado / modo **PAUSADO** | `#94A3B8` (slate-400) | Dot de status, pill de modo |
| Terminal — **Perdido** | `#64748B` (slate-500) | Dot de status (apagado) |

**Regra de acessibilidade de cor:** nenhum estado é comunicado **só por cor**. Cada modo/status tem ícone Lucide + rótulo textual + cor. Contraste mínimo AA 4.5:1 para texto.

---

## Copywriting Contract

Todos os textos são **pt-BR literal** — o executor deve copiá-los, não parafraseá-los.

| Element | Copy |
|---------|------|
| Primary CTA | **"Enviar"** — botão que despacha a resposta/sugestão pelo gate (`origin='admin'`). Só habilita com ação explícita + texto não vazio + janela aberta. |
| Empty state heading | **"Nenhuma conversa selecionada"** (coluna central sem lead ativo) |
| Empty state body | **"Selecione um lead na lista à esquerda para ver a conversa, as sugestões, o histórico e as ações rápidas."** |
| Error state | **"Envio bloqueado pelo gate: {motivo}. Nada foi enviado ao lead."** — problema (bloqueio) + solução (o Admin decide o próximo passo; o estado está seguro). |
| Destructive confirmation | **"Pausar toda a automação"**: type-to-confirm — *"Digite PAUSAR para confirmar. Nenhuma mensagem automática sairá até você retomar."* |

### Supplementary copy (obrigatória — telas e estados do painel)

**Modo (indicador em tempo real — D-19, cabeçalho):**

| Estado | Rótulo | Ícone | Cor |
|--------|--------|-------|-----|
| AUTO | **"BOT ATIVO"** | `bot` | accent blue |
| COPILOTO | **"COPILOTO — BOT NÃO ENVIA"** | `user-check` | amber |
| PAUSADO | **"BOT PAUSADO"** | `pause` | slate |
| SILÊNCIO | **"MÃO HUMANA ATIVA — BOT EM SILÊNCIO"** | `mic-off` | red |

**Motivo do silêncio (exibido abaixo do modo quando em SILÊNCIO/COPILOTO):** `"Motivo: {gatilho}"` — valores: `Pedido de preço`, `Intenção de agendar`, `Pergunta se é bot/IA`, `Irritação`, `Ameaça de denúncia`, `Mídia recebida`, `Opt-out`, `Dúvida técnica complexa`.

**Banner de handoff (no topo da coluna central):** *"⚠ HANDOFF ACIONADO — Motivo: {motivo}. Bot em silêncio até você assumir."* + botão **"Assumir conversa"**.
**Banner de kill switch ativo (full-width, fixo):** *"AUTOMAÇÃO PAUSADA — nenhuma mensagem sai até você retomar."* + botão **"Retomar automação"**.
**Contador diário (cabeçalho):** `"Mensagens hoje: {n} / 30"` e `"Contatos novos: {n} / 20"`; ao exceder: `"Limite atingido — fila espera o próximo dia útil"` (amber).
**Janela operacional (cabeçalho):** aberta → *"Janela aberta (fecha 17:00)"* (verde); fechada → *"Janela fechada (abre {seg, 07:00})"* (slate) + Enviar desabilitado.
**Estado vazio — nenhum lead:** heading **"Nenhum lead ainda"** / body **"Importe leads da API de caça-leads ou aguarde a ingestão do dia. O primeiro contato é sempre manual — o bot nunca inicia conversa."**
**Estado vazio — sem sugestões:** **"Sem sugestões no momento. O bot sugere quando o lead responder."**
**Estado vazio — fila de handoff:** **"Nenhum handoff pendente."**
**Estado vazio — notas:** **"Nenhuma nota ainda."** / **"Nenhuma tarefa ainda."**
**Busca sem resultado:** **"Nenhum lead encontrado para “{termo}”."** + **"Ajuste os filtros ou tente outro termo."**
**Erro — WhatsApp desconectado:** **"WhatsApp desconectado. O bot não está enviando. Reconecte o canal para retomar."**
**Erro — banco indisponível:** **"Banco de dados indisponível. O painel está em modo somente leitura."**
**Erro — SSE perdido:** **"Conexão com o painel perdida. Reconectando…"**
**Erro — envio falhou:** **"Não foi possível enviar. A mensagem ficou na fila e será reenviada na próxima janela."**
**Confirmação destrutiva — opt-out:** *"Registrar opt-out: esta ação é permanente e não pode ser desfeita. O lead nunca mais receberá contato."* (type-to-confirm `OPTOUT`).
**Confirmação — marcar Perdido:** exige motivo (select obrigatório de `closed_reason`), sem type-to-confirm.
**Sugestão da IA (copiloto):** rótulo **"Sugestão do copiloto — revise antes de enviar"**; botões **"Aceitar"**, **"Editar"**, **"Ignorar"**.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none — shadcn **não inicializado** (`components.json` ausente) | not required |
| third-party | none | not applicable |

**Resultado do gate:** `components.json` ausente + stack React/Vite, mas decisão upstream (`STACK.md` §53 / SUMMARY §38) é Tailwind **sem** componente-library. `Tool: none`. Nenhum registry declarado ⇒ **gate de vetting de registry não se aplica**. A única dependência de UI adicionada além de React/Vite/Tailwind é `lucide-react` (biblioteca de ícones MIT, tree-shakeable, sem acesso a rede/env).

---

## Component Inventory

Inventário de componentes que o executor deve construir (sem component library — primitivos Tailwind + HTML nativo). Consumido pelo `gsd-planner` para gerar tasks.

| Componente | Coluna/Tela | Notas |
|------------|-------------|-------|
| `AppShell` | global | Grid de 3 colunas + cabeçalho fixo + barras de estado (kill switch/handoff) |
| `HeaderBar` | cabeçalho | Logo "AUTOMAÇÃO WHATSAPP", status do canal, número dedicado, indicador de modo, contador diário, janela, badge de handoff, botão kill switch |
| `ModeIndicator` | cabeçalho | Pill Display 20/600, ícone + rótulo + cor; transição animada na mudança (ADR-011 §4) |
| `ConnectionIndicator` | cabeçalho | Estado SSE: "Ao vivo" (accent) / "Reconectando…" (amber) / "Sem conexão" (red) |
| `DailyCounter` | cabeçalho | `Mensagens {n}/30`, `Contatos novos {n}/20`, tabular-nums |
| `WindowStatus` | cabeçalho | "Janela aberta/fechada" + próxima abertura |
| `SilenceReason` | cabeçalho/chat | Motivo do silêncio; visível só em SILÊNCIO/COPILOTO |
| `HandoffQueueBadge` | cabeçalho | Contagem de handoffs pendentes; priority-sorted |
| `KillSwitchButton` + `KillSwitchBanner` | cabeçalho + full-width | Confirmação type-to-confirm `PAUSAR`; banner fixo quando ativo (D-20) |
| `LeadList` | esquerda | Virtualizada; ordenação por prioridade (handoff > não respondido > recente) |
| `LeadListItem` | esquerda | Dot de status + nome + empresa/contexto + status + tags; altura 56px |
| `SearchBar` / `FilterBar` / `TagFilter` | esquerda | Busca server-side por nome/telefone/status/tags (D-22) |
| `ChatPanel` | centro | Histórico append-only + gatilho inline + banner de handoff |
| `MessageBubble` | centro | Remetente (Você/Lead), timestamp tabular, estado de entrega; **sem mídia** (AR-004) |
| `TriggerIndicator` | centro | `⚠ GATILHO: {motivo}` inline na mensagem que disparou handoff |
| `Composer` | centro | Textarea + botão "Enviar" (accent) + indicador de modo; desabilitado fora de janela/handoff sem assumir |
| `HandoffAlert` | centro | Banner + "Assumir conversa" |
| `SuggestionCard` | direita | Sugestão IA + Aceitar/Editar/Ignorar (R-014/FLUP-06) |
| `LeadHistoryPanel` | direita | Status, origem, base legal, finalidade (R-064) |
| `PipelineBoard` / `PipelineListItem` | CRM | Kanban de 9 status + modo lista; "Perdido" com motivo |
| `StatusBadge` / `ModePill` | global | Sempre ícone + texto + cor (nunca só cor) |
| `CompliancePanel` | detalhe do lead | Origem/base legal/finalidade/opt-out; acciones opt-out com confirmação |
| `NotesList` / `TaskList` | detalhe do lead | Append-only; `author_type='admin'|'ia'` |
| `LeadDetailDrawer` | overlay | `<dialog>` com abas Conversa/Notas/Tarefas/Histórico/Compliance (wireframes §4) |
| `AuditTimeline` | detalhe | Lê `messages`+`status_history`+`handoff_events`+`blocked_attempts` — **read-only** (D-23) |
| `ConfirmDialog` | global | `<dialog>` nativo com focus-trap; type-to-confirm como variante |
| `Toast` | global | Sucesso (discreto) / erro não-crítico (amber) |
| `ErrorPanel` | tela | Logs/falhas filtráveis por severidade (R-045) |
| `EmptyState` / `Skeleton` | global | Estados vazios e carregando obrigatórios por coluna |

---

## Interaction & State Contract

### Escala de estado do painel (tempo real, SSE)
1. **Carregando (boot):** skeletons nas 3 colunas; cabeçalho mostra "Conectando…".
2. **Ao vivo:** SSE conectado; `ConnectionIndicator` = "Ao vivo" (accent); UI recebe pushes de mensagem/modo/handoff/contador.
3. **Reconectando:** `EventSource` reconecta sozinho; banner discreto "Reconexão em andamento…" (amber). Dados exibidos permanecem, marcados como "podem estar desatualizados".
4. **Offline/erro:** banner "Conexão com o painel perdida. Reconectando…" (red); ações de escrita desabilitadas até reconectar.

### Ordem de prioridade da fila de handoff
`suspeita de automação` → `irritação` → `ameaça de denúncia` → `pedido de preço` → `intenção de agendar` → `mídia recebida` → `dúvida complexa` → demais, e por timestamp (FIFO) dentro de cada grupo. Handoffs pendentes aparecem **sempre no topo** da lista de leads (ADR-011 §6.8).

### Ciclo de vida da sugestão (copiloto)
`sugerida` → (`Aceitar` | `Editar` | `Ignorar`). **"Enviar" só existe como ação explícita** e o texto passa pelo **mesmo gate** com `origin='admin'` (D-24). O bot **nunca** envia sozinho em copiloto (FLUP-06). Sugestão aceita/editada que o gate bloqueie → mostra o erro de gate e **não** envia.

### Botão "Enviar" — motivos de desabilitação (tooltip obrigatório)
- *"Fora da janela (dias úteis 7h–17h)"* — força `WindowStatus` fechada.
- *"Handoff ativo — assuma a conversa para responder"* — modo SILÊNCIO.
- *"Automação pausada (kill switch)"*.
- *"Cota diária atingida — a mensagem ficará na fila do próximo dia útil"*.
- *"Digite uma mensagem."* — composer vazio.

### Estados por tela (todos obrigatórios)
- **Lista de leads:** loading (skeleton) / vazio / sem-resultado-de-busca / erro-de-carregamento (retry).
- **Chat:** sem-lead-selecionado / carregando / ativo / handoff-ativo.
- **Sugestões:** sem-sugestão / gerando / sugerida / bloqueada-pelo-gate.
- **CRM:** vazio / carregando / erro.
- Todo estado vazio usa `EmptyState` com o texto da seção **Copywriting Contract**.

### Notificação & chime (D-21)
- `notify.ps1` (som + pop-up nativo) é a notificação **primária** — inalterada.
- **Chime Web Audio** no navegador é **redundância**: dispara quando um handoff chega via SSE. Nunca substitui o `notify.ps1`.

### Motion (ADR-011 §4 — "Admin não perceber mudança de modo" = risco ALTO)
- Mudança de modo: transição de cor/fundo `150ms` no `ModeIndicator` + pulso único `600ms`.
- Chegada de handoff: banner entra em `200ms` + chime.
- `prefers-reduced-motion`: desliga pulso e transições; o rótulo textual continua mudando.
- Sem animações decorativas contínuas (custo visual em operação prolongada).

---

## Accessibility & Keyboard

- **Atalhos** (ADR-011 §6.6): `Ctrl+Shift+K` kill switch · `Ctrl+Shift+A` assumir · `Ctrl+Shift+D` devolver ao bot · `Ctrl+Shift+P` pausar bot do lead · `Ctrl+Shift+Enter` aceitar sugestão · `Ctrl+Shift+N` nova nota · `Ctrl+Shift+T` nova tarefa · `Esc` cancelar ação.
- **Focus visível** obrigatório: anel accent 2px (`focus-visible`) em todos os controles.
- **`<dialog>` nativo** para `ConfirmDialog`, `KillSwitchButton` e `LeadDetailDrawer` — focus-trap e `Esc` do próprio elemento.
- **Regiões vivas:** `aria-live="assertive"` para chegada de handoff/falha crítica; `aria-live="polite"` para modo, contador e janela.
- **Nunca cor sozinha:** modo e status sempre com ícone + rótulo textual + cor.
- **Contraste AA (4.5:1)** para texto primário e muted sobre as superfícies slate.
- **Alvos de mouse ≥ 32×32px** (desktop; sem requisito tátil de 44px nesta fase).

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending
