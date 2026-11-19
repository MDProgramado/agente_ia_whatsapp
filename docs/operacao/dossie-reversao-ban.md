# Dossier de Prevenção e Apelação de Bloqueio (WhatsApp / Meta)

Este documento compila a fundamentação jurídica, técnica e operacional para ser utilizada de forma imediata na hipótese de restrição ou banimento temporário do número dedicado (R-059).

---

## 1. Dados e Identificação da Operação

- **Empresa / Titular da Linha:** [Nome / Razão Social]
- **CNPJ:** [CNPJ da Operação]
- **Finalidade da Linha:** Comunicação institucional e prospecção ativa B2B para prestação de serviços de tecnologia da informação (desenvolvimento de software e automações).
- **Número do Telefone:** [Telefone E.164]

---

## 2. Conformidade com os Termos de Serviço e LGPD

1. **Inexistência de Envios em Massa (*Anti-Bulk*):**
   - A operação possui trava técnica intransponível no código-fonte (`WHS-04`) com teto diário de **20 a 30 mensagens por dia**.
   - Não há disparo automatizado para listas frias: **o primeiro contato é sempre manual e individualizado** pelo operador humano (R-001).
   - Intervalos de envio humanizados com delays aleatórios entre frases e simulação de digitação (R-067).

2. **Base Legal LGPD (Lei nº 13.709/2018):**
   - **Artigo 7º, Inciso IX (Legítimo Interesse):** Abordagem estritamente comercial corporativa (B2B), entre pessoas jurídicas / tomadores de decisão comercial, sem tratamento de dados de crianças, adolescentes ou dados sensíveis.
   - Todo contato registra no banco de dados local a fonte de obtenção pública (como Receita Federal / canais oficiais públicos de divulgação comercial).

3. **Garantia de Opt-Out Incondicional e Imediato (R-024):**
   - Qualquer manifestação de desinteresse do contato ("pare", "não quero", "descadastre") resulta em bloqueio permanente e imediato registrado em tabela *append-only* (`optout_ledger`), tornando impossível novos disparos pelo sistema.

---

## 3. Modelo de Solicitação de Revisão (Ticket / Suporte Meta)

### Assunto:
> Solicitação de revisão de bloqueio indevido de linha corporativa comercial — [Seu Número E.164]

### Mensagem de Apelação:
> Prezados atendentes do Suporte do WhatsApp / Meta Business,
>
> Venho por meio desta solicitar a revisão e desbloqueio da minha linha telefônica [Telefone], utilizada exclusivamente para contato corporativo e atendimento a clientes da nossa empresa.
>
> Esclarecemos que nossa operação:
> 1. Não pratica spam nem envios automatizados em massa (mantemos volume estrito de no máximo 20 contatos comerciais por dia).
> 2. Realiza todas as abordagens de maneira individualizada, com base no Legítimo Interesse comercial B2B em estrita conformidade com a LGPD (Lei 13.709/2018).
> 3. Respeita imediatamente e de forma definitiva qualquer pedido de opt-out ou cancelamento de contato.
>
> Acreditamos que o bloqueio ocorreu devido a um falso positivo dos filtros automatizados de tráfego. Estamos à disposição para apresentar quaisquer documentos comprobatórios de nossa idoneidade e conformidade.
>
> Solicitamos respeitosamente a reativação do canal para continuidade de nossas atividades profissionais.
>
> Atenciosamente,  
> [Seu Nome / Cargo]  
> [Contato de E-mail Corporativo]

