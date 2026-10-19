---
phase: 03-cad-ncia-opera-o-e-painel
plan: 03-04
subsystem: painel-web
tags: [web, vite, react, sse, ui, tailwind]
dependency-graph:
  requires: [03-03]
  provides: [dist/web, api-client, ui-components]
  affects: [panel-ui]
tech-stack:
  added: [vite@8.3.1, @vitejs/plugin-react@5.0.4, tailwindcss@4.3.3, @tailwindcss/vite@4.3.3, lucide-react@1.57.0]
  patterns: [spa, sse-fetch, type-to-confirm]
key-files:
  created: [vite.config.ts, tsconfig.web.json, src/web/index.html, src/web/main.tsx, src/web/App.tsx, src/web/api.ts, src/web/useSse.ts, src/web/styles.css, src/web/components/LeadList.tsx, src/web/components/ChatPane.tsx, src/web/components/MessageHistory.tsx, src/web/components/SystemHeader.tsx, src/web/components/SuggestionCard.tsx, src/web/components/ActionBar.tsx, src/web/components/HandoffQueue.tsx, tests/web/build.test.ts]
  modified: [package.json, package-lock.json, tsconfig.json, biome.json]
decisions:
  - "Vite serves src/web; build outputs dist/web for Fastify static"
  - "Fetch-based SSE (EventSource replacement via ReadableStream) for re-sync/backoff"
  - "Kill switch with type-to-confirm 'PAUSAR' in dialog (D-20)"
  - "Suggestion actions (Accept/Edit/Ignore) never send; only Enviar dispatches"
metrics:
  duration: "2h"
  completed-date: 2026-10-16
requirements-completed: [NFRQ-05]
---

# Phase 03 Plan 03-04: Painel Web (SPA base + layout 4 painéis + copiloto) Summary

Scaffolded Vite+React+Tailwind SPA at `src/web/`, built 4-pane dense layout with real-time SSE, action bar with gate-controlled send, type-to-confirm kill switch, and suggestion card. Web build outputs to `dist/web` (served by Fastify) and typecheck + build pass. Web build test covers API client behavior (401 → token_invalido, dispatch non-throwing on blocked/deferred) and structural guard for copilot not auto-sending.

## What Was Built

### SPA Scaffold (Task 1)
- **vite.config.ts**: `root: 'src/web'`, `plugins: [react(), tailwindcss()]`, `build.outDir: '../../dist/web'`, `base: '/'`, `emptyOutDir: true`. No `baseUrl`.
- **tsconfig.web.json**: `jsx: 'react-jsx'`, `lib: ['DOM','ES2023']`, `types: ['vite/client']`, `noEmit: true`, strict. Root `tsconfig.json` excludes `src/web` and `tests/web`.
- **package.json**: added deps (`react@19.3.0`, `react-dom@19.3.0`, `vite@8.3.1`, `@vitejs/plugin-react@5.0.4`, `tailwindcss@4.3.3`, `@tailwindcss/vite@4.3.3`, `lucide-react@1.57.0`), scripts `web:dev`, `web:build`, `typecheck` (runs both tsconfigs), `build` = `tsc --noEmit && vite build`.
- **src/web/**: `index.html`, `main.tsx`, `App.tsx` (4-area shell), `api.ts` (typed REST client matching 03-03 contract), `styles.css` (Tailwind v4 tokens + theme vars).
- **biome.json**: excludes `dist`, enables Tailwind directives domain only for `src/web` (avoids false positives).

### Layout + Realtime (Task 2)
- **SystemHeader**: exact mode strings — `BOT ATIVO`, `MÃO HUMANA ATIVA — BOT EM SILÊNCIO`; counters `Mensagens hoje: X / Y`, window state, handoff count. Uses lucide-react icons.
- **LeadList**: keyboard navigation (`onKeyDown`, focusable rows), states (loading/empty/error), selection.
- **ChatPane** + **MessageHistory**: conversation rendering, read-only history (no edit/delete). PT-BR copies.
- **HandoffQueue**: handoff items display.
- **useSse.ts**: fetch-based SSE hook with exponential backoff reconnect + resync. No `EventSource` dependency, reconnect with jitter/backoff on errors/stream end.
- **App.tsx**: composes 4 panes, token gate (localStorage or `?token=`), kill switch wiring, assumir action.

### Actions + Copilot + Alerts (Task 3)
- **SuggestionCard**: shows AI suggestion with label **"Sugestão do copiloto — revise antes de enviar"**, actions **Aceitar**, **Editar**, **Ignorar** (exact literal per UI-SPEC; no "Descartar"). No dispatch — only fills input (Accept/Edit focus toggle). 
- **ActionBar**: composer + **Enviar** → `POST /api/dispatch` (server decides sent/blocked/deferred); displays result (blocked shows gate reason, deferred shows scheduled time). Quick actions Pausar/Assumir/Devolver ao bot/Copiloto → `POST /api/conversations/:id/actions`. **Kill switch** `<dialog>` with type-to-confirm requiring exact string `PAUSAR` to enable destructive action; posts to `/api/system/kill-switch`. Disable reasons include window closed, daily limit, handoff active, paused.
- **Notifications + chime (D-21)**: on handoff signal via SSE, request Notification permission explicitly and play Web Audio chime; degrade silently if denied.
- **Icons**: lucide-react@1.57.0 only (no emoji icons).

### Tests
- **tests/web/build.test.ts**: asserts `dist/web/index.html` + script tag after `web:build`, vite config emits to `dist/web` without `baseUrl`, `apiGet` sends Bearer header and 401 maps to `token_invalido`, `apiPost` dispatch doesn't throw on blocked/deferred; structural guard: SuggestionCard has no send paths (`enviarMensagem`, `apiPost`, `/api/dispatch`, `fetch(`) and uses exact labels.

## Deviations from Plan
None - plan executed exactly as written.

## Verification
- Typecheck: `tsc --noEmit && tsc --noEmit -p tsconfig.web.json` — **PASSED**
- Web build: `npm run web:build` — **PASSED** (outputs `dist/web/` with assets)
- Web tests: `tests/web/build.test.ts` — **PASSED** (9 passed)

## Self-Check: PASSED
- All key files created exist (SPA scaffold + components + build config)
- Build outputs to dist/web with index.html and assets
- Type-to-confirm kill switch and copilot guard verified in code/tests
- Commit history shows 3 commits for 03-04 (test, feat scaffold, feat layout/actions)

## Known Stubs
None. UI components are wired to API contracts from 03-03.
