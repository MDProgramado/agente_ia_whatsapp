# Quick Task 261127-001: Fechar os 6 itens abertos da auditoria do merge 3380f3b

**Branch:** `fix/auditoria-27-11b` (base: `origin/main` = `3380f3b`)
**Data:** 2026-11-27
**Modo:** TDD por item (teste vermelho → correção → verde), commits atômicos

## Decisões travadas (discussão com o usuário)

1. **Rotação de dumps:** 30 dias + piso de 3 — apaga só o que tiver >30 dias **e** não estiver entre os 3 mais recentes.
2. **`custo` no pós-gate:** bloquear — "Sem custo para você" sai de LIBERADOS e entra em PROIBIDOS (fail-closed).
3. **`orçamento` no matcher:** atualizar o teste — objeção **com** pedido de orçamento vira handoff; objeção sem, continua gerando contorno.
4. **CI × PR:** checks locais (5 comandos, Postgres no ar) → push → PR → CI verde no GitHub.
5. **Ajuste do usuário na regex (item 5):** substituir três termos largos e incluir as frases de apresentação na lista "têm que continuar passando" (ver Task 5).
6. **Ajuste do usuário no `.gitattributes` (item 2):** exceções CRLF para `.cmd`/`.bat`/`.ps1` (cmd.exe falha com labels/blocos em LF); `npm run format` em **commit separado**, só de finais de linha.

## Tasks

### Task 1 — lifecycle: `aoAbrir` só no `connection: open` real
- **Files:** `src/channel/baileys/lifecycle.ts`, `tests/channel/lifecycle.test.ts`
- **Action:** em `recuperar()`, remover `tentativas = 0` e `deps.aoAbrir()`; em `aoConectar(g)`, chamar `deps.aoAbrir()` sempre que `g === geracao` (sem a condição `!emRecuperacao`).
- **Verify:** teste novo (a) WS aberto sem `open` → `aoAbrir` não chamado; (b) `aoConectar` durante recuperação → `aoAbrir` 1×; (c) pareamento: flag `fasePareamentoInicial` só desliga com `open` real. Testes existentes seguem verdes.
- **Done:** `npm test -- tests/channel/lifecycle.test.ts` verde.

### Task 2 — line endings: biome lf + .gitattributes (2 commits)
- **Files:** `biome.json`, `.gitattributes` (novo)
- **Action:** `biome.json` → `"lineEnding": "lf"`; `.gitattributes` com exceções:
  ```
  * text=auto eol=lf
  *.cmd text eol=crlf
  *.bat text eol=crlf
  *.ps1 text eol=crlf
  ```
  Commit 1 = biome + .gitattributes. Commit 2 = **só** `npm run format` (EOL-only, isolado para revisão).
- **Verify:** `npx biome check .` → 0 erros; `git diff` do commit 2 sem mudança de conteúdo (só EOL).
- **Done:** `npm run lint` verde.

### Task 3 — dados pessoais fora do Git
- **Files:** `.planning/local/replace-map.txt` (novo, gitignored), `.gitignore`, `docs/pendencias.md`
- **Action:** mapa real→fictício em `.planning/local/` (adicionar a pasta ao `.gitignore`); reescrever §Auditoria 27/11 de `docs/pendencias.md` sem valores reais (telefones, LID, nome, e-mail, caminhos); manter lista de commits e a trava de reescrita de histórico.
- **Verify:** `git grep` pelos tokens reais → 0 ocorrências.
- **Done:** pendencias.md sem PII; `.planning/local/` ignorado.

### Task 4 — backup: sessão fora das pastas datadas + piso 3 + rotação após verify
- **Files:** `scripts/backup.ps1`, `tests/ops/backup-rotation.test.ts`, `tests/ops/backup-ps1.test.ts`, `docs/lgpd/retencao-e-eliminacao.md`
- **Action:**
  - `-IncludeAuth` grava em `backups\auth\<timestamp>` (fora das datadas); nunca rotaciona por data; mantém as 3 cópias mais recentes.
  - Dumps: mantém sempre os 3 mais recentes por carimbo; entre os demais apaga só `>30d`.
  - Mover `Remove-BackupsExpirados` para **depois** do verify OK (definição continua no topo — o assert `indexOf < SHOW server_version` segue válido).
  - `-RotateOnly`: rotações rodam, mas nunca apaga se sobrar <3 dumps.
- **Verify:** testes funcionais novos (5 pastas >30d → ficam 3; 2 pastas → nada apaga; 1 recente + 3 antigas → apaga só a mais antiga; `-RotateOnly` com 2 antigas → nada; `pasta-sem-carimbo` intocada).
- **Done:** `npm test -- tests/ops` verde.

### Task 5 — gate de saída: termos de preço/agenda (regex ajustada pelo usuário)
- **Files:** `src/domain/gate/patterns/automation-disclosure.ts`, `tests/gate/ar-001.test.ts`, `tests/gate/ar-003.test.ts`, `tests/gate/post-gate-parity.test.ts`, `tests/adversarial/corpus.ts`, `tests/adversarial/adversarial.test.ts`, `tests/domain/post-gate.test.ts`
- **Action:** adicionar aos termos (vocabulário único compartilhado por guard + pós-gate):
  - `PRICE_TERM`: `|\bcusto\b|\bparcelas?\b|\d+(?:[.,]\d+)?\s?(?:mil|k)\b(?!\s+(?:clientes|empresas|usu[áa]rios|pessoas|seguidores))|\d\s+mensa(?:l|is)\b|\b\d+(?:[.,]\d+)?\s+por\s+m[êe]s\b|\bpor\s+r\$|\bpor\s+\d+(?:[.,]\d+)?\s?(?:mil|k|reais?)\b`
    (substitui `\bpor\s+(?:r\$\s*)?\d`, `\d+(?:[.,]\d+)?\s?(?:mil|k)\b` e `\bmensa(?:l|is)\b`)
  - `SCHEDULE_TERM`: `|\bliga[çc](?:[ãa]o|[õo]es)\b|\bte\s+chamo\b|(?<!\w)(?!24\s?h)\d{1,2}\s?h(?:\d{2})?(?!\w)|\bminutinhos?\b`
  - Testes: 10 frases-alvo bloqueiam; as 5 frases comuns do usuário ("Estamos no mercado por 10 anos.", "Atendemos por 3 estados.", "Atendemos mais de 2 mil empresas.", "Fazemos 1 entrega mensal.") entram em LIBERADOS; "Respondemos em até 2h." fica **bloqueado por decisão do usuário** (aceito, documentado no teste).
  - `tests/domain/post-gate.test.ts`: "Sem custo para você" → PROIBIDOS (`ar001_preco`).
- **Verify:** parity guard × pós-gate verdes; corpus adversarial 10/10.
- **Done:** `npm test -- tests/gate tests/adversarial tests/domain` verde.

### Task 6 — matcher de entrada: dispara/não-dispara
- **Files:** `src/domain/gate/patterns/automation-disclosure.ts`, `tests/application/handoff-intents.test.ts`, `tests/application/qualification.test.ts`
- **Action:** adicionar aos termos de handoff (aditivo, nunca anula a LLM):
  - `HANDOFF_PRICE_TERM`: `|\bvalor(?:es)?\b|\bpre[çc]os?\b|\bproposta\b|\bor[çc]amento\b|\bcobra(?:m|r)?\b|\bquanto\s+(?:custa|fica|[ée]|sai|obra|cobra)\b|\btabela\b`
  - `HANDOFF_SCHEDULE_TERM`: `|\bligar\b|\bliga[çc][ãa]o\b|\bsemana\s+que\s+vem\b`
  - Testes: 9 frases × LLM neutra e LLM falhando → handoff 1 (`triggered_by='keyword'`, `llm.chamadas=[]`); 4 frases neutras → handoff 0 (`llm.chamadas=['extract']`); unitário puro em `detectarGatilhoHandoff`.
  - `qualification.test.ts`: corpo de `objecao_preco` sem pedido de orçamento ("achei um pouco caro, mas me conta mais") + novo caso "me passa um orçamento" → handoff.
- **Done:** `npm test -- tests/application/handoff-intents.test.ts tests/application/qualification.test.ts` verde.

## Verificação final
```
npm run typecheck && npm run lint && npm test && npm run lint:verify && npm run build
```
Depois: `docs/pendencias.md` (fechamento dos 6 itens), `.planning/STATE.md` (linha Quick Tasks), `SUMMARY.md`, `git diff --stat` + lista de testes novos, push e PR (CI verde).

## Fora de escopo
- Nenhum commit de `auth/`, `.env`, códigos de pareamento ou conteúdo real de conversas.
- Nenhum `git filter-repo` / reescrita de histórico.
