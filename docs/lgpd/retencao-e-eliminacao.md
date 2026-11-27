# Política de Retenção e Eliminação de Dados

**Projeto:** Automação Local de WhatsApp para Prospecção B2B
**Base legal da operação:** legítimo interesse (R-064)
**Data:** 2026-10-05

Esta política existe para ser executada, não lida. Cada linha diz o prazo, diz **qual evento
dispara a contagem**, diz **qual coluna é a chave da data** e diz **o que acontece com o que já
foi eliminado**. Uma regra de retenção sem chave de corte é uma intenção.

---

## 1. Prazos por categoria

| Categoria | Tabela | Prazo | Contagem a partir de | Justificativa |
|-----------|--------|-------|----------------------|---------------|
| Lead sem interação | `leads` | **90 dias** | `conversations.last_inbound_at` do lead, ou `leads.created_at` se nunca houve conversa | O contato que não responde não é pipeline, é registro. 90 dias cobrem uma cadência de follow-up inteira (1h, 1d, 3d, 7d) com folga de mais de um mês. Passado isso, o número está muerto e guardá-lo só amplia exposição de dado sem contrapartida comercial. |
| Conversa encerrada | `conversations` | **180 dias** | o instante do encerramento — `state = 'encerrado'` com `closed_reason` preenchido e `closed_at` gravado por trigger (migração 0010) | Meio ano. É o prazo mais defensável para dado de contato comercial em B2B: cobre o exercício
regular de direitos pelo titular e permite responder "o que vocês têm de mim?" durante toda a
janela em que o dado sobrevive. |
| Histórico da conversa | `messages` | **180 dias** | mesmo corte de `conversations` | Fica alinhado à conversa por desenho: mensagem sem conversa é registro órfão. `messages` é append-only (R-043), e o prazo age sobre a **destruição da linha pela rotina de retenção**, não sobre edição de conteúdo. A exceção é auditada e disparada só por `fn_aplicar_retencao`. |
| Ledger de opt-out e eliminação | `optout_ledger` | **INDEFINIDO** | — | É a prova de que o pedido foi atendido. Ver seção 2. |
| Eventos de handoff | `handoff_events` | **INDEFINIDO** | — | É a prova de que a automação parou no instante certo. Ver seção 2. |
| Sessão do WhatsApp | pasta `auth_info_baileys` | **Enquanto o número estiver em uso** | — | Não é dado pessoal de terceiro — é a credencial do canal. Enquanto o número dedicado existir, ela precisa existir. Perder a pasta é o WhatsApp ver um "dispositivo novo", que é sinal de banimento por si só (R-059). Ver seção 5. |
| Backups | `*.dump` em `backups\` | **30 dias com rotação** | data/hora no nome da pasta | Um dump é o banco inteiro em um arquivo: o mesmo risco de R-033, amplificado pelo volume. 30 dias é a janela de recuperação realisticamente útil para um MVP local; mais que isso, o dump vira um segundo banco sem ninguém gerenciá-lo. |
| Logs | `logs\*.log` | rotatividade do `pino-roll` | data no nome do arquivo | R-045. Log não guarda corpo de mensagem: guarda `message_id`, `lead_id`, `direction` e contagem de caracteres. Ver seção 6. |

## 2. Por que `optout_ledger` e `handoff_events` não têm prazo

**A prova de que o pedido foi atendido é justamente o que não pode expirar.**

Um opt-out que expira é um opt-out que volta. A cadeia é direta e não admite paráfrase:

1. O titular pede para não ser mais contatado em outubro.
2. `optout_ledger` guarda o evento; `leads.opt_out` fica `true`.
3. Em outubro do ano seguinte, uma rotina de limpeza "cumpre a política" e apaga o ledger.
4. O `leads.opt_out` ainda está `true` — **mas só porque ninguém pensou em religá-lo**. Um
   backfill, uma importação atualizada, um `UPDATE` administrativo, ou a restauração de um dump
   antigo traz o `false` de volta.
5. O `optout_ledger` era a única prova de que aquela pessoa já pediu. Sem ele, a linha de
   `blocked_attempts` que registrou o bloqueio já rotacionou, o log já rotacionou, e o sistema
   passa a mandar mensagem para alguém que pediu explicitamente para não receber.

Isso não é um risco teórico de R-033 — é o modo de falha mais provável de um sistema que
compliance bem-intencionado implementou e que ninguém mantém. **Expirar a prova do atendimento é
exatamente o que faz o backfill de um opt-out voltar a valer.**

O mesmo vale para `handoff_events`: é a evidência de que a automação parou na hora certa, diante
de um pedido de preço, de um pedido de opt-out ou de mídia recebida. Um relatório de conformidade
que só tem 6 meses de janela não responde a "quantas vezes este sistema quase negocio preço?".

O tamanho dessas duas tabelas é o argumento contra elas, e ele não se sustenta: o sistema é
limitado a 20 leads/dia e 20–30 mensagens/dia (R-023). São dezenas de linhas por mês, não
milhões.

## 3. A regra, escrita para que uma query possa ser derivada

A regra completa, sem abreviatura:

> **Chave de corte por categoria:** a data que conta é a última de: (a) a última interação
> registrada, (b) o encerramento da conversa, (c) a criação do registro, o que vier primeiro.
>
> **Coluna de data:**
> - `leads` → `COALESCE(conversations.last_inbound_at, leads.created_at)`. `last_inbound_at` é
>   NULL quando nunca houve mensagem do titular; nesse caso o corte é a criação do lead.
> - `conversations` e `messages` → `GREATEST(conversations.last_inbound_at,
>   conversations.last_outbound_at, conversations.created_at)`, contada a partir do momento em
>   que `state = 'encerrado'`. **Chave exata:** a migração 0010 adicionou
>   `conversations.closed_at` e um `BEFORE UPDATE OF state` que grava `now()` na transição para
>   `encerrado`. A derivação usa `closed_at` quando presente e mantém a última atividade apenas
>   para linhas históricas criadas antes da migração.
> - `optout_ledger`, `handoff_events`, `auth_info_baileys` → sem corte.
> - Backups → a data/hora no nome da pasta.
>
> **O que acontece com o que já foi eliminado:** a linha **é destruída**, não anonimizada e não
> esvaziada. `messages` é append-only (R-043) e o `REVOKE UPDATE, DELETE ON messages FROM PUBLIC`
> nega o privilégio — a eliminação por prazo é a **única** operação de `DELETE` que o sistema
> executa sobre `messages`, e ela é disparada por relógio, não por pessoa. Depois da eliminação,
> o que resta é o evento `retencao_aplicada` em `event_log` (ou `erasure_request` em
> `optout_ledger` quando houve pedido do titular), que é o que permite responder ao titular
> "quando eliminamos seus dados?" sem que essa resposta dependa do dado eliminado.

Derivação em SQL:

```sql
-- 1. Leads sem interação há mais de 90 dias (encerrados OU sem conversa)
SELECT l.id, l.phone_number, COALESCE(c.last_inbound_at, l.created_at) AS ultima_interacao
  FROM leads l
  LEFT JOIN conversations c ON c.lead_id = l.id
 WHERE l.opt_out = false
   AND COALESCE(c.last_inbound_at, l.created_at) < now() - interval '90 days';

-- 2. Conversas encerradas cujo prazo de 180 dias venceu.
--    `state` usa 'encerrado' (o CHECK é conversations_state_check).
--    A data é closed_at; o fallback cobre apenas linhas anteriores à migração 0010.
SELECT c.id, c.lead_id, c.closed_reason,
       COALESCE(c.closed_at, GREATEST(c.last_inbound_at, c.last_outbound_at, c.created_at)) AS encerramento
  FROM conversations c
  WHERE c.state = 'encerrado'
    AND COALESCE(c.closed_at, GREATEST(c.last_inbound_at, c.last_outbound_at, c.created_at))
        < now() - interval '180 days';

-- 3. Nunca: o ledger e o handoff não têm corte.
--    Esta query é a prova de que a eliminação foi feita e por quem.
SELECT event_type, occurred_at, recorded_at, legal_basis, purpose
  FROM optout_ledger WHERE lead_id = $1 ORDER BY occurred_at DESC;
```

**Sobre a eliminação de `messages`:** ela implica remover as linhas de `messages` das conversas
que venceram o prazo. Como `messages` é append-only, a rotina de retenção usa o caminho
implementado na migração 0011: `fn_aplicar_retencao` liga `app.retencao_autorizada` apenas dentro
da própria transação, e `fn_append_only` só permite `DELETE` nas tabelas de prazo vencido enquanto
essa chave está ligada. O cron diário às 03:37 (`src/application/retention.ts`) chama a função e
registra `retencao_aplicada` em `event_log`; nenhum outro código tem esse caminho.

## 4. Eliminação por pedido do titular

Um pedido do Art. 18 **não espera o prazo**. O procedimento está em
`docs/lgpd/canal-do-titular.md` e o que importa reter aqui é: o pedido produz um evento
`erasure_request` em `optout_ledger` (retenção **indefinida**), o `leads.opt_out` vai para
`true` de forma irreversível, os identificadores anuláveis são limpos, e a conversa é encerrada
para que o prazo de 180 dias comece a correr naquele dia, não 180 dias depois.

O que **não** é eliminado: o corpo de `messages` e de `optout_ledger.raw_content`, porque as duas
tabelas são append-only e nenhuma caminho de código — nem administrativo — altera conteúdo
gravado. Essa é a contradição conhecida do sistema, escrita no documento do canal do titular em
vez de ser omitida.

## 5. Backup: `pg_dump` / `pg_restore` (R-032)

O mecanismo é `pg_dump` em formato custom (`-Fc`), com restauração por `pg_restore`. O backup é
**manual**, disparado pelo Admin, e nunca automático (RNF-027): um backup automático de um banco
com PII é uma cópia de PII que ninguém decidiu fazer.

**O nome da pasta de backup leva o carimbo da major version do servidor.** O servidor desta
máquina é PostgreSQL 18.3, e a pasta segue `backups\pg18_<AAAAMMDD-HHMMSS>\`. Isso não é
organização: `pg_dump` de outra major version **não restaura**. O formato de dump carrega a
versão do servidor que o produziu, e o `pg_restore` recusa um dump de major incompatível em vez
de falhar parcialmente. Um backup sem carimbo no nome é um backup que só se descobre se está
quebrado no dia em que ele é preciso — que é o pior dia possível.

Regra adicional: **usar o `pg_dump` da mesma instalação do servidor.** `pg_dump` de major
diferente da do servidor falha na conexão ou produz formato incompatível.

A rotação de 30 dias vale para o dump **e** para a pasta `auth_info_baileys`, com uma ressalva:
a pasta de sessão **não** é rotacionada por data. Perder a sessão do WhatsApp é evento raro e
custoso (R-059, sem redundância de número). A sessão fica em `C:\whatsapp_prospecao\auth\`, que é
**backupada separadamente do banco** e nunca mora dentro do OneDrive — o OneDrive sincroniza
credencial para a nuvem em claro, o que contradiz R-033 e pode corromper a sessão com um
arquivo "online-only" no meio de uma escrita (PITFALLS §9).

Um backup de banco **sem** a sessão é metade do backup. Um backup da sessão **com** um dump de
outro major é pior que nenhum.

## 6. Logs, `blocked_attempts` e o corpo que não sai do lugar certo

`logs\*.log` segue a rotação do `pino-roll` e **não guarda corpo de mensagem**. O logger
registra `message_id`, `lead_id`, `direction` e contagem de caracteres; o corpo vive em
`messages`, que é a tabela com prazo declarado e com registro auditável. Duplicar transcrição em
arquivo de log colocaria PII fora de qualquer política de retenção — o log sobrevive à rotação
com regra própria e ninguém audita o que ele contém.

`blocked_attempts` segue a **mesma retenção de `messages` (180 dias)**. A coluna `excerpt` tem
no máximo 200 caracteres e passa pelo `redact` do pino quando vai para o log; a mensagem
completa está em `messages`. Ao vencer o prazo, `excerpt` vira `[eliminado]` e `detail`/
`payload_excerpt` ficam nulos — a linha permanece só como prova de que o gate bloqueou.

`event_log` é a trilha de R-022 e segue **o prazo de `messages` (180 dias)** para os eventos que
se referem a conversas. A exceção é o evento que registra uma eliminação: ele sobrevive, porque
é ele que responde "quando eliminamos seus dados?" depois que o dado deixou de existir.

## 7. Revisão desta política

A cada 6 meses, e imediatamente quando: o `DATA_ROOT` mudar de volume, o PostgreSQL mudar de
major version, ou o volume de leads dobrar. A revisão verifica se algum prazo está curto demais
para o exercise regular de direitos do titular — e não se está longo demais para o controlador,
que é a direção em que a pressão comercial empurra.