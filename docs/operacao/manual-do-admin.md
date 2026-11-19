# Manual de Operação do Piloto (Admin)

Este documento define o protocolo de operação do piloto de prospecção B2B de 30 dias (R-049, R-050, R-060).

## 1. Princípios Fundamentais e Regras Não Negociáveis

1. **Operador Único (OPRE-02 / R-049):** O piloto é operado exclusivamente pelo Admin. Não compartilhe a lista de leads nem delegue o atendimento durante esta fase.
2. **Primeiro Contato Manual (R-001):** O bot **NUNCA** inicia a abordagem de leads frios. O primeiro contato deve ser enviado manualmente pelo Admin através do WhatsApp (celular ou painel com ação explícita). Isso estabelece legitimidade de canal perante os algoritmos anti-spam da Meta.
3. **Limites de Volume (R-023):**
   - Máximo de **20 novos leads/dia**.
   - Máximo de **20 a 30 mensagens enviadas/dia** no número dedicado.
4. **Janela Operacional (R-006):**
   - Segunda a Sexta-feira, das **07:00 às 17:00** (horário de Brasília).
   - Fora deste horário ou em feriados nacionais, o robô permanece em repouso e qualquer envio fica enfileirado para o próximo dia útil.
5. **Handoff Imediato e Silêncio:**
   - Em caso de pedido de preço, orçamento, agendamento de reunião, dúvida técnica complexa ou sinal de irritação, o bot interrompe os envios imediatamente, aciona notificação sonora e pop-up no Windows e aguarda intervenção humana.

---

## 2. Rotina Diária Passo a Passo

### Início da Manhã (07:00 - 08:00)
1. **Inicialização do Sistema:**
   - Verifique se o serviço PostgreSQL está ativo.
   - Abra o terminal e execute:
     ```bash
     npm run dev
     ```
   - Acesse o painel local em `http://127.0.0.1:8787` e informe o `PANEL_TOKEN`.
   - Confira o cabeçalho: o indicador deve exibir **BOT ATIVO** e **Ao vivo**.
2. **Importação dos Leads do Dia:**
   - Importe a lista de até 20 contatos com origem, base legal (`legitimo_interesse`) e finalidade devidamente registradas.
3. **Envio da 1ª Mensagem Manual:**
   - Envie a mensagem introdutória de prospecção consultiva para os novos leads diretamente do seu WhatsApp conectado.
   - O sistema detectará automaticamente o envio (`fromMe`) e moverá os leads de `Novo` para `Aquecimento`.

### Durante o Dia (08:00 - 17:00)
1. **Monitoramento Reativo (Aguarde os Alertas):**
   - Você não precisa ficar olhando a tela. O sistema emitirá som e notificação pop-up nativa do Windows quando um lead precisar de atenção humana (*Handoff*).
2. **Atendimento de Handoffs:**
   - Ao receber o alerta, abra o painel no lead correspondente.
   - Analise o contexto da conversa e a sugestão formulada pelo Copiloto.
   - Se a sugestão estiver alinhada, você pode aproveitá-la, editá-la e clicar no botão **Enviar** (único choke-point seguro do gate).
   - Caso o lead peça agendamento, combine o horário diretamente e registre o agendamento no funil do CRM (`Reunião agendada`).
3. **Opt-Out (R-024):**
   - Se o lead solicitar não receber mais mensagens, o bot detectará automaticamente. Caso necessário, utilize o botão **Marcar opt-out** na aba *Compliance* da gaveta de detalhes do lead (ação irreversível com confirmação digitada `OPTOUT`).

### Final do Dia (17:00)
1. **Verificação de Pendências:**
   - Revise o quadro do funil no painel (`PipelineBoard`).
   - Verifique tarefas pendentes no painel de CRM.
2. **Backup Diário (R-032):**
   - Execute o script de backup local:
     ```powershell
     .\scripts\backup.ps1 -Verify
     ```

