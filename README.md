# Automação Local de WhatsApp para Prospecção B2B (SDR)

> **Um SDR digital autônomo e consultivo para WhatsApp que qualifica leads, contorna objeções e faz follow-up de 4 toques em horário comercial — acionando handoff humano com silêncio total no instante em que o cliente pede preço, orçamento ou reunião.**

Desenvolvido para prestadores de serviços de tecnologia, agências e desenvolvedores que prospectam tomadores de decisão em empresas (B2B) sem queimar o chip nem violar a LGPD.

---

## ⚡ Como Rodar do Zero

### Pré-requisitos Exatos
- **SO:** Windows 10/11 (obrigatório: o sistema usa notificações WinRT nativas e caminhos locais).
- **Node.js:** `24.x LTS` (Node 24.21.0 ou superior; não use v26).
- **PostgreSQL:** `18.x` local instalado e rodando em `127.0.0.1:5432` (com `pg_dump` e `pg_restore` da mesma versão).
- **Diretório de Dados:** `C:\whatsapp_prospecao` (fora do OneDrive; criado automaticamente pelo boot).

### Passo a Passo

1. **Clone e instale dependências:**
   ```powershell
   git clone <url-do-repositorio>
   cd automacao_whatsapp
   npm install
   ```

2. **Configure as Variáveis de Ambiente:**
   Copie o arquivo de exemplo e preencha os seus dados:
   ```powershell
   copy .env.example .env
   ```
   *(Abra o `.env` e configure o `DATABASE_URL`, o seu número em `CHANNEL_PHONE_E164`, o `PANEL_TOKEN` e a sua chave em `LLM_API_KEY`)*.

3. **Crie a base de dados no PostgreSQL:**
   ```powershell
   psql -U postgres -c "CREATE DATABASE whatsapp_prospect;"
   ```
   *(As migrations do Drizzle rodam sozinhas automaticamente no primeiro boot)*.

4. **Inicie o sistema com 1 clique:**
   ```powershell
   .\scripts\iniciar-sistema.cmd
   ```
   *Ou execute manualmente via terminal:*
   ```powershell
   npm run build
   npm run dev
   ```
   O painel de controle abrirá automaticamente em `http://127.0.0.1:8787`.

---

## ⚙️ Variáveis de Ambiente (`.env`)

Todas as variáveis são validadas de forma estrita no boot com Zod (fail-closed):

| Variável | Obrigatória? | Padrão | Descrição |
| :--- | :---: | :---: | :--- |
| `DATABASE_URL` | **Sim** | — | String de conexão com o Postgres local (`postgres://user:pass@127.0.0.1:5432/whatsapp_prospect`). |
| `PANEL_TOKEN` | **Sim** | — | Token secreto Bearer para autenticar o painel web local contra DNS-rebinding. |
| `CHANNEL_PHONE_E164` | **Sim** | — | O número de telefone dedicado em formato internacional E.164 (ex: `+5511999999999`). |
| `LLM_API_KEY` | **Sim** | `""` | Chave de API da LLM configurada (`OpenAI`, `Anthropic` ou `Google`). |
| `LLM_PROVIDER` | Não | `openai` | Provedor de IA: `openai`, `anthropic` ou `google`. |
| `LLM_MODEL` | Não | `gpt-4o-mini` | Modelo da IA utilizado para raciocínio consultivo e classificação. |
| `DATA_ROOT` | Não | `C:\whatsapp_prospecao` | Diretório fora do OneDrive onde vivem a sessão do WhatsApp, logs e backups. |
| `DAILY_MESSAGE_LIMIT` | Não | `25` | Limite operacional máximo de mensagens/dia (teto físico absoluto do banco: 30). |
| `DAILY_LEAD_LIMIT` | Não | `20` | Teto diário de novos contatos/leads abordados por dia útil. |
| `WINDOW_START_HOUR` | Não | `7` | Hora de início da janela comercial (7h). |
| `WINDOW_END_HOUR` | Não | `17` | Hora de término da janela comercial (17h). |
| `TZ` | Não | `America/Sao_Paulo`| Fuso horário de referência para validação da janela e feriados nacionais. |
| `KILL_SWITCH` | Não | `false` | Se `true`, corta imediatamente qualquer envio do bot. |

---

## 🧪 Testes e Cobertura

O projeto adota validação defensiva com suíte de testes automatizados via **Vitest**, cobrindo o banco PostgreSQL real, a máquina de estados, os 12 anti-requisitos e as APIs.

```powershell
# Executa todos os testes automatizados
npm test

# Executa checagem de tipos (Node + Web)
npm run typecheck

# Executa lint e formatação
npm run lint
```

- **Estado Real dos Testes:** **431 testes passando (100% verdes)** em 70 arquivos de teste.
- **Auditoria de Envio:** O choke-point de disparo garante que **apenas um único arquivo no sistema inteiro** (`src/application/dispatcher.ts`) pode invocar `sendText` do canal, garantindo que nenhuma mensagem sai sem passar pelo gate de segurança.

---

## 🏛️ Decisões de Arquitetura (Por que foi feito assim?)

* **Policy Gate Determinístico antes da LLM:**
  *Decisão:* A IA nunca fala diretamente com o WhatsApp. Ela apenas gera rascunhos tipados via Zod (`Output.object`). O código local valida 12 anti-requisitos (preço, agendamento, opt-out, janela, limite) e aplica regex pós-geração.
  *Por quê:* Se o modelo alucinar e prometer desconto ou valor, o gate intercepta e cala o robô.
* **Baileys Pinado vs API Oficial (Fase Atual):**
  *Decisão:* Adotamos `@whiskeysockets/baileys` isolado em interface (`ChannelPort`), permitindo migração futura para a WhatsApp Cloud API da Meta sem alterar banco ou regras.
  *Por quê:* Custo zero inicial para validação do produto com o número dedicado do operador.
* **Drizzle ORM + PostgreSQL Local vs Prisma/SQLite:**
  *Decisão:* Usamos Drizzle ORM sobre PostgreSQL 18 local.
  *Por quê:* O Prisma possui binários Rust que sofrem com pastas sincronizadas no Windows e o SQLite não suporta bloqueios de concorrência refinados (`FOR UPDATE SKIP LOCKED`) necessários para evitar envios duplicados de mensagens.
* **Filas via Postgres (`SKIP LOCKED`) vs Redis/BullMQ:**
  *Decisão:* A fila de envio (`outbox`) e o agendamento rodam diretamente no PostgreSQL.
  *Por quê:* Elimina a necessidade de instalar e manter um servidor Redis no Windows de um operador único.

---

## ⚠️ Limitações e Dívidas Técnicas Conhecidas

1. **Estabilidade do Socket Baileys (`P-007`):**
   O emparelhamento na versão `7.0.0-rc14` sofre com encerramento prematuro de socket contra os servidores atuais do WhatsApp em certas redes (`Connection Failure`). Um fork atualizado do Baileys ou migração para Cloud API oficial está mapeado como ADR-002.
2. **Áudios de Leads não são ouvidos:**
   Se um cliente responde por mensagem de voz, o bot não transcreve o áudio: ele registra a mídia e aciona o handoff humano imediatamente.
3. **Mono-máquina / Single-Operator:**
   O sistema foi desenhado para rodar no PC local do Admin. Se a máquina for desligada ou suspender, o bot pausa os envios e retoma no dia seguinte com dreno controlado de catch-up (sem rajadas).

---

## 🔒 Segurança e LGPD

- **Segredos:** O arquivo `.env` nunca sobe para o Git. O `PANEL_TOKEN` protege o Fastify contra ataques de DNS-Rebinding originados em abas do navegador.
- **Base Legal (LGPD Art. 7º, IX):** Todo lead importado é obrigatoriamente associado à sua origem e à base de *Legítimo Interesse comercial B2B*.
- **Opt-Out Irreversível:** Qualquer comando ou pedido de opt-out (ex: *"pare", "não quero"*) grava uma prova indelével em tabela *append-only* (`optout_ledger`). É fisicamente impossível o bot mandar mensagem para um número em opt-out.
- **Isolamento de Dados:** A pasta de autenticação do WhatsApp e logs (`C:\whatsapp_prospecao`) é forçada para fora de diretórios sincronizados na nuvem (OneDrive/Dropbox) para evitar vazamento de credenciais de sessão.

---

## 📋 Comandos do Operador (CLI)

Além do painel web em `http://127.0.0.1:8787`, você pode operar e auditar via terminal:

```powershell
# Diagnóstico estatístico da cadência real de follow-up
npm run pilot:calibrate

# Relatório mensal de KPIs do piloto (5 reuniões, 30% qualificação, auditoria)
npm run pilot:report

# Pausar ou retomar toda a automação manualmente
npm run mode pause
npm run mode resume

# Fazer backup verificado dos dados locais
npm run backup -- -Verify
```

---

## 📄 Licença e Manutenção

- **Licença:** Privada / Proprietária. Uso restrito e pessoal.
- **Contribuições:** Este repositório é um projeto pessoal de uso operacional único e não aceita Pull Requests externos.
- **Documentação de Engenharia:** Consulte a pasta `docs/` e `.planning/` para ler as regras de negócio completas (R-001 a R-067), os anti-requisitos (AR-001 a AR-012) e os Registros de Decisão de Arquitetura (ADRs).

