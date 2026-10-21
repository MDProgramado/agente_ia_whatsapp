# ADR-014 — Scheduler de Cadência Ancorado no Último Toque

- **Status:** Aceito
- **Data:** 2026-10-21
- **Decisores:** Admin (você), System Architect
- **Contexto:** Fase 3 — Cadência, Operação e Painel
- **Relacionado a:** R-003, R-004, R-005, R-006, R-007, R-023, R-058, R-067, AR-005, AR-007, AR-008, AR-010

---

## 1. Contexto

O [ADR-009](009-follow-up-conservador.md) é a **autoridade da cadência**: 4 tentativas nos
intervalos `1h → 1d → 3d → 7d`, encerramento após 7 dias sem resposta, sem follow-up de 15
dias, dreno de misfire com jitter e `FIRE_ONCE`. Este ADR **não substitui** o ADR-009 — ele
**detalha o como** da cadência que o ADR-009 define, sem contradizer nenhum de seus valores.

Três lacunas do documento de requisitos precisavam ser fechadas antes de o motor rodar:

1. **A contradição R-004 × R-005.** R-004 descrevia a cadência como `1h → 1d → 3d → 7d → 15d`
   ("inicialmente"), enquanto R-005 diz que o máximo é de 4 tentativas e que o toque de 15 dias
   **não** deve ser executado. Dois textos canônicos discordando do mesmo comportamento é a
   forma mais barata de um bug de banimento: um dia alguém implementa o 15º dia "porque está
   escrito no R-004".
2. **A âncora do relógio.** O ADR-009 (pseudo-código §6.2) agendava a sequência inteira a
   partir de um `baseTime` único. Se o alvo fosse recalculado a partir do instante presente a
   cada tique, o mesmo `(conversa, índice)` receberia um `scheduled_for` novo a cada 30
   segundos, o alvo jamais venceria e a cadência nunca sairia.
3. **A janela como fronteira dura.** O texto de RN-009 ("enviados ao abrir o app, mesmo fora
   da janela") contradiz a fronteira dura de AR-007/R-006/R-058 (dias úteis, 7h–17h): abrir o
   app num sábado às 10h não pode significar "despeje a fila agora".

O número dedicado é insubstituível (R-059, sem redundância) e o padrão de **rajada** — várias
mensagens de cadência de máquina em poucos segundos — é o comportamento mais associado a
banimento na literatura de canal. O motor de cadência é, portanto, a peça de maior risco
operacional do sistema.

---

## 2. Decisão

### 2.1 A cadência (valores do ADR-009, mantidos)

- **4 toques**, nos deltas `1h → 1d → 3d → 7d`.
- **O 15º dia não existe.** Não há delta de 15 dias em nenhuma tabela, constante ou cálculo.
- Encerramento da cadência **após o 4º toque sem resposta**: a conversa passa a
  `state='encerrado'` com `closed_reason='sem_resposta'` e a transição entra em
  `status_history` (append-only, `reason='sem_resposta'`, `changed_by='bot'`).

### 2.2 A âncora é o último toque, nunca o relógio

O alvo da tentativa *n* é `last_outbound_at + delta[n]`, onde `last_outbound_at` é o último
toque **real** da conversa e `delta` é a tabela `1h/1d/3d/7d`. O cursor é
`conversations.follow_up_index` — quantos toques **já** saíram. O cálculo é **puro**: não
lê `Date.now()` em nenhum caminho; o tique apenas **compara** `alvo <= agora`.

Consequência prática: se o tique reancorasse no relógio, o `scheduled_for` do mesmo
`(conversa, índice)` mudaria a cada 30 s, o alvo nunca venceria e o `follow_up_index`
divergiria do que de fato foi enviado.

### 2.3 Teto duro de toques

`settings.followup.max_touches` existe, mas é **clampado em `1..4`** com default `4`: um valor
ausente, não-inteiro, ≤ 0 ou **maior que 4** cai no default. Não existe caminho — nem por
`settings`, nem por migration — para aumentar o volume. Errar para menos toques é seguro;
errar para mais não é uma opção.

### 2.4 Interrupções (RN-018)

A cadência é interrompida **imediatamente** quando: o lead responde, o lead pede opt-out
(AR-005), o handoff é acionado (AR-010), o Admin pausa manualmente, ou o canal cai. O
follow-up pendente não some: vira linha cancelada no ledger (`scheduled_tasks.status='abandoned'`,
`cancelled_at`, `cancelled_reason`) e o job correspondente é abandonado no `outbox`.

**Resposta do lead = mensagem inbound.** Read receipts não contam e não zeram a cadência: não
são confiáveis no canal tctoken/LID. O watermark de silêncio é `conversations.last_inbound_at`.

### 2.5 O scheduler é produtor, o worker é quem envia

- **Tick de 30 s** (`croner`, `*/30 * * * * *`), **single-instance**, no mesmo processo.
- O tick **lê estado, escreve `scheduled_tasks` e chama `outbox.enqueue`** — e só. Ele não
  importa o dispatcher, não conhece o `ChannelPort` e **não envia**.
- Quem envia é o `drainLoop` do `outbox-worker`, que reserva o job e chama o `dispatcher` —
  o choke-point único — **sempre com snapshot fresco do gate**.

Duas camadas, uma fila: `scheduled_tasks` é o **ledger auditável** ("o que estava agendado,
quando disparou, por que foi cancelado"); o `outbox` é a **fila gateada**
(`idempotency_key UNIQUE`, `FOR UPDATE SKIP LOCKED`, lease com `requeueStale`, gate
reavaliado a cada job).

### 2.6 Idempotência por três barreiras

1. Índice único parcial `(conversation_id, follow_up_index) WHERE status='pending'` — o
   `INSERT` da task vira `ON CONFLICT DO NOTHING`.
2. `outbox.idempotency_key = 'flup:{conversaId}:{indice}'` (UNIQUE) — o segundo `enqueue`
   devolve `null`, e `null` é a resposta **correta**, não um erro.
3. `messages.idempotency_key` — a rede final, no envio.

Dois tiques concorrentes não duplicam agendamento nem envio.

### 2.7 Dreno de catch-up (R-007) — válvula, não despejo

O dreno **não envia**: ele escolhe quem pode sair agora e **adia** o resto. O envio continua
sendo do `drainLoop`, com o gate reavaliado.

- No máximo **3 envios iminentes** por drenagem, dentro dos **primeiros 10 minutos**.
- **1 follow-up por lead por dia de drenagem** (o lead que já teve follow-up hoje não entra
  de novo).
- **Jitter de 3–12 s** entre os iminentes, determinístico por `sha256(conversa:job)` — a
  mesma fila nunca "tira" um número diferente entre passadas.
- O restante é **adiado, nunca descartado**: `markDeferred` reagenda para a `nextWindow`.
- Misfire é `FIRE_ONCE` por tipo: um follow-up cujo horário passou com o app fechado dispara
  **uma única vez** na próxima janela válida. `CATCH_UP` (replay de todas as ocorrências
  perdidas) é **proibido**.

### 2.8 `isCatchupDrain` é parâmetro, não configuração

`isCatchupDrain` é um **parâmetro booleano threadado do boot** para
`drenarCatchup(db, { now, isCatchupDrain, feriados, limite, sleep })`:

- `true` → a passada de drenagem acontece (uma vez, no boot).
- `false` → **no-op** (`{ enviados: 0, adiados: 0 }`), sem tocar em nada.

Ele **não** é campo de `settings`, **não** é modo global e **não** é lido do banco: um
operador não pode religar um dreno que já rodou, sob pena de o R-007 virar um loop de
reenvio. O valor é decidido no ponto de boot (`src/index.ts`) e vale para aquela execução.

### 2.9 A janela é fronteira dura (D-11)

- O dreno **só envia dentro da janela**: dias úteis, 7h–17h, no fuso da conversa
  (`America/Sao_Paulo` por padrão).
- **Fora da janela, abrir o app apenas enfileira**: os jobs vencidos são adiados para a
  `nextWindow` (que pula fim de semana e **feriado BR**).
- Feriados BR são resolvidos **localmente** (`src/domain/feriados-br.ts`: fixos + móveis
  derivados da Páscoa), com override manual em `settings.calendar.holidays`.
- "Próximo dia útil" é uma decisão de **produto** documentada: vencimento em fim de semana,
  feriado ou fora da janela → **próximo dia útil às 07:00**.

O texto original de RN-009 ("mesmo fora da janela") está **reconciliado** neste ADR: a leitura
canônica é "ao abrir o app, enfileira; envia dentro da janela".

---

## 3. Justificativa

### Por que a âncora é o último toque?

- **Previsibilidade:** o `scheduled_for` é uma **função do estado**, não do instante da
  consulta. Dois tiques produce o mesmo alvo — propriedade testável.
- **O tempo real só influencia uma coisa:** a comparação `alvo <= agora`.
- **Consistência com o que o lead vivência:** o próximo toque é "1 dia depois da minha
  última mensagem", não "1 dia depois que o servidor checou".

### Por que o teto de 4 é duro?

- R-005 ("1 semana já basta") é decisão do Admin, não parâmetro negociável.
- Um teto que o `settings` consegue aumentar é um teto que um erro de digitação aumenta —
  e o custo do erro é o número dedicado.

### Por que o dreno adia em vez de descartar?

- **Durabilidade é o contrato do R-007:** o follow-up vencido não pode ser perdido.
- **Rajada é o modo de falha caro:** despejar 20 follow-ups ao abrir o app é o padrão de
  cadência de máquina.
- **3 por vez é um ritmo humano:** a fila atrasada se esvazia em passos limitados, e o dia
  seguinte drena mais 3.

### Por que `isCatchupDrain` é parâmetro?

- Um dreno é um **evento de boot**, não um **estado do sistema**. Modelá-lo como estado
  (flag em `settings`, "modo catch-up") cria a tentação de religá-lo.
- Como parâmetro, ele é **auto-evidente no código**: quem chama decide, e a função não tem
  memória.

### Por que o scheduler não envia?

- O choke-point único (`src/application/dispatcher.ts`) é a garantia de que **toda**
  mensagem passa pelo gate. Um scheduler que enviasse teria de reimplementar o gate — ou
  contorná-lo. É exatamente o "envio sem gate" que a suíte de choke-point transforma em
  falha.

---

## 4. Consequências

### Positivas

- **R-004 e R-005 deixaram de se contradizer** — um único enunciado canônico.
- **Cadência determinística:** o mesmo estado produz sempre o mesmo alvo.
- **Dreno seguro:** o pico de envios é limitado por construção, não por boa vontade.
- **Auditoria completa:** o ledger `scheduled_tasks` responde "o que estava agendado, quando
  disparou e por que foi cancelado".
- **Nada se perde:** follow-up vencido é adiado, nunca descartado.

### Negativas

- **O 15º dia nunca existe** — leads que responderiam no dia 10 ficam sem novo toque. É o
  trade-off aceito por R-005.
- **O dreno atrasa:** a fila vencida pode levar dias para se esvaziar, com no máximo 3 por
  dia.
- **Duas tabelas para um conceito:** `scheduled_tasks` + `outbox` é mais superfície que uma
  fila só — preço pago pela auditabilidade.
- **Clamp silencioso:** um `settings.followup.max_touches` inválido é substituído pelo
  default sem aviso; o comportamento é seguro, mas o valor digitado é ignorado.

### Riscos residuais

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Rajada ao abrir o app | Baixa | Alto | ≤3 iminentes, jitter 3–12 s, 1 follow-up/lead/dia |
| Follow-up reenviado por bug | Baixa | Alto | 3 barreiras de idempotência + `FIRE_ONCE` |
| Toque de 15 dias existir por engano | Baixa | Alto | `DELTAS_TOQUE` com 4 entradas; índice ≥ 4 lança (fail-closed) |
| Envio fora da janela | Baixa | Alto | `dentroDaJanelaOperacional` no dreno; `evaluatePolicy` (AR-007) no envio |
| Fila de catch-up crescendo sem parar | Média | Médio | Alerta de `catchup_drain` com contagem de adiados |
| Config com `max_touches` inválido | Média | Baixo | Clamp em `1..4` com default 4 |

---

## 5. Alternativas consideradas

### Alternativa A — Âncora no instante presente (`now()`)

- **Prós:** código mais simples, sem estado de cursor.
- **Contrás:** o alvo nunca venceria (novo `scheduled_for` a cada tique) e o
  `follow_up_index` divergiria do que foi enviado.
- **Por que não:** quebra a própria promessa do ADR-009 — o follow-up sai uma vez, na hora
  certaina.

### Alternativa B — Manter a cadência de 15 dias

- **Prós:** mais alcance; alguns leads responderiam depois.
- **Contrás:** contradiz R-005 e a decisão explícita do Admin ("1 semana já basta"); aumenta
  desgaste e risco de denúncia.
- **Por que não:** decisão de produto, não técnica. Fica para a Fase 4 com dado do piloto.

### Alternativa C — Dreno sem limite (enviar tudo ao abrir)

- **Prós:** simples; "não perde follow-up".
- **Contrás:** rajada de cadência de máquina — o padrão mais associado a banimento.
- **Por que não:** o número dedicado é insubstituível (R-059).

### Alternativa D — Dreno com descarte do excedente

- **Prós:** fila sempre esvazia; sem atraso acumulado.
- **Contrás:** perde follow-up agendado — quebra o contrato de durabilidade do R-007.
- **Por que não:** adiar é barato; descartar é irreversível.

### Alternativa E — `isCatchupDrain` como modo global / campo de `settings`

- **Prós:** ajustável em runtime sem reiniciar.
- **Contrás:** convida a religar um dreno já executado → loop de reenvio; mistura estado do
  sistema com evento de boot.
- **Por que não:** o dreno é um **evento**, não um **estado**.

### Alternativa F — Adotar `pg-boss` para a cadência

- **Prós:** fila durável com singleton e retry prontos.
- **Contrás:** dependência nova e superfície nova para um operador único; o `outbox` já
  implementa SKIP LOCKED, lease, idempotência e re-gate.
- **Por que não:** o R-044 limita as integrações; o `outbox` já resolve o problema.

---

## 6. Implementação

| Peça | Arquivo |
|---|---|
| Cálculo puro da cadência (`DELTAS_TOQUE`, `proximaTentativa`, `maxToques`, `cadenciaEncerrada`) | `src/domain/cadence.ts` |
| Tique de 30 s (agendar → cancelar → reconciliar → encerrar) | `src/application/scheduler.ts` |
| Dreno de catch-up + encerramento por não-resposta | `src/application/catchup-drain.ts` |
| Consultas do ledger e do `outbox` (`enqueue`, `reserveNext`, `markDeferred`, `abandon`) | `src/infra/db/queries/scheduler.ts`, `src/application/outbox.ts` |
| Quem envia (reserva + `dispatch` com gate fresco) | `src/application/outbox-worker.ts` |
| Choke-point único de envio | `src/application/dispatcher.ts` |
| Janela, próximo dia útil e feriados BR | `src/domain/business-hours.ts`, `src/domain/feriados-br.ts` |
| Decisão do `isCatchupDrain` no boot | `src/index.ts` |

**Contrato do dreno:**

```typescript
export interface CatchupDrainDeps {
  readonly now: Date;
  readonly isCatchupDrain: boolean; // parâmetro do boot — nunca lido de `settings`
  readonly feriados?: readonly string[];
  readonly limite?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}
```

**Contrato da cadência:**

```typescript
export const DELTAS_TOQUE = [1h, 1d, 3d, 7d] as const; // 4 entradas — o 15º dia não existe
export const MAX_TOQUES_TETO = 4;
export const proximaTentativa = (lastOutboundAt: Date, index: number): Date => { /* … */ };
export const maxToques = (settingsValue: unknown): number => { /* clamp 1..4, default 4 */ };
export const cadenciaEncerrada = (index: number, max: number): boolean => index >= max;
```

---

## 7. Critérios de sucesso da decisão

- **Cadência:** 4 toques, nos deltas `1h/1d/3d/7d`, contados a partir do último toque real.
- **Determinismo:** dois tiques seguidos produzem o **mesmo** `scheduled_for` para o mesmo
  `(conversa, índice)`.
- **Teto:** nenhuma conversa ultrapassa 4 toques, mesmo com `settings` malformado.
- **Interrupção:** opt-out, handoff, pausa e resposta inbound cancelam os pendentes
  imediatamente, com motivo registrado.
- **Encerramento:** após o 4º toque sem inbound, a conversa fica `encerrado` /
  `closed_reason='sem_resposta'`, com linha em `status_history`.
- **Dreno:** no máximo 3 iminentes por drenagem, 1 follow-up/lead/dia, jitter de 3–12 s,
  restante **adiado** (nunca descartado) e **nenhum envio fora da janela**.
- **Idempotência:** dois tiques concorrentes não criam agendamento nem envio duplicado.
- **Sem caminho novo de envio:** `sendText` continua existindo só em
  `src/application/dispatcher.ts`.

---

## 8. Referências

- `docs/08-adr/009-follow-up-conservador.md` — **autoridade da cadência** (não contradita)
- `docs/08-adr/004-gate-invariantes.md` — gate único e AR-007/AR-008
- `docs/03-regras-de-negocio.md` — RN-006..RN-022 (RN-009 reconciliado por este ADR)
- `docs/01-requisitos-funcionais.md` — R-003, R-004, R-005, R-006, R-007, R-058
- `docs/07-template-mensagens.md` — Seção 6 (follow-up)
- `docs/04-arquitetura.md` — Seção 10 (scheduler)
- `.planning/phases/03-cad-ncia-opera-o-e-painel/03-CONTEXT.md` — D-01..D-13
- R-003, R-004, R-005, R-006, R-007, R-023, R-058, R-067, AR-005, AR-007, AR-008, AR-010
