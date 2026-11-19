---
phase: 03-cad-ncia-opera-o-e-painel
plan: 07
subsystem: ui
tags: [react, fastify, sse, event_log, auditoria, read-only, telemetria]

# Dependency graph
requires:
  - phase: 03-cad-ncia-opera-o-e-painel/03-03
    provides: "Borda HTTP do painel, Fastify, token Bearer e anti-DNS rebinding"
  - phase: 03-cad-ncia-opera-o-e-painel/03-04
    provides: "useSse, SystemHeader, painel base React"
  - phase: 03-cad-ncia-opera-o-e-painel/03-06
    provides: "LeadDetailDrawer, rotas de auditoria, LGPD"
provides:
  - "GET /api/system/events — event_log read-only com filtro de severidade (debug|info|warn|error|critical) e paginação com teto de 200 itens"
  - "`ErrorPanel` — tela em `<dialog>` com chips de filtro de severidade, busca paginada, payload formatado e tratamento de banco indisponível"
  - "`ConnectionIndicator` — componente com ícone + rótulo textual + cor no cabeçalho (Ao vivo / Conectando / Reconectando / Sem conexão)"
  - "Extensão de `useSse` e `api.ts` com tipagem e método `buscarEventos`"
  - "Testes TDD em `tests/api/system-events.test.ts` cobrindo os 5 comportamentos da rota de eventos"
affects: [NFRQ-04, NFRQ-05, R-045, painel, telemetria]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Event log estritamente read-only: consulta direta em `event_log` ordenada por `created_at desc` para usar o índice existente `event_log_created_idx`"
    - "Acessibilidade no cabeçalho: indicador de conexão com ícone Lucide + rótulo pt-BR + classe de cor, nunca dependendo exclusivamente de cor"
    - "Proteção contra DoS na listagem: paginação com validação Zod limitando pageSize <= 200"

key-files:
  created:
    - src/web/components/ErrorPanel.tsx
    - src/web/components/ConnectionIndicator.tsx
    - tests/api/system-events.test.ts
  modified:
    - src/api/routes/system.ts
    - src/api/schemas.ts
    - src/web/api.ts
    - src/web/components/SystemHeader.tsx
    - src/web/App.tsx

# Metrics
test-counts:
  total: 431
  passed: 431
  failed: 0
typecheck: clean
biome: clean
web-build: clean
---

# Sumário do Plano 03-07: Eventos, Falhas e Indicador de Conexão

Entrega concluída do plano **03-07** (o último plano da Fase 3 — Cadência, Operação e Painel):

1. **Endpoint `GET /api/system/events` (R-045, NFRQ-04):**
   - Rota estritamente read-only sobre `event_log`.
   - Suporte a filtro opcional por `severity` (`debug`, `info`, `warn`, `error`, `critical`).
   - Paginação validada com Zod, impondo teto rígido de 200 registros por página (`pageSize <= 200`).
   - Ordenação `ORDER BY created_at DESC` utilizando o índice nativo `event_log_created_idx`.
   - Cobertura completa por testes TDD em `tests/api/system-events.test.ts`.

2. **Componentes Web do Painel (UI-SPEC §Component Inventory):**
   - **`ConnectionIndicator`:** Exibição do estado do canal SSE ("Ao vivo", "Conectando…", "Reconectando…", "Sem conexão") com ícone (`Wifi`/`WifiOff`) + texto + cor sem depender exclusivamente de cor.
   - **`ErrorPanel`:** Modal nativo `<dialog>` com chips de filtro de severidade, paginação "Carregar mais", visualização estruturada dos payloads JSON formatados e mensagem literal em caso de indisponibilidade do banco.
   - **`SystemHeader` & `App.tsx`:** Botão "Eventos e falhas" integrado no cabeçalho ao lado do status de conexão, abrindo o modal de telemetria.

3. **Validação e Qualidade:**
   - `npm run typecheck` (Node + Web): 0 erros.
   - `npx @biomejs/biome check`: 0 erros / 0 warnings.
   - `npm run web:build`: build Vite gerado com sucesso.
   - Suíte de testes: **431 testes passando em 70 arquivos de teste**.

