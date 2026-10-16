---
phase: 03-cad-ncia-opera-o-e-painel
plan: 03
subsystem: api
tags: [fastify, sse, painel, token, host-guard, 127.0.0.1, rest, kill-switch, dispatch-gate, vitest]

# Dependency graph
requires:
  - phase: 03-cad-ncia-opera-o-e-painel
    provides: "`src/application/dispatcher.ts` (`dispatch(deps, {origin})` como choke-point único), `BarramentoEventos` (canais inbound/signal/clock), `src/cli/mode.ts` (`lerModoOperacional`/`CHAVE_MODO_OPERACIONAL`), motor da cadência fiado no boot (03-02)"
  - phase: 02-ia-externa-e-modo-sombra
    provides: "`messages` append-only + `origin`, `settings.operational_mode`, `daily_counters`, `handoff_events`, `status_history`, `mode_changes`, `channel_accounts.is_active`, `snapshot.ts:loadGateSnapshot`, padrão de `event_log`"
  - phase: 01-funda-o-canal-e-gate-de-envio
    provides: "`ChannelPort`/`criarBaileysChannel`, `loadGateSnapshot`/`evaluatePolicy`, `conversations.state`/`engagement_mode`, `handoff-service`, padronagem de boot (`src/index.ts`)"
  - phase: 03-03 (Task 1, mesmo plano)
    provides: "`src/api/auth.ts` (`requireToken`/`timingSafeEqualStr`), `src/api/server.ts` (`buildServer`/`startPanel` + Host guard + bind literal), `env.PANEL_TOKEN`/`PANEL_PORT`"
provides:
  - "`src/api/routes/leads.ts`: `GET /api/leads` (paginada, busca, filtro status, ordena handoff) e `GET /api/leads/:id` (+ bloco `compliance` LGPD); 404 se ausente"
  - "`src/api/routes/conversations.ts`: `GET /api/conversations/:id` (join lead) e `POST /api/conversations/:id/actions` (pausar/assumir/devolver/copiloto) com transação `FOR UPDATE` + `mode_changes` + `status_history` + `event_log`"
  - "`src/api/routes/messages.ts`: `GET /api/conversations/:id/messages` READ-ONLY (últimas N, teto 200) — nenhuma rota de mutação (D-23)"
  - "`src/api/routes/system.ts`: `GET /api/system` (modo, janela+próxima, contadores, fila de handoff por prioridade) e `POST /api/system/kill-switch` (`confirm:true`; settings + event_log `source:'panel'`, D-20)"
  - "`src/api/routes/dispatch.ts`: `POST /api/dispatch` → `dispatch(origin:'admin')` — único caminho de envio do painel (NFRQ-05)"
  - "`src/api/sse.ts`: `GET /api/events` `text/event-stream` (hello + heartbeat 15s, token exigido) sobre o `BarramentoEventos`; fonte de verdade permanece no Postgres"
  - "`src/index.ts`: painel fiado no boot na MESMA instância/porta (D-17) e fechado no shutdown ANTES do socket/pool"
affects: [03-04 (SPA React), 03-05 (pipeline_status)]

# Tech tracking
tech-stack:
  added:
    - "fastify@5.12.7"
    - "@fastify/static@10.1.6"
  patterns:
    - "Borda única: um hook `onRequest` valida Host (D-18/T-03-11) e token Bearer (T-03-12) ANTES de rota/estático; estático isento de token mas NÃO de Host"
    - "PanelCore injetado: `buildServer({core})` só registra as rotas de API com o núcleo presente; sem core, `/api/*` é 404 — separa o teste de borda pura do teste de integração"
    - "Envio único caminho: nenhuma rota chama o canal; `POST /api/dispatch` invoca `dispatch` com `origin:'admin'` fixado no servidor (fora do corpo Zod)"
    - "Kill switch unificado (D-20): a rota reusa a fonte de verdade do CLI (`settings.operational_mode='paused'`) e audita em `event_log` (`source:'panel'`)"
    - "SSE por `reply.hijack()`: subscribe no `BarramentoEventos`, `hello` inicial, heartbeat `: ping` a cada 15s com `.unref()`, cleanup em `close`/`error`"
    - "Shutdown gracioso: `app.close()` (encerra SSE penduradas) entre o motor da cadência e o socket/pool"

key-files:
  created:
    - src/api/routes/leads.ts
    - src/api/routes/conversations.ts
    - src/api/routes/messages.ts
    - src/api/routes/system.ts
    - src/api/routes/dispatch.ts
    - src/api/sse.ts
    - tests/api/routes.test.ts
    - tests/api/dispatch-gate.test.ts
  modified:
    - src/api/server.ts
    - src/index.ts

key-decisions:
  - "Kill switch reimplementa a transação de `gravarModo` em vez de importá-la: `gravarModo` não é exportado de `cli/mode.ts`, e exportá-lo criaria acoplamento CLI↔API. A rota grava o MESMO efeito (`settings.operational_mode='paused'` + `event_log`) com `source:'panel'` — idêntico em efeito ao `mode pause` do CLI (D-20)."
  - "`agoraDoCore` export removido de `server.ts`: um helper de relógio exportado por `server.ts` e importado por `routes/*` fecharia um ciclo de import de runtime. Cada rota resolve o relógio inline (a partir de `core.agora ?? (() => new Date())`), e o `PanelCore.agora?` continua injetável para teste."
  - "`POST /api/dispatch` devolve o `DispatchResult` do gate sem tradução de `reason`: sent→201, deferred→202, blocked→409, silencio→200. A rota NÃO interpreta a regra (evita duplicar o gate); o cliente lê `action`/`reason` verbatim."
  - "Histórico é read-only por AUSÊNCIA de rota (D-23): não existe `PATCH`/`DELETE` em `.../messages`; `app.inject` de PATCH/DELETE/PUT devolve 404. Os triggers append-only do banco continuam sendo a segunda barreira."
  - "SSE entrega HINTS (`{canal}`), não payloads: a fonte de verdade segue no Postgres (Pitfall 9). O cliente recebe o aviso e re-lê via REST — evita reimplementar o estado no stream."
  - "Painel só sobe DEPOIS de `migrate()`+canal, e NÃO em `BOOT_CHECK_ONLY`: o `launch.cmd check` encerra antes do `listen`, então nenhuma porta é aberta no boot-check."

patterns-established:
  - "Teste de borda×rota sem socket de rede: `buildServer({core})` + `app.inject()` — 401/403/200 provados sem abrir porta (só o teste de SSE faz `listen({port:0})`)."
  - "Core falso por teste: `montarCore(tx)` cria `BarramentoEventos`, `criarFakeChannel` (com `enviados` inspecionável) e `ctx` de gate, e roda dentro de `db.transaction` revertida por sentinela — `messages` jamais sofre DELETE."
  - "Kill switch provado por cruzamento: além de `settings`+`event_log`, o teste chama `loadGateSnapshot` e exige `context.killSwitch === true` (o EFEITO no gate, não só a coluna)."

requirements-completed: [NFRQ-05]

# Metrics
duration: 40min
completed: 2026-10-16
---

# Phase 3 Plan 03: Painel HTTP (REST read-only + ações + envio pelo gate + SSE) Summary

**Painel local servido em `127.0.0.1` por uma única instância Fastify com Host guard e Bearer token, REST read-only sobre o histórico imutável, ações auditadas, kill switch unificado com o CLI e envio que só sai pelo `dispatcher` — com canal SSE de tempo real (heartbeat 15s) e shutdown que não deixa conexão pendurada**

## Performance

- **Duration:** ~40 min
- **Completed:** 2026-10-16 (Task 1 13:03, Task 2 13:20, Task 3 13:25 -03:00)
- **Tasks:** 3 (todas `type="auto"`, sem checkpoint)
- **Files:** 15 do plano (11 `src/` + `package.json` + 3 testes); 12 criados + 4 modificados (com `src/api/server.ts` criado no Task 1 e modificado no Task 2)
- **Suíte:** 357 testes / 62 arquivos verdes (o plano somou 33 testes de API: 13 auth + 15 rotas + 5 dispatch-gate)

## Accomplishments

- **Borda HTTP blindada** (Task 1, T-03-10..T-03-12): `buildServer` registra um `onRequest` que derruba `Host` fora de `{127.0.0.1, localhost}` com `403` (anti-DNS-rebinding) e exige `Authorization: Bearer <PANEL_TOKEN>` em `/api/*` com `401`; `startPanel` faz `app.listen` com bind **literal** `127.0.0.1` (nunca `0.0.0.0`), `bodyLimit` 256 KB e estático isolado em `dist/web` (nunca `DATA_ROOT`).
- **REST completo e read-only sobre o histórico** (Task 2, D-23): `GET /api/leads` (paginada, busca, filtro, ordena handoff ativo primeiro), `/api/leads/:id` (+ compliance LGPD), `/api/conversations/:id`, `/api/conversations/:id/messages`, `/api/system`. Nenhuma rota de mutação de mensagem existe — `PATCH`/`DELETE`/`PUT` devolvem 404, e os triggers append-only do banco seguem como segunda barreira.
- **Ações auditadas** (Task 2): `POST /api/conversations/:id/actions` (`pausar`/`assumir`/`devolver`/`copiloto`) roda em transação com `FOR UPDATE`, grava `mode_changes` + `status_history` + `event_log` (`panel_action`), e `assumir`/`devolver` fazem ack dos handoffs abertos. `devolver` limpa o flag de handoff.
- **Envio pela única porta** (Task 2, NFRQ-05): `POST /api/dispatch` chama `dispatch(deps, {origin:'admin'})`; o `origin` é fixado no servidor (o `dispatchBody` não tem esse campo, então um cliente não forja `bot`). Um texto com preço (`"Fica R$ 3.500..."`) retorna `409 blocked / ar001_preco` com **zero** chamadas ao canal; texto limpo retorna `201 sent` e grava `messages.origin='admin'`.
- **Kill switch unificado** (Task 2, D-20/T-03-19): `POST /api/system/kill-switch {confirm:true}` grava `settings.operational_mode='paused'` + `event_log` (`source:'panel'`), e o teste prova o EFEITO no gate via `loadGateSnapshot` → `context.killSwitch === true`.
- **SSE de tempo real** (Task 2, T-03-18): `GET /api/events` responde `text/event-stream` com `event: hello` e heartbeat `: ping` a cada 15s; exige token como qualquer `/api/*`; publica hints do `BarramentoEventos` sem reimplementar estado (a verdade fica no Postgres).
- **Painel fiado no boot** (Task 3, D-17): `src/index.ts` monta o `PanelCore` e chama `startPanel({core})` depois de `migrate()`+canal, na mesma porta do processo; `encerra()` fecha o painel (`app.close()`, encerrando SSE penduradas) ANTES do socket e do pool.
- **Suíte verde e limpa:** `npm test` → 357 testes / 62 arquivos; `npm run typecheck` limpo; `npm run lint` → 0 erros (16 warnings `noNonNullAssertion` pré-existentes, nenhum em arquivo deste plano).

## Task Commits

Cada task commitada atomicamente:

1. **Task 1: Borda HTTP (Fastify 127.0.0.1 + Host guard + Bearer token)** — `daf5c48` (feat) — 7 arquivos, +1143/−1
2. **Task 2: Rotas REST (read-only + ações + envio pelo gate + kill switch) e SSE** — `29decc9` (feat) — 9 arquivos, +1546/−2
3. **Task 3: Fia o painel HTTP no boot com shutdown gracioso** — `6b12514` (feat) — 2 arquivos, +97/−1

**Plan metadata:** este SUMMARY.

## Files Created/Modified

- `src/api/auth.ts` — **NOVO.** `timingSafeEqualStr(a,b)` (`crypto.timingSafeEqual` sobre buffers de igual comprimento; comprimentos diferentes → `false` sem lançar) e `requireToken(header, token)` (valida `Bearer <token>`)
- `src/api/schemas.ts` — **NOVO.** Zod por rota: `listarLeadsQuery`, `idParams`, `dispatchBody` (sem `origin`), `acaoConversaBody` (enum pausar|assumir|devolver|copiloto), `killSwitchBody` (`confirm: z.literal(true)`)
- `src/api/server.ts` — **NOVO (Task 1), modificado (Task 2).** `buildServer({port?, logger?, core?})` + hook Host/token + `@fastify/static`; `PanelCore{db,bus,dispatchDeps,feriados,agora?}`; registro condicional das 6 rotas; `startPanel` bind literal
- `src/api/routes/leads.ts` — **NOVO.** `GET /api/leads`, `GET /api/leads/:id` (+ `compliance`)
- `src/api/routes/conversations.ts` — **NOVO.** `GET /api/conversations/:id`, `POST .../actions` (transação `FOR UPDATE` + auditoria + ack de handoff)
- `src/api/routes/messages.ts` — **NOVO.** `GET /api/conversations/:id/messages` (read-only, LIMITE 50 / TETO 200)
- `src/api/routes/system.ts` — **NOVO.** `GET /api/system`, `POST /api/system/kill-switch`
- `src/api/routes/dispatch.ts` — **NOVO.** `POST /api/dispatch` → `dispatch(origin:'admin')`
- `src/api/sse.ts` — **NOVO.** `registrarSse(app, core)`: `GET /api/events` (`hijack`, `hello`, heartbeat 15s `.unref()`)
- `src/config/env.ts` — `PANEL_TOKEN` (`z.string().min(1)`, nunca em `settings`), `PANEL_PORT` (default 8787)
- `package.json` / `package-lock.json` — `fastify@5.12.7`, `@fastify/static@10.1.6` (`--save-exact`)
- `src/index.ts` — **modificado.** Import `startPanel`/`PanelCore`; `painelApp` no escopo do módulo; etapa (m) chama `startPanel({core: corePainel})`; `encerra` fecha o painel
- `tests/api/auth.test.ts` — **NOVO.** 13 casos (Host 403, token 401/passa, `timingSafeEqualStr`, bind literal)
- `tests/api/routes.test.ts` — **NOVO.** 15 casos (guarda de token, leituras, integração de boot, read-only 404, kill switch→snapshot, SSE content-type)
- `tests/api/dispatch-gate.test.ts` — **NOVO.** 5 casos (corpo 400, silêncio, R-001 409, AR-preço 409 `ar001_preco`, liberado 201 `origin='admin'`)

## Decisions Made

- **Kill switch reusa a fonte, não o código.** `gravarModo` não é exportado de `cli/mode.ts`; a rota grava o mesmo efeito (`settings` + `event_log`) com `source:'panel'` em vez de acoplar CLI↔API. D-20 é sobre o EFEITO (mesma `settings.operational_mode`), não sobre compartilhar o símbolo.
- **`agoraDoCore` removido.** Um helper de relógio exportado por `server.ts` e consumido por `routes/*` fecharia um ciclo de import de runtime; cada rota resolve o relógio inline e `PanelCore.agora?` continua injetável.
- **`reason` do gate passa verbatim.** A rota de dispatch traduz só para status HTTP (sent/deferred/blocked/silencio → 201/202/409/200); não reinterpreta a regra — reinterpretar seria duplicar o gate.
- **Read-only por ausência de rota.** Não há PATCH/DELETE de mensagem; o 404 é a expressão de D-23, com os triggers append-only como rede de segurança.
- **SSE como hint.** O stream avisa "mudou X"; o cliente re-lê via REST. Isso mantém a fonte de verdade única (Postgres, Pitfall 9) e evita um segundo modelo de estado no stream.
- **Boot-check não abre porta.** `startPanel` fica depois do `return` de `BOOT_CHECK_ONLY`, então `launch.cmd check` valida o stack sem `listen`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Ciclo de import de runtime `server.ts` ↔ `routes/*`**
- **Found during:** Task 2 (ao fiar as rotas ao núcleo)
- **Issue:** Um helper `agoraDoCore` exportado por `server.ts` e importado por cada rota criaria um ciclo de import de runtime (`server` → `routes` → `server`), com risco de binding indefinido na inicialização.
- **Fix:** Cada rota resolve o relógio inline (`core.agora ?? (() => new Date())`) e as rotas importam apenas o TIPO `PanelCore` (`import type`), que não gera dependência de runtime.
- **Files modified:** `src/api/server.ts`, `src/api/routes/*.ts`
- **Committed in:** `29decc9` (Task 2)

**2. [Rule 2 - Missing Critical] Comentário de `dispatch.ts` continha o literal `sendText`**
- **Found during:** Task 2 (verificação do aceite `grep -c "sendText" src/api == 0`)
- **Issue:** O comentário de cabeçalho citava `` `channel.sendText` ``; o teste de choke-point (regex `\.sendText\s*\(`) passava porque não há parêntese, mas o grep literal do aceite contava 1.
- **Fix:** Comentário reescrito para "a única chamada efetiva de envio ao canal" — o grep literal agora conta 0 e o choke-point segue verde.
- **Files modified:** `src/api/routes/dispatch.ts`
- **Committed in:** `29decc9` (Task 2)

**3. [Rule 3 - Blocking] Ordem de imports/format do Biome nos arquivos novos**
- **Found during:** Task 2/3 (`npm run lint` → 2 erros)
- **Issue:** `organizeImports`/format do Biome (`{ startPanel, type PanelCore }` → `{ type PanelCore, startPanel }`) reprovavam o lint — bloqueia o gate de CI (o plano exige lint limpo).
- **Fix:** `npx biome check --write` aplicado só nos arquivos deste plano (nunca nos testes pré-existentes com warnings).
- **Files modified:** `src/api/*`, `tests/api/*`, `src/index.ts`
- **Committed in:** `29decc9` e `6b12514`

---

**Total deviations:** 3 auto-fixed (1 Rule 1, 1 Rule 2, 1 Rule 3)
**Impact on plan:** Sem scope creep. Um ciclo de import evitado, um ajuste de comentário para o aceite literal, e format exigido pelo gate de lint. Nenhum desvio arquitetural (Rule 4 não disparou).

## Deferred / Known Limitations

**1. O SPA (`dist/web`) ainda não existe — o estático é condicional**
`buildServer` só registra `@fastify/static` se `dist/web` existir. Até o 03-04 compilar o SPA pelo Vite, a raiz `/` devolve 404 — o que é correto: não há UI para servir. A API (`/api/*`) está completa e testada independentemente.

**2. `POST /api/dispatch` não trata mídia (por desenho)**
O corpo é `{conversationId, text}` — sem campo de mídia. R-037/AR-004 são satisfeitos por ausência de superfície: não há rota que aceite imagem/áudio/vídeo.

**3. Warnings de lint pré-existentes (fora de escopo)**
`npm run lint` reporta 16 warnings `noNonNullAssertion` em `tests/application/inbound-fromme.test.ts` e `lead-importer.test.ts` — de outras fases, nenhum em arquivo deste plano. Exit code 0.

## Issues Encountered

- **Nenhum bloqueio.** O contrato de `PanelCore` e o mapa de status HTTP foram resolvidos por leitura das fontes de verdade (03-UI-SPEC §Interaction & State Contract, `dispatcher.ts`, `cli/mode.ts`) antes da implementação.
- **Descoberta de schema:** `conversations` tem `state` (9 valores, `conversations_state_check`) E `engagement_mode` (6 modos: `bot_active`/`awaiting_human`/`human`/`copilot`/`pausado`/`shadow`) — as ações do painel mexem nos DOIS (ex.: `pausar` → `state='pausado'`, `engagement_mode='pausado'`), o que a UI-SPEC exige.
- **Descoberta de gate:** `leadNumeroInvalido(null) === false` e `leads.wa_validation_state` usa MAIÚSCULAS (`VALIDO`/`NUMERO_INVALIDO`/`DESCONHECIDO`) enquanto `snapshot.ts` mapeia minúsculas — `'VALIDO'` cai em `null` e NÃO bloqueia. Comportamento congelado em teste (mismatch pré-existente, fora do escopo deste plano).

## User Setup Required

- **`PANEL_TOKEN`** (obrigatório): um segredo local em `.env` (dev) — não vai para `settings` nem para log. **`PANEL_PORT`** (opcional, default 8787). Sem `PANEL_TOKEN` o boot falha no `envSchema.parse` (fail-closed).

## Next Phase Readiness

- **Pronto para o 03-04 (SPA React):** o contrato REST/SSE completo existe e está testado — o painel pode ser construído contra `/api/*` sem tocar o backend. Basta compilar o SPA em `dist/web` que o `@fastify/static` o serve.
- **Atenção do 03-05:** `pipeline_status` continua ausente; `/api/system` e as ações não dependem dele, mas a UI de funil do 03-05 vai querer a coluna nova.
- **Contrato congelado (NFRQ-05):** nenhuma rota pode ganhar um caminho de envio; só `POST /api/dispatch`. O `choke-point.grep.test.ts` prende isso no build.
- **Risco de rede (R-033/T-03-10):** o bind é literal `127.0.0.1` e o Host é validado — nenhuma exposição de LAN.

---

*Phase: 03-cad-ncia-opera-o-e-painel*
*Completed: 2026-10-16*

## Self-Check: PASSED

- Arquivos do plano: 15/15 reconciliados (11 `src/` + `package.json` + 3 testes); 12 criados, 4 modificados (`src/api/server.ts` criado no Task 1 e modificado no Task 2).
- Commits: `daf5c48`, `29decc9`, `6b12514` — presentes em `git log --oneline`.
- Verificações do plano: `npm test` → 357 testes / 62 arquivos verdes; `npm run typecheck` limpo; `npm run lint` → 0 erros (16 warnings pré-existentes).
- AC estrutural: `grep -c "sendText" src/api` → 0; `grep -c "0.0.0.0" src/api/server.ts` → 0; literal `127.0.0.1` presente; `startPanel` em `src/index.ts` → 3 ocorrências.
- AC de borda: Host inválido → 403; token ausente → 401; kill switch reflete em `loadGateSnapshot.killSwitch` → `true`.
- Choke-point: `tests/lint/choke-point.grep.test.ts` verde (único `.sendText(` continua `src/application/dispatcher.ts`).
