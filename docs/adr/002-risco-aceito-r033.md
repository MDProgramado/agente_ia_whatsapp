# ADR-002 — Risco aceito: ausência de criptografia em repouso (R-033)

**Status:** Aceito
**Data:** 2026-09-28
**Substitui:** — (primeiro ADR sobre este tema; ver ADR-001 para o pin do Baileys)
**Relacionados:** ADR-001 (pin `@whiskeysockets/baileys@7.0.0-rc14`), ADR-003 (higiene do PostgreSQL)

---

## Contexto

**R-033 dispensa criptografia adicional.** O texto do requisito é: *"Sem criptografia adicional
implementada pelo sistema. Confiança no controle de acesso do PC."* O risco está classificado como
**ALTO** — "vazamento em caso de acesso indevido, malware, roubo" — e a classificação é a do
próprio requisito, não uma estimativa deste documento.

As condições reais são:

- **Banco local.** PostgreSQL na própria máquina do Admin, conectando por TCP a `127.0.0.1`.
  Sem servidor externo, sem nuvem, sem sincronização do banco.
- **Máquina de usuário único.** R-027 vale nesta fase: uma pessoa opera o sistema. Não há
  segundo usuário do Windows, não há servidor compartilhado, não há Ambiente compartilhado.
- **Disco possivelmente não cifrado.** O projeto **não** exige BitLocker, não o liga, e não tem
  como saber se está ligado. É um recurso do SO, não do sistema.

Somando a isso, o projeto tem uma característica que altera o cálculo de risco: **o número de
WhatsApp dedicado não tem substituto** (R-059). Não existe segundo número, não existe plano de
contingência que recoloque o canal em minutos. A sessão do Baileys **é** o número.

## O que fica aceito

Tudo o que segue está aceito, explicitamente, por esta ADR:

1. **Qualquer processo que roda como o Admin lê o banco em claro.** Não há TDE, não há criptografia
   de coluna, não há criptografia de campo. Um `.exe` executado na sessão do Admin, um script
   PowerShell, um `psql` aberto, um antivírus que abre o arquivo — todos leem
   `leads.phone_number`, `leads.name`, `messages.body` e `optout_ledger.raw_content` sem nenhuma
   barreira criptográfica.

2. **Um `pg_dump` vazado lê tudo em claro.** O dump é o banco inteiro em um arquivo só, sem
   compressão que embaralhe e sem cifragem. Ele contém tudo: os leads, as conversas, os
   identificadores e os eventos de handoff. O risco é o **mesmo** de R-033, amplificado pelo
   volume — e é por isso que o dump tem prazo de 30 dias com rotação, pasta fora do OneDrive,
   `*.dump` no `.gitignore`, e nome de pasta com o carimbo da major version do servidor.

3. **`auth_info_baileys` em claro basta para clonar a sessão do WhatsApp.** A pasta contém as
   credenciais do dispositivo. Quem a lê pode reconectar com aquele número. Não há modo de
   recovery, rotação de credencial, ou invalidação pela metade: ou o número foi clonado, ou não
   foi. Um backup da sessão é uma **cópia funcional da chave do canal**, e é por isso que ela é
   backupada separadamente do banco, nunca versionada, e nunca dentro do OneDrive.

## O que NÃO fica aceito

R-033 trata de criptografia **em repouso**. Ele não diz nada sobre **rede** nem sobre **repositório**
— e essas duas superfícies não são aceitas, porque são fecháveis de graça:

1. **Exposição de rede.** Não aceita. Mitigada por `listen_addresses = 'localhost'` em
   `postgresql.conf`, aplicado e verificado no plano 01-02 (Task 3) e registrado no ADR-003.
   Verificado com `SHOW listen_addresses` devolvendo `localhost`, e não `*`. Sem isso, qualquer
   máquina da rede local — e não só desta — alcançaria o banco que contém os dados de lead.

   Ressalva que fica escrita: o `pg_hba.conf` local está em `trust` para `127.0.0.1`, então
   **qualquer processo local conecta sem senha**. Esse risco residual é aceito e está no ADR-003,
   com senha por role (`scram-sha-256`) como mitigação parcial. Ele é mais estreito que a
   exposição de rede, mas é real e não deve ser descrito como se não existisse.

2. **Exposição via git.** Não aceita. Mitigada pelo `.gitignore`, que cobre `DATA_ROOT/`,
   `auth_info_baileys/`, `*.dump`, `.env` e as chaves de API. Um dump de banco é o caminho mais
   provável de um dado LGPD parar num repositório, e ele é um arquivo que existe por design.

## A afirmação que este ADR precisa fazer

**O risco de autenticação do Baileys é MAIOR que o risco de criptografia do banco, porque a sessão
É o número.**

Não é retórica. Os dois riscos se medem em unidades diferentes, e comparar magnitude é erro de
método — o que se compara aqui é **reversibilidade**:

| | Criptografia do banco (R-033) | Autenticação do Baileys (R-059) |
|---|---|---|
| O que se perde | Dados de lead: nome, telefone, histórico comercial | **O canal inteiro** |
| Existe substituto? | Sim — outro sistema prospecta outros leads | **Não.** R-059: número único, sem redundância |
| Como se recupera | Recomeçar a prospecção; LGPD exige notificação | Aguardar novo pareamento, com risco de sinal de banimento |
| Custo do pior caso | Dano reputacional e sanção | Perda do ativo que sustenta o MVP inteiro |
| Prazo de remediação | Imediato, com aviso | Indefinido, e dependente de terceiro |

Um vazamento do banco é um incidente. Um vazamento da sessão do Baileys é o fim do MVP. O banco
tem defesa de profundidade — retenção por prazo, pseudonimização, `.gitignore`, backups rotacionados,
e o dado tem prazo de 180 dias. A sessão do Baileys não tem defesa de profundidade nenhuma: ela é
um segredo único, sem rotação e sem segunda via.

**Por que isso importa para a decisão:** aceitar a ausência de criptografia em repouso é razoável
porque o dano é recuperável e o dado tem prazo. Aceitar a ausência de proteção sobre a sessão do
Baileys **não** seria razoável, pelo motivo de que a sessão é insubstituível. É por isso que a
proteção da sessão é declarada obrigatória em vez de herdada de R-033: `.gitignore`, fora do
OneDrive, backup separado, e nenhum segredo em tabela (R-033/T-01-10).

## Condições que reabrem a revisão

Esta ADR não é permanente. Ela reabre, e exige nova decisão, quando **qualquer** destas condições
aparecer:

1. **Mais de um usuário na máquina.** O gatilho é `Get-LocalUser` devolvendo mais de uma conta
   humana, ou a instalação do PostgreSQL/R-033 em um computador compartilhado. Com dois usuários, a
   premissa "confiança no controle de acesso do PC" deixa de valer: o outro usuário lê o banco em
   claro, e R-033 não cobre isso. **O que fazer:** decidir entre BitLocker no volume, TDE no
   cluster, ou separar o `DATA_ROOT` por usuário com ACL explícita. As três têm custo; a escolha é
   do Admin e precisa ser registrada.

2. **Backup em mídia sincronizada.** O gatilho é `DATA_ROOT` — ou a pasta `backups\` — passando a
   estar dentro de OneDrive, Google Drive, Dropbox, ou qualquer pasta com sync de nuvem. Um `.dump`
   sincronizado envia os dados de todos os leads para a nuvem em claro, e um `auth_info_baileys`
   sincronizado envia a sessão do WhatsApp. **O que fazer:** mover `DATA_ROOT` para fora da pasta
   sincronizada (o guard `DATA_ROOT_ON_ONEDRIVE` já aborta o boot se isso acontecer) e cifrar o
   backup com ferramenta externa ao projeto, porque aí a proteção sai do escopo de R-033 por
   decisão consciente.

3. **Migração de `127.0.0.1` para outro host.** O gatilho é o banco deixar de ser local: servidor
   em rede, VM, container, ou o plano de migração para a API oficial do WhatsApp (R-016). R-033 foi
   escrito para um banco local sem rede. **O que fazer:** esta ADR é **inviável** nesse cenário —
   é preciso criptografia em trânsito (TLS), e portanto revisar R-033 antes de qualquer mudança de
   host. Não é uma revisão de tuning; é uma mudança de premissa.

4. **Exigência do titular ou da ANPD.** O gatilho é um pedido formal de medida de segurança
   específico, uma notificação de incidente, ou ação de fiscalização. **O que fazer:** atender o
   prazo do titular (5 dias úteis) e responder com o conteúdo desta ADR — ela já é o registro do
   risco, do que foi aceito, e do que não foi aceito. Esconder a ausência de criptografia em uma
   resposta a fiscalização seria pior que a ausência.

5. **BitLocker desligado em máquina com dado real.** O gatilho é `Get-BitLockerVolume` reportando
   `Off` depois que o piloto tiver dado de verdade no banco. **O que fazer:** ligar o BitLocker
   é uma mitigação de SO, não do sistema, e não muda nenhuma linha deste ADR — mas reduz
   substancialmente a exposição item 1 desta lista de "o que fica aceito". Recomendação, não
   obrigação: R-033 não exige, e esta ADR não inventa a exigência.

## O que este ADR não afirma

- **Não** afirma que existe criptografia. Não há criptografia de banco, de coluna, de campo, de
  sessão, nem de backup. O que existe é: senha por role no PostgreSQL (`scram-sha-256`), binding em
  `localhost`, `.gitignore`, retenção por prazo e rotação de backup. Nenhum desses itens é
  criptografia de dados.
- **Não** afirma que o risco é baixo. R-033 classifica como **ALTO**, e a classificação está
  mantida.
- **Não** afirma que o backup está protegido. Um `pg_dump` está em claro. Os controles em volta
  deles são de exposição (fora do OneDrive, fora do git, prazo de 30 dias) e não de cifragem.
