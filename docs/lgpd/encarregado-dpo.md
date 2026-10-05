# Encarregado pelo Tratamento de Dados Pessoais

**Projeto:** Automação Local de WhatsApp para Prospecção B2B
**Fase:** 01 — Fundação, canal e gate de envio
**Base legal da operação:** legítimo interesse (R-064)

Este documento é operacional. Ele diz quem responde, em quanto tempo, e o que essa pessoa não faz.

## 1. Identificação

| Campo | Valor |
|-------|-------|
| Encarregado | **<!-- PREENCHER: nome do encarregado -->** |
| Cargo | **<!-- PREENCHER: cargo -->** |
| E-mail de contato | **<!-- PREENCHER: e-mail dedicado -->** |
| Telefone de contato | o telefone do Admin, dedicado a vendas |
| Titularidade do tratamento | o Admin do sistema |

Os marcadores `PREENCHER` são intencionais. Um encarregado fictício é pior do que um
encarregado declarado ausente: é um endereço que não responde, e o prazo do Art. 41 começa a
correr mesmo assim.

Enquanto o marcador não for preenchido, o canal de contato do titular é **o e-mail do Admin
e o telefone do Admin** — ver `docs/lgpd/canal-do-titular.md`.

## 2. Prazo de resposta

**5 dias úteis**, contados do recebimento da requisição, para qualquer um dos direitos do
Art. 18. O prazo não é negociável por escolher o titular: um pedido de eliminação que demora
três semanas é um pedido negado na prática.

Exceção única, e ela é estreita: **o bloqueio de envio entra em vigor no mesmo instante em que
o pedido chega**, sem esperar o prazo. O opt-out é imediato (R-024); os demais direitos
respondem dentro dos 5 dias úteis.

## 3. O que o encarregado recebe

- **Requisições de titular** — acesso, correção, portabilidade, anonimização, eliminação e
  informação sobre origem dos dados.
- **Pedidos de opt-out** — detectados automaticamente ou comunicados pelo titular.
- **Incidentes de segurança** — incluindo vazamento de banco, comprometimento da pasta
  `auth_info_baileys` ou exposição em log. Ver `docs/adr/002-risco-aceito-r033.md`.
- **Revisão de retenção** — a cada 6 meses, conferir se algo já passou do prazo descrito em
  `docs/lgpd/retencao-e-eliminacao.md`.
- **Solicitações do caça-leads** — pedidos de exclusão da fonte, que se propagam para o banco.

## 4. O que o encarregado NÃO faz

Isto é tão importante quanto a lista anterior, porque a tentação do sistema é delegar.

- **Não decide sobre envio de mensagem.** Nenhuma mensagem sai com base em autorização do
  encarregado. Quem decide é o gate de envio, pelos anti-requisitos AR-001 a AR-012, e ele não
  tem exceção administrativa.
- **Não responde pelo bot.** O encarregado não fala como a automação e não revisa nem aprova
  texto gerado por IA. A IA é um componente de decisão tipada dentro de um fluxo que o código
  controla (R-009).
- **Não contorna opt-out.** Não existe "excepcionalmente", nem "só mais essa vez". O
  `opt_out` é irreversível no banco por trigger, não por bom senso.
- **Não negocia preço, proposta, prazo ou desconto.** AR-001, AR-002 e AR-012 são barreiras
  com handoff, não-item-de-negociação.
- **Não registra base legal nova para um pedido individual.** A base legal é legítimo
  interesse, com origem e finalidade registradas na importação. Uma exceção pontual vira
  base legal diferente, e base legal diferente exige reavaliação do balanceamento.
- **Não usa dado do titular para finalidade diversa.** Os dados servem a contato comercial B2B
  e a nada mais.

## 5. Como o encarregado consulta o que existe sobre um titular

Tudo o que o encarregado precisa para responder sai de três colunas de `leads` e do ledger:

```sql
-- Origem, base legal e finalidade (R-064). legal_registered_at é NOT NULL por schema.
SELECT phone_number, name, origin_source, legal_basis, purpose, legal_registered_at, opt_out
  FROM leads
 WHERE phone_number = $1;

-- Histórico de pedidos e eventos (append-only, ver canal-do-titular.md)
SELECT event_type, source, detected_by, occurred_at, recorded_at, raw_content
  FROM optout_ledger
 WHERE lead_id = $1
 ORDER BY occurred_at DESC;
```

O que **não** se consulta para responder um pedido de eliminação: o corpo das mensagens. A
conversa não é a fonte da resposta, e puxá-la para dentro do atendimento recria exatamente o
problema descrito em `docs/lgpd/canal-do-titular.md`.

## 6. Quando o Admin não é encarregado

Empresa de pequeno porte pode ter o titular como encarregado — e isso é legítimo. O que não é
legítimo é a ausência de um encarregado declarado, porque a ANPD fiscaliza a existência da
figura, não o seu dimensionamento.

**A nomeação tem de estar escrita antes de o primeiro pedido chegar, não durante.**

Três saídas válidas, em ordem de preferência:

1. **O Admin é o encarregado.** Aceitável no piloto. Preencha a seção 1 com o nome do Admin
   e registre que a dualidade de papéis é conhecida e temporária.
2. **Consultoria externa como encarregado (DPO outsourced).** Contratação pontual, com alguém
   nomeado e com e-mail que responde. Não exige dedicado nem equipe interna.
3. **Titular do negócio como encarregado.** Válido quando o titular é pessoa física. Atenção:
   se o Admin é contratado pelo titular, o conflito de interesse é real e precisa estar
   declarado — quem responde ao titular não pode ser quem responde ao chefe.

O que não é saída: deixar a seção 1 com `PREENCHER` indefinidamente e dizer que o sistema tem
um encarregado "por enquanto". Isso é ausência de encarregado, com um documento que finge o
contrário.

## 7. Registro de alterações

| Data | Alteração |
|------|-----------|
| 2026-10-01 | Documento criado no plano 01-01 (Task 4 do 01-02), com o marcador `PREENCHER` |
| 2026-10-05 | Reescrito como procedimento operacional: prazo de 5 dias úteis, o que o encarregado **não** faz, e a seção de nomeação |