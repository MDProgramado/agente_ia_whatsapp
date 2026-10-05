# Teste de Balanceamento — Avaliação de Legítimo Interesse

**Projeto:** Automação Local de WhatsApp para Prospecção B2B
**Base legal avaliada:** legítimo interesse (Art. 7º, IX; R-064)
**Data da avaliação:** 2026-10-05
**Reavaliação:** a cada 6 meses, ou quando o volume de leads dobrar, ou quando a ANPD mudar a
interpretação de contato B2B em WhatsApp

Este documento não resume o artigo 10. Ele aplica o teste ao **caso concreto** deste sistema e
termina dizendo **em que condições ele para de fechar**. Um teste que nunca admite derrota não é
um teste — é um panfleto.

---

## 1. O caso, sem abstrair

Uma pessoa jurídica de pequeno porte, com CNPJ ativo, site institucional e um telefone de
atendimento publicado. Esse número é importado de uma API de busca de empresas
(`leads.origin_source` = identificador do caça-leads e a consulta usada), junto com nome do
contato, cargo e eventual e-mail corporativo. Não há dado sensível em nenhuma coluna: nenhum
Art. 11. O contato é profissional, e a empresa tem porte e atividade compatíveis com o serviço
oferecido.

Duas coisas definem o caso:

- **A primeira mensagem é sempre humana.** O Admin escreve o primeiro contato à mão. O bot só
  entra depois de `leads.first_contact_by_human = true`, que o guard 0 do gate exige (R-001).
- **O titular não deu consentimento.** Não há opt-in. A base legal é o legítimo interesse, e
  ela precisa carregar o peso inteiro por isso.

## 2. Os argumentos a favor do controlador

| # | Argumento | Peso |
|---|-----------|------|
| P1 | **Pequeno porte.** Empresa individual ou de poucos funcionários não tem obrigação legal de manter um canal de direitos do titular nem um processo de privacidade maduro. O legítimo interesse existe precisamente para que um negócio assim possa prospectar. | **Forte** |
| P2 | **Contato B2B e profissional.** O telefone e o e-mail estão publicados para contato comercial. O titular atua no exercício da atividade profissional, e o Art. 7º, IX é exatamente esse caso. Nenhum dado do Art. 11 entra no sistema. | **Forte** |
| P3 | **Possibilidade real de contrato.** Existe uma prestação concreta que o titular pode contratar. Sem isso, o contato deixa de ser prospectagem e passa a ser incomodação sem contrapartida. | **Forte** |
| P4 | **A primeira mensagem é humana.** R-001 garante que o primeiro contato sai de uma pessoa, não de um sistema. Isso tira do conjunto o agravante mais citado pela ANPD em prospecção automatizada. | **Médio** |
| P5 | **Salvaguadas reais e verificáveis no banco.** Opt-out irreversível por trigger (`fn_opt_out_irreversible`), ledger append-only, retenção por prazo, origem e finalidade NOT NULL. Não são promessas: são invariantes que quebram o build se alguém contornar. | **Médio** |

**Sobre o peso de P1:** pequeno porte não é argumento para descuidar. É argumento para não ser
exigível a um mecanismo desproporcional ao porte. Ele sustenta um canal simples e público de
contato — não sustenta um sistema que ignora um pedido.

## 3. Os argumentos a favor do titular

| # | Argumento | Peso |
|---|-----------|------|
| C1 | **O contato não foi obtido por ele.** O telefone veio do caça-leads. Não houve relação, não houve consentimento, não houve nada que indicasse que seria contatado. | **Forte** |
| C2 | **A origem dos dados é opaca para ele.** Sem transparência, o titular não consegue saber se o número veio de lista, de vazamento ou de um cadastro anterior. A pergunta "quem me vendeu?" é legítima e o sistema precisa respondê-la em minutos. | **Médio** |
| C3 | **O telefone é o canal privado dele.** WhatsApp é o telefone pessoal de muita gente. Um celular no bolso é um espaço de silêncio, e o silêncio ali tem valor — é por isso que este sistema só envia em dia útil, entre 7h e 17h. | **Médio** |
| C4 | **O contato é automatizado a partir da segunda mensagem.** A primeira é humana, a segunda em diante é conduzida por LLM externa, e o titular não sabe disso — porque R-055 exige que o sistema não se revele. Essa assimetria é o ponto mais frágil do conjunto. | **Forte** |
| C5 | **A espera por resposta.** Follow-ups em 1h, 1d, 3d e 7d. Um follow-up às 19h não existe, mas o que existe é repetição suficiente para virar incomodação se a primeira resposta não vier. | **Médio** |

**Sobre o peso de C4:** é o argumento mais forte, e é o que este sistema não elimina. Ele
atravessa o legítimo interesse, mas o sistema o enfrenta com limite de volume (R-023, 20–30
mensagens/dia no número inteiro), limite de janela, e handoff no primeiro sinal de irritação.

## 4. O que pesa mais, e por quê

**P2 e C4 se anulam parcialmente; P1 e P3 sustentam o resto.** O contato é profissional e
publicado, o que é o núcleo do Art. 7º, IX — mas o canal é um celular e a partir da segunda
mensagem quem escreve é um sistema que não se identifica.

O que decide o balanço é a **possibilidade real de contrato (P3)** combinada com o **volume
muito baixo (R-023)**. Uma mensagem por vez, em horário comercial, para uma empresa que tem
porte e atividade compatíveis com o serviço, com saída imediata a qualquer momento, é
proporcional. O mesmo conjunto contra um microempreendedor que já pediu para não ser contatado
em outra campanha, ou contra alguém de segmento sensível, deixa de fechar — são as condições
da seção 5.

**Salvaguarda que sustenta a conclusão:** o opt-out imediato e irreversível (R-024). É ela que
transforma "ele não pode escolher ser contatado" em "ele pode escolher parar, e parar é
definitivo". Sem ela, C1 e C4 venceriam. Com ela, o titular tem o controle que o artigo 10
exige como salvaguarda do legítimo interesse.

## 5. QUANDO O BALANCEAMENTO DEIXA DE FECHAR

Esta é a parte que faz deste documento um teste. São condições concretas, verificáveis, e cada
uma tem uma ação do sistema — não uma recomendação.

### 5.1 A empresa é pequena demais para ter interesse no serviço

**Gatilho:** porte estimado da empresa incompatível com o serviço ofertado — microempresa
individual sem CNPJ ativo, empresa inativa há anos, segmento sem relação com o que é vendido.

**Por que fecha:** P3 cai a zero. Sem possibilidade real de contrato não há interesse legítimo
a balancear; o resto dos argumentos perde objeto porque o interesse deixou de existir.

**O que o sistema faz:** **não prosseguir.** O lead não entra na fila de contato. Se já entrou,
o opt-out é gravado como `event_type = 'opt_out'` com `source = 'manual'` e
`detected_by = NULL` — evento de bloqueio manual, não remoção de linha. Nada de follow-up, nada
de handoff, porque handoff para um lead que não deve ser contatado é apenas um convite ao Admin
de contatá-lo.

### 5.2 O titular já pediu para não ser contatado em outra campanha

**Gatilho:** existe qualquer linha em `optout_ledger` para o `lead_id`, de qualquer origem — um
pedido feito há seis meses, ou a mesma pessoa cadastrada com outro `phone_number` e o mesmo
`duplicate_of`.

**Por que fecha:** o opt-out é um ato da pessoa, não do canal. Ele não expira com a campanha,
não expira com o prazo de retenção, e não é um estado que o importador do caça-leads possa
sobrescrever. `leads.opt_out` só admite `false → true`; a transição inversa é barrada por
trigger.

**O que o sistema faz:** **opt-out imediato e permanente.** O guard AR-005 bloqueia tudo, sem
exceção administrativa e sem "só mais esta vez". O `ON CONFLICT` da importação não contém
`opt_out = EXCLUDED.opt_out`: o banco é o estado autoritativo e um lead desatualizado do
provedor não ressuscita um bloqueio.

### 5.3 O lead é de segmento sensível

**Gatilho:** o contato vem de segmento de saúde, de assistência social, de partido ou
governo, de crédito, ou de qualquer contexto que caracterize dado pessoal sensível do Art. 11.

**Por que fecha:** legítimo interesse do Art. 7º, IX não é base legal para dado sensível. Não
há balanceamento que salve: a base legal simplesmente não existe para esse dado.

**O que o sistema faz:** **não coletar.** O dado sensível não entra no `leads`. O
`legal_basis` é `legitimate_interest` e essa coluna é NOT NULL justamente para obrigar a
decisão a ser explícita na importação — se o importador identificar segmento sensível, ele
descarta o registro e registra o descarte em log, em vez de gravar um `legal_basis` que não
sustenta o registro. **Se o Admin notar o caso depois**, o caminho é handoff imediato e
eliminação, com `event_type = 'erasure_request'` — não é uma decisão de prospecção que se
negocia.

### 5.4 Não existe possibilidade real de contrato

**Gatilho:** o lead está fora do segmento, fora da região atendida, ou o serviço não se aplica ao
porte da empresa. Abrange também o caso do follow-up que já foi em 1h, 1d, 3d e 7d sem
resposta.

**Por que fecha:** o interesse legítimo se esgota quando a possibilidade de contratação se
esgota. Prosseguir depois disso não é balanceamento favorável ao controlador, é insistência.

**O que o sistema faz:** **encerrar a cadência.** `conversations.state` vai para `'encerrado'`
com `closed_reason` preenchido. A cadência para de produzir follow-ups e o lead entra no prazo
de retenção de `conversations` e `messages` (180 dias a partir do encerramento — ver
`docs/lgpd/retencao-e-eliminacao.md`). Um follow-up após a quarta tentativa não é prospecção,
é insistência com custo de reputação para o controlador.

### 5.5 O titular exerce qualquer direito do Art. 18

**Gatilho:** qualquer pedido recebido pelo canal de atendimento, por qualquer motivo, inclusive
os benignos.

**Por que fecha:** a partir do pedido, o balanço deixa de ser sobre o controlador e passa a ser
sobre o titular. Um pedido de informação sobre origem é uma pergunta, não uma desistência —
mas enquanto a pergunta não for respondida, a prospecção está suspensa, porque insistir no
contato enquanto o titular pergunta "o que vocês têm comigo?" é o pior desfecho possível.

**O que o sistema faz:** **silêncio total e handoff.** O bot não responde, não confirma
recebimento e não negocia prazo. A resposta sai pelo canal de atendimento — e o canal **não** é
a conversa de WhatsApp, pelo motivo que está escrito em `docs/lgpd/canal-do-titular.md`. O prazo
é de 5 dias úteis.

---

## 6. Conclusão

A base legal é o **legítimo interesse** (Art. 7º, IX, LGPD; R-064). Ele se sustenta porque
combina quatro fatos: contato profissional e publicado, ausência de dado sensível, possibilidade
real de contrato e volume limitado a 20–30 mensagens/dia em janela de dia útil.

A salvaguarda que sustenta essa conclusão é o **opt-out imediato e irreversível**, gravado em
`optout_ledger` como append-only e garantido no banco por trigger, e não apenas no código. É
justamente essa salvaguarda que faz as condições da seção 5 gestionáveis: onde ela falha, o
sistema para; onde ela funciona, o titular tem o controle que o Art. 10 exige.

**A conclusão é condicional.** Ela vale enquanto P1, P2 e P3 forem verdadeiros para o lead
concreto e enquanto o titular tiver o caminho de saída. As cinco condições da seção 5 são as
fronteiras, e nenhuma delas se resolve com uma linha de prompt.