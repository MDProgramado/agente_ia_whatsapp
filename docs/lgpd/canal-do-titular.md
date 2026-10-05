# Canal do Titular — Como o titular exerce seus direitos

**Projeto:** Automação Local de WhatsApp para Prospecção B2B
**Prazo de resposta:** 5 dias úteis (ver `docs/lgpd/encarregado-dpo.md`)

---

## 1. O canal NÃO é a conversa de WhatsApp

**O canal do titular é o e-mail do encarregado OU o telefone do Admin. Nunca a conversa de
WhatsApp.**

Isso não é preferência de estilo. É uma contradição técnica, e ela é a razão de este documento
existir.

O histórico de mensagens é **append-only** (R-043): o trigger `fn_append_only` barra `UPDATE` e
`DELETE` em `messages` mesmo para o `superuser` do PostgreSQL, e `REVOKE UPDATE, DELETE ON
messages FROM PUBLIC` cobre o privilégio. Isso é um invariante deliberado — o histórico é a
prova de auditoria que R-022 exige.

Agora considere um pedido de eliminação atendido dentro do bot:

1. O titular escreve "apaguem meus dados" na conversa.
2. O `inbound-handler` grava essa mensagem em `messages.body`. Ela é o registro mais recente do
   histórico que ele pediu para apagar.
3. O bot responde "seus dados foram eliminados" — e essa resposta **também** é gravada.
4. Para responder, o sistema precisou ler o histórico. Para saber o que eliminar, precisou
   consultá-lo.

O registro sobrevive à eliminação, porque **o histórico não aceita ser eliminado**. O titular
pediu a eliminação e recebeu, como prova, mais duas linhas de histórico com o conteúdo do
pedido. Isso não é conformidade: é a demonstração de que o pedido não foi atendido.

Pior, é um problema de já Tido que se retroalimenta. Toda resposta futura que mencione o pedido
cria evidência nova.

**Por isso o procedimento inteiro é escrito para não depender do bot em nenhum passo** — nem na
identificação do titular, nem na coleta do pedido, nem na confirmação, nem no prazo. Se você
precisar que o bot responda uma vez, o procedimento está errado.

## 2. O que o bot faz quando o pedido chega pelo WhatsApp

O bot **não responde ao pedido**. Ele:

1. Aciona handoff imediato (AR-005/R-012) e entra em silêncio total.
2. Grava o pedido como evento em `optout_ledger` (seção 4).
3. Notifica o Admin localmente (som + toast).
4. **Para de enviar** e não retoma até o Admin assumir.

O bot é o **detector**, não o **atendente**. Essa distinção é o que mantém o procedimento fora
do histórico. Se o titular pedir pelo WhatsApp, o Admin pede que ele use o canal de atendimento —
e essa é a única mensagem naquele canal, enviada por pessoa, fora da automação.

## 3. Os direitos do Art. 18 e o procedimento de cada um

Em todos os seis: identificar o titular por `leads.phone_number` (E.164), suspender o contato
imediato, gravar o evento no `optout_ledger` e responder em **5 dias úteis**.

### 3.1 Acesso — "o que vocês têm sobre mim?"

Consultar e entregar, em formato legível, o que existe:

```sql
SELECT id, phone_number, name, origin_source, legal_basis, purpose,
       legal_registered_at, opt_out, created_at
  FROM leads WHERE phone_number = $1;
```

Mais o histórico de eventos:

```sql
SELECT event_type, source, detected_by, occurred_at, raw_content
  FROM optout_ledger WHERE lead_id = $1 ORDER BY occurred_at DESC;
```

**Não** entregar o corpo das mensagens como conteúdo do pedido. O titular tem direito aos dados
que o sistema coleta sobre ele; a conversa é o conteúdo que ele criou, não um cadastro dele, e
não precisa constar na resposta. A exceção é ele pedir explicitamente a transcrição — nesse caso
a entrega é feita pelo Admin, em canal externo, e o pedido é registrado.

### 3.2 Correção — "esse nome está errado"

`UPDATE` em `leads.name`, `leads.address_line` e `leads.phone_number`. Correção é o único direito
que altera dados de identificação, e ela **não** é eliminação: o lead continua existindo, com a
informação certa.

Atenção: `phone_number` é a chave de negócio (`UNIQUE`) e tem `CHECK` E.164. Uma correção de
número reidentifica o lead; se o número novo já existir no banco, é deduplicação por
`duplicate_of`, não merge destrutivo — nada é apagado (LEAD-04).

`origin_source`, `legal_basis` e `legal_registered_at` **não** são corrigíveis. São o registro de
procedência, e um registro de procedência que o titular reescreve não é procedência. Se o
contato veio do caça-leads, veio do caça-leads, e o pedido "apaguem de onde vieram meus dados"
é eliminação do dado, não correção dele.

### 3.3 Portabilidade — "quero meus dados em arquivo"

Exportar CSV com as mesmas colunas do acesso, mais `conversations` e `messages` do período
retido. `messages` é imutável (R-043), então a portabilidade é **cópia**, nunca extração com
alteração: o arquivo sai como está, e uma correção de dado do histórico é pedida como
correção, aplicada onde o dado é corrigível.

O arquivo é entregue fora do banco, e o titular é avisado de que ele **não tem** retenção de
prazo: ele é responsável por ele depois de recebido.

### 3.4 Anonimização — "quero que não me identifiquem"

O que a anonimização realmente apaga hoje está restrito pelo schema, e vale saber por quê.

`leads` tem cinco colunas de identidade, e apenas três delas são anuláveis:

```sql
-- Anonimização do que o schema permite anular hoje
UPDATE leads
   SET name = NULL,
       address_line = NULL,
       wa_jid = NULL,
       lid = NULL,
       opt_out = true
 WHERE id = $1;
```

`name`, `address_line`, `wa_jid` e `lid` são nullable por construção. O registro continua
contando para as métricas de taxa de qualificação (R-062), sem identificar ninguém.

**O que não pode ser anonimizado sem migration, e está declarado como pendência:**

- **`phone_number`** é `NOT NULL`, `UNIQUE` e tem `CHECK (leads_phone_number_check)`
  com a regex E.164 `^\+[1-9][0-9]{7,14}$`. Não aceita `NULL` nem aceita um pseudônimo que
  não seja E.164. Anonimizar essa coluna **exige uma migration** que troque o `CHECK` por uma
  regra que aceite um identificador pseudonimizado (por exemplo `anon:<uuid>`).
- **`origin_source`, `legal_basis` e `purpose`** são `NOT NULL` e são o registro de procedência
  exigido por R-064. Anonimizá-los destruiria a capacidade de responder "de onde veio meu
  número?" — que é justamente o direito que o titular pode exercer a qualquer momento.

Consequência prática, dita sem rodeio: **hoje a anonimização preserva o número do titular.** O
que sai é nome, endereço, JID e LID, e o `opt_out` impede qualquer novo contato. A eliminação
de verdade depende da migration do `CHECK` E.164 — registrada em `docs/pendencias.md` e em
`.planning/STATE.md` como pendência aberta, não como coisa feita.

### 3.5 Eliminação — "apaguem tudo sobre mim"

A eliminação é **evento**, não remoção de linha. A lead row permanece: LEAD-04 existe para que
nenhuma cascata de banco apague histórico de forma invisível, e o trigger
`trg_leads_no_cascade` (`fn_no_cascade_leads`) transforma qualquer `DELETE` em erro explícito.

O procedimento executável hoje:

1. Gravar `event_type = 'erasure_request'` em `optout_ledger`, com `source = 'manual'` e
   `detected_by = NULL`.
2. `UPDATE leads SET opt_out = true` — irreversível, garantido por `trg_leads_opt_out_irreversivel`
   (`fn_opt_out_irreversible`), que barra `true → false`.
3. Aplicar a anonimização de 3.4: anular `name`, `address_line`, `wa_jid` e `lid`.
4. Encerrar a cadência: `conversations.state = 'encerrado'` com `closed_reason` preenchido, o
   que dispara o prazo de 180 dias descrito em `docs/lgpd/retencao-e-eliminacao.md`.
5. Registrar a eliminação em `event_log` (`event_type`, `lead_id`, escopo e contagem em
   `payload`), porque `event_log` é append-only e é a trilha de R-022.

**Sobre o conteúdo de `messages` e de `optout_ledger.raw_content`, a contradição precisa ficar
escrita:** as duas tabelas são append-only. O trigger `fn_append_only` está em
`BEFORE UPDATE OR DELETE`, e `REVOKE UPDATE, DELETE ... FROM PUBLIC` cobre o privilégio. Não
existe caminho no sistema — nem administrativo — que altere `messages.body`. Uma eliminação de
conteúdo exigiria criar uma exceção explícita ao invariante de R-043, e essa exceção **não está
escrita nem implementada**.

O que resta em prática, e o que é honesto dizer ao titular: o corpo das mensagens permanece até
o prazo de 180 dias, e depois é destruído junto com a linha pela rotina de retenção — que é o
único `DELETE` que o sistema executa, e ele é disparado por prazo, não por pessoa. Até lá, o
titular tem direito de **portabilidade** (3.3) e o pedido de eliminação está registrado como
evento com data, tipo e origem.

Essa é a diferença entre o que o sistema promete e o que ele faz, e ela está escrita aqui para
que ninguém descubra em uma auditoria.

### 3.6 Informação sobre origem — "de onde saiu meu número?"

A resposta sai de três colunas NOT NULL:

```sql
SELECT origin_source, legal_basis, purpose, legal_registered_at
  FROM leads WHERE phone_number = $1;
```

O `origin_source` guarda o identificador do caça-leads **e a consulta usada**, de modo que a
procedência é auditável e não apenas afirmável. A resposta ao titular nomeia a fonte, explica a
base legal (legítimo interesse, Art. 7º, IX) e informa a finalidade registrada em `purpose`, e
oferece o opt-out na mesma mensagem. Se a fonte for o próprio titular, `origin_source` registra
isso — a coluna é `NOT NULL` justamente para obrigar a procedência a ser sempre declarada.

Prazo de resposta: 5 dias úteis, o mesmo canal, e **o pedido de origem não autoriza contato
comercial adicional**. Responder a pergunta não reabre a prospecção.

## 4. Eventos gravados em `optout_ledger`

Toda requisição do Art. 18 produz um evento. A tabela é **append-only** (`fn_append_only` em
`BEFORE UPDATE OR DELETE`, mais `REVOKE UPDATE, DELETE FROM PUBLIC`) e **sem coluna de estado**
— não existe `active`, `revoked_at` ou `deleted_at`, e essa ausência é o invariante: uma coluna
de estado permitiria o `UPDATE leads SET opt_out = false` que o trigger de `leads` barra, e
barrar num lugar só é o que faz o bug reaparecer por outro caminho.

| Coluna | Valor | Significado |
|--------|-------|-------------|
| `event_type` | `'opt_out'` | Pedido de não ser mais contatado. Bloqueio imediato e permanente. |
| `event_type` | `'erasure_request'` | Pedido de eliminação. Sempre acompanhado de `opt_out`. |
| `event_type` | `'reinstate'` | O Admin registra que o titular voltou a querer falar. Decisão humana, registrada como evento — não é um `UPDATE` que ressuscita o lead por baixo dos panos. |
| `source` | `'auto_detected'` | Detectado pelo sistema: matcher determinístico de opt-out ou sinal da LLM. |
| `source` | `'manual'` | Acionado pelo Admin, de forma direta. Todo `erasure_request` é `manual` — o sistema detecta pedido de parar, nunca pedido de apagar. |
| `detected_by` | `'deterministic'` | Matcher por palavra-chave em pt-BR. Barreira secundária, sempre presente. |
| `detected_by` | `'llm_signal'` | A LLM classificou a intenção como opt-out. **Nunca decide sozinha**: os detectores são aditivos, e qualquer um dos dois disparando já aciona o bloqueio. |
| `detected_by` | `NULL` | Não houve detecção automática — ação manual. |

Os valores são válidos por `CHECK` no banco: `optout_ledger_event_type_check`,
`optout_ledger_source_check` e `optout_ledger_detected_by_check`. Um valor fora do domínio é
rejeitado na gravação, não na leitura.

`raw_content` guarda o **texto do pedido, truncado**. É a prova de que o pedido aconteceu
(R-024) e responde a C2 do teste de balanceamento — a origem não é opaca para o titular.

`legal_basis` e `purpose` são `NOT NULL` porque a lei os exige **no registro**, não num
documento separado. Um evento sem base legal gravada é um evento inválido.

## 5. A trilha de auditoria é o contraponto (R-022)

O `optout_ledger` é a prova de que o pedido foi atendido. E é **por isso** que ele guarda o
`lead_id` pseudonimizado e **não** o texto integral da conversa.

O raciocínio: um ledger imutável que guarda tudo o que o titular pediu para apagar é um ledger
que não pode existir. A prova que a ANPD exige é a **existência do registro do atendimento** —
data, tipo de evento, origem, base legal, e um trecho do pedido. Não é a tentativa de reconstruir
a conversa. Guardar `messages.body` no ledger resolveria um problema que ninguém tem e criaria
dois que a lei proíbe.

O mesmo vale para `messages` (3.5): o `body` permanece inalterado enquanto a linha existir, porque
`fn_append_only` barra qualquer `UPDATE`. O que sobrevive à eliminação é a estrutura da linha —
timestamp, `direction`, `origin` e `latency_ms` — e nenhum desses campos identifica uma pessoa.
São eles que permitem responder "quantas mensagens foram trocadas e quando a conversa começou",
que é o que um relatório de conformidade precisa saber.

`recorded_at` (NOT NULL, `defaultNow`) é separado de `occurred_at` (NOT NULL, sem default) de
propósito: `occurred_at` é quando o titular falou, `recorded_at` é quando o sistema gravou. O
intervalo entre os dois é o tempo de atendimento, e é ele que um auditor mede.

Índice `optout_ledger_lead_occurred_idx` sobre `(lead_id, occurred_at DESC)`: a primeira pergunta
de qualquer auditor é "este lead já pediu, e quando?" — e a resposta sai das duas colunas sem
varrer a tabela.

## 6. Resumo operacional

| Pedido | Ação imediata | Evento | Prazo |
|--------|---------------|--------|-------|
| Não ser mais contatado | `opt_out = true` | `opt_out` | Imediato, sem esperar prazo |
| Eliminação | `opt_out = true` + anonimizar | `erasure_request` | 5 dias úteis |
| Acesso / origem | suspender contato | `opt_out` | 5 dias úteis |
| Correção | suspender contato | `opt_out` | 5 dias úteis |
| Portabilidade | suspender contato | `opt_out` | 5 dias úteis |
| Anonimização | suspender contato | `erasure_request` | 5 dias úteis |

A regra de cima da tabela é a que costuma ser esquecida: **qualquer pedido do Art. 18 suspende o
contato no ato, inclusive o pedido de acesso.** O titular que pergunta "o que vocês têm de mim?"
não está demonstrations interesse comercial em ouvir a resposta.