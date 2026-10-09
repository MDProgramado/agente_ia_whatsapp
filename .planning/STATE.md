---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-10-09T19:25:00.000Z"
progress:
  total_phases: 4
  completed_phases: 0
  total_plans: 5
  completed_plans: 3
  percent: 60
---

# Estado do Projeto

## Referência do Projeto

Ver: `.planning/PROJECT.md` (atualizado 2026-09-28)

**Valor central:** Quando o bot assume uma conversa, conduz com naturalidade suficiente para gerar reuniões agendadas sem nunca cruzar uma fronteira proibida — e para no instante exato em que o humano precisa assumir.
**Foco atual:** Phase 1 — Fundação, Canal e Gate de Envio

## Posição Atual

Fase: 1 de 4 (Fundação, Canal e Gate de Envio)
Plano: 4 de 5 na fase atual (01-01, 01-02 e 01-04 concluídos; 01-03 com checkpoint humano pendente)
Status: Executing Phase 01
Última atividade: 2026-10-09 — Wave 3: plano 01-04 (Gate de envio: os 12 anti-requisitos) concluído com 4/4 tasks. Os 12 ARs têm property test; a ordem canônica do gate (`GUARD_ORDER` ↔ `GUARD_SLOTS`) é travada por teste; o `outbox` durável reavalia o gate por job; e o choke-point único de `sendText` é provado por grep (só `src/application/dispatcher.ts`). Suíte total 25 arquivos / 101 testes verdes, `tsc` e biome limpos. O plano 01-03 (canal e ingestão) teve a automação commitada, mas o checkpoint humano de pareamento QR (P-004 `CREDS_INVALID`) segue em aberto — não bloqueia 01-04/01-05.

Progresso: [██████░░░░] 60% (3 de 5 planos concluídos; 5 de 5 planejados)

## Métricas de Desempenho

**Velocidade:**

- Planos concluídos: 3
- Duração média: ~218 min (01-01: 150 min; 01-02: 240 min; 01-04: 263 min)
- Tempo total de execução: ~653 min

**Por Fase:**

| Fase | Planos | Planejados | Executados | Média/Plano |
|------|--------|-------------|------------|-------------|
| 1. Fundação, Canal e Gate | 5 | 5 | 3 | 218 min |
| 2. IA, Handoff e Shadow | 3 | 0 | 0 | — |
| 3. Cadência, Operação e Painel | 3 | 0 | 0 | — |
| 4. Piloto, Calibração e Apuração | 2 | 0 | 0 | — |

*Atualizado após cada plano concluído*

## Contexto Acumulado

### Decisões

Decisões completas em PROJECT.md (tabela Key Decisions). Recentes que afetam o trabalho atual:

- **Gate antes do LLM, sem exceção:** `PolicyGate` (Fase 1) precede `LlmPort` (Fase 2); CONV-14 corrigido para a Fase 1 no roadmap.
- **R-001 é restrição transversal:** primeira mensagem sempre manual — mitigação técnica primária anti-463; nenhuma fase automatiza primeiro contato.
- **Baileys `7.0.0-rc14` pin exato** (`--save-exact`): a linha 6.7.x não tem tctoken/463/APIs de quota.
- **Auth state + backups fora do OneDrive** (COMP-05): path concreto a decidir no plano 01-01 (ex.: `C:\whatsapp_prospecao\`).
- **Shadow mode é gate de P1:** Fase 2 valida fala e guardrails sem consumir a tolerância do número; saída da F2 exige relatório shadow.
- **R-019 corrigido pela pesquisa:** `onWhatsApp()` volta ao escopo; estado terminal NUMERO_INVALIDO.
- **R-023 com 2ª trava dura:** contatos novos/dia via `fetchNewChatMessageCap()`; 463 nunca retryado.
- **Ambiente resolvido 2026-09-28 (pós-pesquisa Fase 1):**
  - **Baileys `7.0.0-rc14` confirmado** despite `AGENTS.md` §STACK.md fixar a linha `6.7.x`. As fontes do projeto (PROJECT.md Key Decisions, STATE.md, 01-CONTEXT.md D-01/specifics) decidem rc14 porque a linha `6.7.x` não tem tctoken/erro-463/APIs de quota — sem elas, WHS-04 e LEAD-03 ficam sem implementação. `AGENTS.md` é snapshot de pesquisa pré-projeto. **✅ RESOLVIDO em 2026-09-29 (preflight do plano 01-01):** bloco `GSD:stack-*` de `AGENTS.md` corrigido (zero ocorrências de `6.7.24`), nota de pin de projeto inserida no topo do bloco, e decisão registrada em `docs/adr/001-pin-baileys-rc14.md` (ADR-001, Aceito).
  - **PostgreSQL 18.3 é o alvo** (o STACK.md autoriza "17.x **ou 18.x se já instalado**"; 18.3 está instalado e `pg_dump`/`pg_restore` são 18.3 = mesma major do servidor). Sem migração de dados. **✅ Confirmado em 2026-09-29:** `psql` e `pg_dump` reportam `18.3`; os outros bancos da máquina (`auth`, `pizzaria_db`, `vidracaria`, `vidracaria_test`) não foram tocados.
  - **Node 24 LTS é o alvo.** **✅ RESOLVIDO em 2026-09-29:** instalado e ativo `v24.21.0` (via `fnm`, com o diretório de instalação na `PATH` do usuário). Registrado em ADR-001 §"Registro de ambiente".
- **`DATA_ROOT` definido: `C:\whatsapp_prospecao`** (2026-09-29, preflight do plano 01-01). Subpastas `auth\`, `backups\` e `logs\` criadas; `(Get-Item 'C:\whatsapp_prospecao').Attributes` = `Directory`, **sem** `ReparsePoint` nem `Offline` — ou seja, fora do OneDrive. A guarda `DATA_ROOT_ON_ONEDRIVE` aborta o boot se isso mudar.

### Decisões do Plano 01-01 (2026-09-30, walking skeleton)

- **Guard 0 (R-001) fica FORA da numeração AR-001..AR-012.** AR-001 é preço; R-001 é primeiro contato. Numerar R-001 como AR-000 inventaria uma categoria que não existe em `docs/10-anti-requisitos.md`.
- **A ordem de avaliação do gate é invariante, não detalhe:** kill switch → Guard 0 (R-001) → AR-001..AR-011 na ordem de `docs/10-anti-requisitos.md`. A ordem mora em `src/domain/gate/guard-order.ts` e é **testada**, não documentada.
- **`sendText` tem exatamente um chamador de produção:** `src/application/dispatcher.ts:164`. O invariante é a *ausência* de um segundo caminho, e a barreira de lint o mantém. Daqui saem os 12 anti-requisitos.
- **Registro do AUMID é best-effort e não-fatal.** AUMID controla o *nome* do toast, não a emissão. Um registro de branding que bloqueia o alerta é risco maior que o nome genérico que ele evita — e R-013 exige que o Admin seja avisado.
- **Som toca ANTES do toast** no `notify.ps1`: se a sessão de áudio estiver em erro, o script falharia depois de já ter emitido o toast e R-013 perderia a notificação silenciosamente.
- **Título nunca vai para o log de notificações.** Pode carregar trecho de conversa com o lead (R-064) e o arquivo sobrevive à rotação de retenção. O log registra `title_chars` — quanto, nunca o quê.
- **3 defeitos graves encontrados por leitura e travados em `tests/gate/regressoes.test.ts`** (nenhum era coberto por teste do plano):
  1. **Kill switch invertido** — `coalesce(is_active) as kill_switch` ligava o botão de emergência na conta ativa, e o gate **bloqueava toda mensagem do sistema**. Era o pior possível: o produto inteiro mudo.
  2. **AR-004 barrava todo link** — `p.kind !== "text"` tratava `link` como mídia, violando R-042.
  3. **`blocked_attempts` perdia todo negativo** — `db.execute` com string solta deixava `$1..$3` sem bind, e nenhuma rejeição do gate ia para a trilha de auditoria (R-022).

### Decisões do Plano 01-02 (2026-10-05, invariantes no banco + dossie LGPD)

- **Compliance de R-043, R-024 e LEAD-04 mora no banco, não no código.** Trigger *e* `REVOKE`, porque um bug de aplicação vira erro de banco, não uma violação silenciosa de LGPD.
- **`optout_ledger` e `handoff_events` têm retenção INDEFINIDA** — o inverso do resto do documento. Uma prova de opt-out que expira é uma prova que o titular pode exigir que exista, e `leads.opt_out` não tem backfill: se o registro sumir e um importador novo rodar, o bloqueio vai com ele.
- **O canal de atendimento do titular NUNCA é a conversa de WhatsApp.** Consequência direta de R-043: se o bot confirmasse o recebimento de um pedido de eliminação, o pedido ficaria gravado em `messages`, que é append-only. O sistema não pode guardar para sempre a única prova do que o titular pediu para apagar. O procedimento é escrito para não depender do bot em nenhum passo.
- **Testes de trigger conectam por `Pool` cru, nunca `openDb`.** `openDb` roda `migrate()` antes de devolver o handle, então o teste confirmaria o trigger por efeito colateral do runner que acabou de aplicar a migration.
- **`fn_preencher_blocked_attempt` deriva `guard_id` a partir do motivo.** A coluna é NOT NULL porque um negativo sem guard identificado não é auditável, e NOT NULL sem caminho de preenchimento só produz erro.
- **R-033: o risco maior é a autenticação do Baileys, não a criptografia do banco.** `listen_addresses = localhost` mitiga de verdade e é verificável por `SHOW`, mas a pasta `auth_info_baileys` **é** o número dedicado: perdê-la faz o WhatsApp ver "dispositivo novo", que já é sinal de ban (R-059). Registrado no ADR-002 com 5 condições de reabertura.
- **BOM UTF-8 em `postgresql.conf` é regra do projeto, não recomendação.** PowerShell prepende `EF BB BF` e o PostgreSQL recusa subir; editar só por Notepad, VSCode ou `System.IO.File::WriteAllText`. Registrado em `AGENTS.md`.
- **Migration de guards é `0004_guards_and_audit.sql`, não `0001`.** O plano citava `0001`, mas esse número já era `channel_accounts_phone_e164_unique.sql` do plano 01-01; `0002` e `0003` estavam aplicados.
- **Pendências rastreadas em `docs/pendencias.md`** (P-001 `Register-Aumid` best-effort resolvido por decisão; P-002 `icacls` no Scope 2 de `pg-hba-apply.ps1` aberto).

### Decisões dos Planos 01-03 e 01-04 (2026-10-09)

- **Plano 01-03 (canal e ingestão) — automação commitada, checkpoint de pareamento aberto.** `session.ts` (`CREDS_INVALID`), `capabilities.ts` (`fetchNewChatMessageCap`/`fetchAccountReachoutTimelock`), `jid-resolver.ts` (LID↔PN), `signals.ts` (463 sem retry), `adapter.ts` (sendText-only), `inbound-handler` (`first_contact_by_human` só por `fromMe`) e `lead-importer` entregues. O pareamento QR real **não** foi concluído: **P-004 `CREDS_INVALID`** (ver `01-03-DIAG.md` e `docs/pendencias.md`).
- **Plano 01-04 — os 12 anti-requisitos fechados por teste.** 5 guardas restantes (AR-002, AR-005, AR-009, AR-010, AR-012) + `lead-number-invalid` (R-019/LEAD-03); `evaluatePolicy` com **15** invariantes em ordem fixa e `AR_MAP` de 18 entradas.
- **Ordem do gate é contrato executável:** `GUARD_SLOTS` (execução) e `GUARD_ORDER` (contrato do plano) são comparados por teste; par a par prova-se que o menor índice vence. Um motivo só existe no código se existir na ordem.
- **Choke-point por varredura de fonte, não por guard de runtime.** "Todo envio passa pelo dispatcher" é uma afirmação sobre *ausência de segundo caminho*; o teste varre `src/**/*.ts` por **chamada** `\.sendText\s*\(` e exige exatamente `src/application/dispatcher.ts`. O AC literal (proibir a *declaração* de `sendText(`) é insatisfatível — a porta declara o método.
- **AC do dispatcher usa a grafia do schema:** `blocked_attempts.guard = 'R-001'` (grafia do requisito) e `rule_reference = <GateReason>` (`r001_primeiro_contato_nao_humano`); o trigger `fn_preencher_blocked_attempt` deriva `guard` quando nulo.
- **2 ampliações de padrão (Rule 2):** `CURRENCY_TERM` passou a cobrir moeda em símbolo/sigla/extenso (US$/EUR/dólar) — AR-001; `SCHEDULE_TERM` passou a cobrir conjugações (`agendei`/`agendou`) e dias `*-feira`, sem casar `agenda`/`segunda opção` — AR-003.
- **Bug corrigido em `snapshot.ts` (Rule 1):** `db.execute` devolve TIMESTAMP como **string**; o helper `paraIso` ancorou strings ingênuas como UTC e o AR-011 passou a comparar corretamente. Teste de deferimento passou a comparar timestamp em texto (`::text`).
- **`types.ts` congelado neste plano:** TTL de `wa_validation_state = 'desconhecido'` adiado (não há timestamp de validação no `GateInput`); só `"invalido"` bloqueia (`leadNumeroInvalido`).
- **`outbox` durável:** status `pending|reserved|sent|failed|abandoned`, idempotência por `idempotency_key`, cota reservada na **mesma transação** do branch `send` (bloqueio não consome cota). O dreno reavalia o gate **por job** — teste prova que opt-out ligado após o enqueue faz o job virar `abandoned`.
- **Comentário enganoso de `ar-009.ts` adiado** (afirma precedência sobre ar-010, mas a ordem real é ar-010 → ar-009): registrado em `.planning/phases/01-funda-o-canal-e-gate-de-envio/deferred-items.md`; doc-only, fora de escopo.

### Todos Pendentes

De `.planning/todos/pending/`:

Nenhum ainda.

### Bloqueios/Preocupações

- ⚠️ **API do caça-leads não especificada** (schema, auth, rate limit) — bloqueia LEAD-01 na integração (não a arquitetura); decidir forma do insert antes (AR-011 exige `legal_registered_at` na criação).
- ⚠️ **R-059 (número único, sem redundância)** — risco dominante aceito e documentado; mitigação: shadow mode, kill switch, appeal preparado, exportação contínua do CRM.
- 🔴 **R-013 (notificação local) — `WpnUserService` PARADO nesta máquina (2026-09-30).** A Task 6 do plano 01-01 está implementada e verificada por código, mas a **exibição** não acontece: a gravação passa (`Show()` sem erro, linha criada em `wpndatabase.db`, log `toast_sent`) e a entrega nunca ocorre (`LastNotificationAddedTime` não é atualizado). Evidência de que é do Windows e não do código: **nem o toast com AUMID nativo do PowerShell aparece, nem um balloon via `NotifyIcon`**, que nem passa pela camada WPN. Foco Assistente desligado, nenhuma política, sessão `console` local (não RDP), toggle de Notificações ligado (confirmado pelo Admin), `explorer`/`ShellExperienceHost`/`StartMenuExperienceHost`/`RuntimeBroker` todos rodando. `Start-Service WpnUserService` é recusado — é serviço *template* por usuário. `notify.ps1` está correto; o defeito é do SO. **Decisão do Admin: reiniciar o Windows e revalidar depois.** Comando de revalidação: `npm run notify -- -Title "Teste R-013" -Message "Verificacao" -Urgent`.
  - **Consequência de projeto se o reboot não resolver:** R-013 é load-bearing (handoff, opt-out e mídia recebida dependem de o Admin *saber* que precisa agir). O **som** é o único canal já verificado como independente do WPN (`Hand.Play()` sem exceção, áudio OK) e já toca com `-Urgent`. Decisão pendente: tornar o som o sinal primário de alerta, com o toast como complemento.
- ⚠️ **`CHANNEL_PHONE_E164` no `.env` está com o placeholder `+5511999999999`.** O número dedicado real precisa entrar **antes do pareamento QR** (Task 3 do plano 01-03). O CHECK do banco aceita o placeholder, então nada quebra até lá — mas número errado no canal é erro sem recuperação barata.
- ⚠️ **`fetchNewChatMessageCap()` / `fetchAccountReachoutTimelock()`** — confirmadas nos typings do `@whiskeysockets/baileys@7.0.0-rc14` durante o plano 01-03 (ADR-001); ver `capabilities.ts`.
- ⚠️ **P-004 — pareamento do 01-03 não concluído (`CREDS_INVALID`).** A automação do canal está commitada, mas o número dedicado ainda não pareou. Diagnóstico em `.planning/phases/01-funda-o-canal-e-gate-de-envio/01-03-DIAG.md`. Não bloqueia 01-04/01-05 (o gate e a fila não dependem do socket vivo para os testes).
- ⚠️ **`icacls.exe` falha no Scope 2 de `scripts/pg-hba-apply.ps1`** (2026-10-01, Task 3 do plano 01-02): o temporário em `%TEMP%` é deletado antes da chamada, o script aborta e a senha do role teve de ser trocada manualmente via `psql`. Bug de ordenação, não de conceito. Rastreado como **P-002** em `docs/pendencias.md`. Não bloqueia nada — o efeito desejado foi alcançado manualmente.
- ⚠️ **`Restart-Service postgresql-x64-18` exige PowerShell elevado.** Falha silenciosa como não-admin. Qualquer script futuro que reinicie o serviço precisa checar elevação antes de chamar, em vez de tratar o retorno vazio como sucesso.
- ⚠️ **O gate `<automated>` da Task 4 dependia de conteúdo, não de existência.** Os 5 documentos LGPD passaram a gate em `77bb7df` com apenas 5 de 12 checks. Um gate que só verifica presença de arquivo não detecta um documento que existe e não diz nada — os 7 checks de conteúdo (`optout_ledger`, `erasure_request`, `listen_addresses`, `PREENCHER`, `pg_dump`, hifen) existem exatamente por isso. Considerar o mesmo padrão nos próximos planos com gate.

### Resolvidos em 2026-09-29 (preflight do plano 01-01, Task 1)

- ✅ **Node 24.21.0 LTS instalado e ativo** — era bloqueante de qualquer `npm install`. `node --version` = `v24.21.0`; `npm --version` = `11.19.0`; diretório do fnm inserido na `PATH` do usuário para que shells novos resolvam o runtime correto (o `launch.cmd` depende do binário real, não de `npx node@24`).
  - Armadilha de `PATH` (reproduzida em 2026-09-29, custo ~10 min): um processo já aberto **antes** da mudança de `PATH` continua resolvendo `C:\Program Files\nodejs\node.exe` (**v22.14.0**) e reporta a versão errada — foi assim que o preflight pareceu ter falhado quando não falhou. Shell novo resolve v24.21.0. Antes de concluir que o Node 24 "não está instalado", rodar `fnm list` e conferir a `PATH` do usuário no registro; se o `PATH` do processo estiver desatualizado, prefixar os comandos com `C:\Users\11\AppData\Roaming\fnm\node-versions\v24.21.0\installation`. `C:\Program Files\nodejs` (v22.14.0) continua instalado porque é o runtime de outros projetos da máquina — **não desinstalar**.
- ✅ **`AGENTS.md` §STACK.md corrigido** — o bloco `GSD:stack-start..GSD:stack-end` passou a instruir o pin `7.0.0-rc14`; nenhuma seção fora do bloco foi alterada; as 10 regras não negociáveis ficaram intactas. Risco "agente futuro reverter o pin" eliminado pelo ADR-001 + nota de pin no topo do bloco.
- ✅ **`DATA_ROOT` criado fora do OneDrive** — `C:\whatsapp_prospecao\{auth,backups,logs}`, sem atributo `ReparsePoint`.
- ✅ **PostgreSQL 18.3 confirmado** sem tocar nos outros bancos da máquina; `psql` e `pg_dump` do mesmo major.

- ✅ **Skills do Ruler distribuídas** (2026-09-29, Task 1 step 6) — resolvido após aprovação humana explícita para instalar o pacote. O pacote correto é **`@intellectronica/ruler@0.3.44`** (MIT, `github.com/intellectronica/ruler`). Os dois nomes que o plano traziam estão errados e **não devem ser tentados de novo**: `npx ruler` resolve para `composable assertions` (pacote de outro projeto, "could not determine executable to run") e `npx @kirobil/ruler` retorna **404 — o pacote não existe**.
- ✅ **`.ruler/ruler.toml` corrigido (bug de config, não de pacote).** O arquivo usava duas chaves que o schema do Ruler 0.3.44 **rejeita**, e por isso `ruler apply` abortava com *"Invalid configuration file format (Errors: agents.opencode.skills_dir, merge)"*:
  - `agents.opencode.skills_dir` — `skills_dir` não existe no schema `[agents.<nome>]` (que é `.strict()`: só aceita `enabled`, `output_path`, `output_path_instructions`, `output_path_config`, `mcp`, `mcp_servers`). O destino do OpenCode é a constante `OPENCODE_SKILLS_PATH = '.opencode/skills'` e **não é configurável** — a chave era redundante e inválida ao mesmo tempo.
  - `[merge] strategy = "merge"` — seção inexistente no nível raiz. A intenção (mesclar, não sobrescrever) corresponde a `[mcp] merge_strategy`, que só importa se houver `.ruler/mcp.json`; o projeto não tem MCP, então a chave foi removida em vez de recriada como config inventada.
  - `.opencode/skills/whatsapp-baileys/SKILL.md` e `.opencode/skills/lgpd-optout/SKILL.md` confirmados em disco após o apply.
- ✅ **`ruler apply` escopado ao OpenCode.** Um `ruler apply` sem escopo escreveria em **60+ caminhos** de ~20 integrações de agente (`.roo/`, `.trae/`, `.amazonq/`, `firebender.json`, `CLAUDE.md`, `.codex/`, `.aider.conf.yml`, `.openhands/`, `CRUSH.md`, `WARP.md`…) e acrescentaria **60 entradas ao `.gitignore`**, incluindo a própria `.opencode/skills`. O comando usado foi `npx @intellectronica/ruler apply --agents opencode --no-gitignore --no-mcp`.
- ✅ **`AGENTS.md` preservado byte a byte.** O Ruler reescreve o arquivo de instruções do agente (`AGENTS.md` para o OpenCode) com um cabeçalho `<!-- Source: AGENTS.md -->` **fora** de qualquer bloco `GSD:stack-*`. O arquivo foi snapshotado antes do apply e restaurado por hash após, porque as 10 regras não negociáveis são load-bearing. Consequência a conhecer: **cada `ruler apply` volta a prepender esse cabeçalho** — quem rodar o comando precisa repetir o snapshot/restauração, ou aceitar o cabeçalho de forma consciente.

## Itens Adiados

| Categoria | Item | Status | Adiado Em |
|-----------|------|--------|-----------|
| Pesquisa | Procedimento de appeal de ban (fonte secundária) — confirmar antes de depender | Aberto | 2026-09-28 |
| Pesquisa | Onboarding da API oficial (migração R-016) — não pesquisado | Aberto | 2026-09-28 |
| Produto | Break-up message (FLUP-11 v2) — decidir com dado do piloto | Aberto | 2026-09-28 |

## Continuidade de Sessão

Última sessão: 2026-10-09
Parou em: Fase 1, wave 3 concluída. Plano 01-04 executado (4/4 tasks, 4 commits: `e56d6e6`, `40208e3`, `542070b`, `03ea113`; `01-04-SUMMARY.md` criado). Os 12 anti-requisitos têm property test; a ordem canônica e o choke-point de `sendText` foram provados por teste; o `outbox` durável reavalia o gate por job. Estado final: 25 arquivos / 101 testes verdes, `tsc` e biome limpos. O plano 01-03 tem a automação commitada, mas o pareamento QR real segue pendente (**P-004 `CREDS_INVALID`** — sem `01-03-SUMMARY.md`).
Próximo passo: `/gsd-execute-phase 1` (wave 4: plano 01-05 — operação e humanização; serializado)
Pendente (não bloqueia 01-05): fechar o checkpoint de pareamento do 01-03 — `CHANNEL_PHONE_E164` precisa do número real (hoje `+5511999999999`) e o QR precisa parear (`CREDS_INVALID` em `01-03-DIAG.md` / `docs/pendencias.md`).
Pós-reboot: revalidar com `npm run notify -- -Title "Teste R-013" -Message "Verificacao" -Urgent` e fechar a Task 6 do plano 01-01
Arquivo de retomada: `.planning/phases/01-funda-o-canal-e-gate-de-envio/01-04-SUMMARY.md`

---
*Atualizado: 2026-10-09*
