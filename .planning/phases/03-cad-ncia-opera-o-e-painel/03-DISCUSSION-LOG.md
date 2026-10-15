# Phase 3: Cadência, Operação e Painel - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-10-15
**Phase:** 3-Cadência, Operação e Painel
**Areas discussed:** Motor de cadência e scheduler, Janela de negócio / feriados / próximo dia útil, Detecção de não-resposta e encerramento, Modelo de pipeline/status, Painel único, CRM operacional e copiloto, Documentação/ADRs

> **Modo `--auto`:** todas as áreas foram auto-selecionadas e a opção recomendada foi escolhida sem `question`, em **passada única**. Cada log abaixo marca `[auto]`. As decisões das Fases 1 e 2 (D-01..D-23) foram **consumidas**, não re-litigadas.

---

## Motor de cadência e scheduler (03-01)

| Option | Description | Selected |
|--------|-------------|----------|
| `scheduled_tasks` (ledger) + `outbox` (fila gateada) | Reusa SKIP LOCKED/lease/re-gate já provados; ledger audita cancelamentos | ✓ |
| `outbox` apenas | Menos tabelas; perde `cancelled_reason`/`task_type` auditável | |
| `pg-boss` | Nova dependência + quarta superfície; nada novo que o `outbox` não faça | |

**Escolha:** `scheduled_tasks` = ledger auditável; `outbox` = fila de envio gateada. Sem `pg-boss`.
**Notas:** `[auto]` Cadência ancorada no último toque (1h/1d/3d/7d); `follow_up_index` é o cursor; resposta inbound zera. Tick `croner` 30s no mesmo processo + reconciliador de órfãos. Idempotência `(conversation_id, follow_up_index)` + `idempotency_key='flup:{conv}:{index}'`. Misfire `FIRE_ONCE` (`CATCH_UP` proibido). Dreno de catch-up: ≤3 nos primeiros 10 min, 1 follow-up/lead/dia, jitter 3–12s, adiado nunca descartado; `isCatchupDrain` como **parâmetro**. R-001 reforçado: contato frio nunca automatizado.
**Conflito resolvido:** ROADMAP 03-01 dizia "máx. 2 toques automáticos sem resposta → handoff"; SC1 + FLUP-03 exigem 4. Resolução: **4 toques** (supersession), configurável até o teto 4 em `settings.followup.max_touches` (D-02).

---

## Janela de negócio, feriados e "próximo dia útil" (03-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Feriados BR locais (in-repo + override em `settings`) | Local-only, versionado, testável | ✓ |
| API/pacote externo de feriados | Dependência de rede; viola local-only | |
| Sem feriados (só fim de semana) | Não cumpre o ROADMAP 03-01 | |

**Escolha:** lista local `src/domain/feriados-br.ts` (fixos + móveis derivados da Páscoa) + override `settings.calendar.holidays`.
**Notas:** `[auto]` `ehDiaUtil` passa a considerar feriado; `nextWindow` pula feriado. "Próximo dia útil" = próximo dia útil às 07:00 no fuso da conversa (America/Sao_Paulo). **Reconciliação RN-009 × AR-007:** o dreno "ao abrir o app" só envia **dentro** da janela; fora dela, apenas enfileira (D-11).

---

## Detecção de não-resposta e encerramento (03-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Resposta = mensagem inbound (read receipts não contam) | Confiável no canal tctoken/LID | ✓ |
| Read receipts contam como resposta | Não confiável; riscos de LID | |

**Escolha:** resposta = inbound; watermark `conversations.last_inbound_at`.
**Notas:** `[auto]` Após a 4ª tentativa sem inbound → cadência encerrada e lead **PERDIDO** com motivo `sem_resposta` (RN-021/RN-084), registrado em `status_history`.

---

## Modelo de pipeline/status (03-03)

| Option | Description | Selected |
|--------|-------------|----------|
| `conversations.pipeline_status` separado de `state`/`stage` | Separa CRM (RN-078) da FSM do motor | ✓ |
| Reusar `stage` como pipeline | Conflaria FSM e CRM; tiga valores | |
| Reusar `state` | FSM vazaria para o CRM | |

**Escolha:** coluna nova `conversations.pipeline_status` (9 valores, default `novo`), transições em `status_history`.
**Notas:** `[auto]` Motivos de Perdido enumerados em `closed_reason` (`sem_resposta`, `sem_interesse`, `sem_verba`, `sem_decisao`, `concorrente`, `fora_do_perfil`, `opt_out`, `bad_timing`, `outro`). Status críticos exigem justificativa (RN-082). Reativação manual (RN-085); `opt_out` **irreversível**.

---

## Painel único (03-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Fastify + SSE + React localhost (1 processo, 1 porta) | Sem CORS/Electron; tempo real; secure context | ✓ |
| Fastify + WebSocket | SSE basta (unidirecional servidor→painel) | |
| Electron/Tauri | Segunda Chromium/toolchain; adiar | |

**Escolha:** Fastify (bind `127.0.0.1`) + SSE + React (Vite) via `@fastify/static`; token Bearer por request + validação de `Host`; sem CORS.
**Notas:** `[auto]` Layout 3 colunas (ADR-011) + modo em tempo real ("BOT ATIVO" vs "MÃO HUMANA ATIVA — BOT EM SILÊNCIO") + motivo do silêncio + contador diário + janela + fila de handoff. Kill switch = botão com type-to-confirm → `settings.operational_mode='paused'` (mesma fonte do CLI `mode`). **Chime Web Audio** incluído como redundância da notificação local (deferido da Fase 2).

---

## CRM operacional e copiloto (03-03)

| Option | Description | Selected |
|--------|-------------|----------|
| Tabelas próprias (`tags`/`lead_tags`/`lead_notes`/`tasks`) + copiloto pelo gate | CRM separado de `messages`; IA sugere, Admin envia | ✓ |
| Guardar notas em `messages` | Conflaria CRM com histórico de conversa | |
| Copiloto envia sozinho | Viola FLUP-06/RN-054 | |

**Escolha:** tabelas novas de CRM (append-only onde couber; `responsible_user_id` nullable); copiloto sugere (`messages(origin='ai_suggestion')`), Admin envia pelo gate com `origin='admin'`.
**Notas:** `[auto]` Histórico imutável read-only (`messages`/`status_history`/`handoff_events`/`blocked_attempts`). Agendamento **manual**: Admin registra → `scheduled_tasks` (`confirmacao`/`lembrete`) → `outbox` → gate; remarcar/cancelar → **handoff** (R-025/AR-003). Sem integração de calendário.

---

## Documentação, ADRs e reconciliação (03-03)

| Option | Description | Selected |
|--------|-------------|----------|
| ADRs novos (014, 015) + migração de docs; ADR-009 autoridade | Rastreável e imutável | ✓ |
| Só ajustar docs sem ADR | Perde a trilha de decisão | |

**Escolha:** `docs/08-adr/014-scheduler-cadencia.md` e `docs/08-adr/015-pipeline-crm-copiloto.md`; reconciliar `docs/01-requisitos-funcionais.md` (R-004/R-005/R-058) e `docs/03-regras-de-negocio.md` (RN-009) com o ADR-009.
**Notas:** `[auto]` ADR-009 permanece autoridade da cadência; `isCatchupDrain` documentado como parâmetro.

---

## the agent's Discretion

- Valores exatos de `settings.followup.*` (jitter, limites do dreno, tamanho de lote do tick), respeitando os tetos de D-02/D-07.
- Conteúdo literal das mensagens de follow-up (variadas, RN-019) e de confirmação/lembrete.
- Fonte/forma exata da lista de feriados e formato de `settings.calendar.holidays` (local e testável).
- Estrutura do SSE, nomes de endpoints e desenho visual fino (o contrato visual é do `/gsd-ui-phase`).
- Modelagem fina de `lead_notes`/`tasks`/`tags` (nomes/índices), com `responsible_user_id` nullable.

## Deferred Ideas

- **Break-up message** (FLUP-11, v2) — decisão com dado do piloto (Fase 4).
- **Migração para a API oficial** do WhatsApp (R-016) — fase futura.
- **Multiusuário ativo** (R-027/EQUP) — v2.
- **Analytics avançado / relatórios além do contador diário** — v2.
- **Aquecimento controlado (5 fases)** (R-039/R-040) — fora do MVP.
- **Electron/Tauri** — fase futura.
- **Contrato visual detalhado do painel** — `/gsd-ui-phase`.
- **Dependência (risco, não escopo):** pareamento físico do número (P-004, `01-03` deferido) ainda pendente.
