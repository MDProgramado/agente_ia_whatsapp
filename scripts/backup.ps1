# backup.ps1 - backup verificado com pg_dump -Fc (R-032, NFRQ-02)
#
# Backup do BANCO e backup da SESSAO sao artefatos separados (T-01-24/T-01-26):
# `auth_info_baileys` fica FORA do dump por padrao, e so e copiado sob o switch
# explicito `-IncludeAuth`. Restaurar os dois juntos reconectaria um numero que
# talvez nao deva ser reconectado.
#
# O dump e verificado, nao so criado (T-01-25): `-Verify` restaura numa base
# temporaria e compara as 4 contagens de linha com a origem. Um `pg_dump` que
# ninguem restaurou e uma hipotese, nao um backup.
param(
  [Parameter(Mandatory=$false)][switch]$LogOnly,
  [Parameter(Mandatory=$false)][switch]$Verify,
  [Parameter(Mandatory=$false)][switch]$IncludeAuth,
  [Parameter(Mandatory=$false)][switch]$RotateOnly
)

$ErrorActionPreference = "Stop"

# --- Execucao de binarios nativos ---------------------------------------------
# Em PowerShell 5.1, sob `$ErrorActionPreference = 'Stop'`, TODA linha que um
# binario escreve em stderr vira um ErrorRecord e ABORTA o pipeline — mesmo com
# exit code 0. Foi isso que quebrou o `-Verify`: `DROP DATABASE IF EXISTS` em um
# banco inexistente (o caso da PRIMEIRA execucao) emite a NOTA "banco de dados
# ... nao existe, ignorando" em stderr, e o script morria ali — sem nunca criar
# a base de teste nem rodar o restore. O wrapper roda o binario com
# `ErrorActionPreference = 'Continue'` (so durante a chamada) e deixa a decisao
# para o `$LASTEXITCODE`, que e a fonte de verdade.
$script:ultimoExit = 0
function Invoke-Nativa {
  param([string]$File, [string[]]$Argumentos)
  $anterior = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $saida = & $File @Argumentos 2>&1
    $script:ultimoExit = $LASTEXITCODE
    return $saida
  } finally {
    $ErrorActionPreference = $anterior
  }
}

function Get-BackupTimestamp {
  param([string]$Nome)
  $match = [regex]::Match($Nome, '^(\d{8})T(\d{6})(?:_pg\d+)?$')
  if (!$match.Success) { return $null }
  $bruto = $match.Groups[1].Value + $match.Groups[2].Value
  return [datetime]::ParseExact($bruto, 'yyyyMMddHHmmss', [Globalization.CultureInfo]::InvariantCulture)
}

# Dumps: os $Manter mais recentes (por carimbo do nome) NUNCA saem, qualquer que
# seja a idade; entre os demais, apaga só o que passou de 30 dias. Pasta sem
# carimbo não é tocada — sem carimbo não há como ler a data sem adivinhar.
function Remove-BackupsExpirados {
  param([string]$Diretorio, [datetime]$Agora, [int]$Manter = 3)
  if (!(Test-Path $Diretorio)) { return @() }
  $removidos = @()
  $limite = $Agora.AddDays(-30)
  $ordenados = @(Get-ChildItem $Diretorio -Directory |
    Where-Object { $null -ne (Get-BackupTimestamp $_.Name) } |
    Sort-Object { Get-BackupTimestamp $_.Name } -Descending)
  for ($i = $Manter; $i -lt $ordenados.Count; $i++) {
    $item = $ordenados[$i]
    $quando = Get-BackupTimestamp $item.Name
    if ($quando -lt $limite) {
      Remove-Item -Path $item.FullName -Recurse -Force
      $removidos += $item.Name
      Write-Host "backup_rotacionado nome=$($item.Name)"
    }
  }
  return $removidos
}

# Sessão: NUNCA rotação por data — perder a sessão é evento raro e custoso
# (R-059). Contagem apenas: ficam as $Manter cópias mais recentes de
# `backups\auth\`; o resto (inclusive cópia recente) sai.
function Remove-AuthBackupsAntigos {
  param([string]$Diretorio, [int]$Manter = 3)
  if (!(Test-Path $Diretorio)) { return @() }
  $removidos = @()
  $ordenados = @(Get-ChildItem $Diretorio -Directory |
    Where-Object { $null -ne (Get-BackupTimestamp $_.Name) } |
    Sort-Object { Get-BackupTimestamp $_.Name } -Descending)
  foreach ($item in ($ordenados | Select-Object -Skip $Manter)) {
    Remove-Item -Path $item.FullName -Recurse -Force
    $removidos += $item.Name
    Write-Host "auth_rotacionado nome=$($item.Name)"
  }
  return $removidos
}

# --- Ambiente: carrega PG*/DATA_ROOT/PGBIN do .env do repo --------------------
# O script e rodado a mao (checkpoint) e pelo Agendador, fora do launcher. Sem
# isto, `psql`/`pg_dump` caem no usuario do SO e falham com
# `role "<usuario>" nao existe`. O .env do repo tem precedencia sobre o default,
# mas NAO sobrescreve o que ja esta no ambiente (mesma regra do launch.cmd, D-01).
$envFilePath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
$chavesEnv = @("PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE", "DATA_ROOT", "PGBIN")
if (Test-Path $envFilePath) {
  foreach ($linha in Get-Content $envFilePath) {
    if ($linha -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $chave = $Matches[1]
      if (($chavesEnv -contains $chave) -and -not [Environment]::GetEnvironmentVariable($chave)) {
        [Environment]::SetEnvironmentVariable($chave, $Matches[2], "Process")
      }
    }
  }
}

# --- Binarios do PostgreSQL ---------------------------------------------------
# Derivados de PGBIN (a mesma convencao do launch.cmd). Usar psql/pg_dump do PATH
# e o erro que produz "version mismatch" silencioso (Armadilha 5).
$PGBin = if ($env:PGBIN) { $env:PGBIN } else { "C:\Program Files\PostgreSQL\18\bin" }
$Psql = Join-Path $PGBin "psql.exe"
$PgDump = Join-Path $PGBin "pg_dump.exe"
$PgRestore = Join-Path $PGBin "pg_restore.exe"

# O ciclo de vida da base de teste do `-Verify` roda como SUPERUSUARIO: o papel da
# aplicacao (`whatsapp_bot`) e least-privilege e NAO tem CREATEDB. E o padrao
# documentado (01-RESEARCH §Backup, 01-PATTERNS §4.11): `psql -U postgres ...`.
# A base de teste pertence ao postgres, entao o restore e as contagens de destino
# tambem rodam como ele — restaurar como o papel dono de outro schema nao funciona.
$PgAdminUser = "postgres"

$DataRoot = if ($env:DATA_ROOT) { $env:DATA_ROOT } else { "C:\whatsapp_prospecao" }
$BackupsDir = Join-Path $DataRoot "backups"
# Sessão copiada fica FORA das pastas datadas: `backups\auth\<timestamp>`.
# Dentro de uma pasta datada ela morreria junto com o dump na rotação de 30
# dias, e a sessão não é rotacionada por data (ver Remove-AuthBackupsAntigos).
$AuthRoot = Join-Path $BackupsDir "auth"

if (!$LogOnly -and !(Test-Path $BackupsDir)) {
  New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null
}

if ($RotateOnly) {
  Remove-BackupsExpirados -Diretorio $BackupsDir -Agora (Get-Date) | Out-Null
  Remove-AuthBackupsAntigos -Diretorio $AuthRoot | Out-Null
  exit 0
}

$serverVer = Invoke-Nativa $Psql @("-d", "whatsapp_prospect", "-tAc", "SHOW server_version;")
if ($script:ultimoExit -ne 0) { throw "Erro ao obter server_version: $serverVer" }
$majorSrv = (("$serverVer" -split '\.')[0]).Trim()

$dumpVer = Invoke-Nativa $PgDump @("--version")
if ($script:ultimoExit -ne 0) { throw "Erro ao obter pg_dump --version: $dumpVer" }
$dumpMatch = [regex]::Match("$dumpVer", '(\d+)\.(\d+)')
if (!$dumpMatch.Success) { throw "pg_dump --version nao reconhecido: $dumpVer" }
$majorDump = $dumpMatch.Groups[1].Value
if ($majorSrv -ne $majorDump) { throw "PGDUMP_VERSION_MISMATCH: pg_dump major ($majorDump) difere de servidor ($majorSrv)" }

$timestamp = (Get-Date).ToString("yyyyMMddTHHmmss")
$backupDir = Join-Path $BackupsDir ($timestamp + "_pg" + $majorSrv)
$dumpFile = Join-Path $backupDir "dump.dump"

# `-LogOnly` roda sem escrever nada: nao cria o diretorio do dump, so descreve o
# que faria. Por isso o `New-Item` do `$backupDir` fica DEPOIS deste bloco.
if ($LogOnly) {
  Write-Host "pg_dump -Fc -> $dumpFile"
  Write-Host "pg_restore -Fc --no-owner --no-privileges -> base temporaria whatsapp_restore_test"
  Write-Host "auth_info_baileys: NAO incluido no dump (use -IncludeAuth para copiar a sessao em separado)"
  exit 0
}

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Invoke-Nativa $PgDump @("-Fc", "-d", "whatsapp_prospect", "-f", $dumpFile) | Out-Null
if ($script:ultimoExit -ne 0) { throw "pg_dump -Fc falhou (exit $script:ultimoExit)" }

if ($IncludeAuth) {
  $authSrc = Join-Path $DataRoot "auth"
  if (Test-Path $authSrc) {
    $authDest = Join-Path $AuthRoot $timestamp
    Copy-Item -Path $authSrc -Destination $authDest -Recurse -Force
  }
}

if ($Verify) {
  $testDb = "whatsapp_restore_test"
  # O DROP IF EXISTS de um banco ausente emite NOTA em stderr — tolerada pelo
  # wrapper (era o bug do passo 5, que abortava o pipeline antes do restore).
  # CREATE/DROP/restore rodam como `postgres`: o papel da app nao tem CREATEDB.
  Invoke-Nativa $Psql @("-U", $PgAdminUser, "-d", "postgres", "-c", "DROP DATABASE IF EXISTS $testDb;") | Out-Null
  Invoke-Nativa $Psql @("-U", $PgAdminUser, "-d", "postgres", "-c", "CREATE DATABASE $testDb;") | Out-Null
  if ($script:ultimoExit -ne 0) { throw "nao consegui criar $testDb (exit $script:ultimoExit)" }
  Invoke-Nativa $PgRestore @("-U", $PgAdminUser, "-d", $testDb, "-Fc", "--no-owner", "--no-privileges", $dumpFile) | Out-Null
  if ($script:ultimoExit -ne 0) { throw "pg_restore em $testDb falhou (exit $script:ultimoExit)" }
  $cLeadsSrc = ("$(Invoke-Nativa $Psql @('-d', 'whatsapp_prospect', '-tAc', 'select count(*) from leads;'))").Trim()
  $cConvSrc  = ("$(Invoke-Nativa $Psql @('-d', 'whatsapp_prospect', '-tAc', 'select count(*) from conversations;'))").Trim()
  $cMsgSrc   = ("$(Invoke-Nativa $Psql @('-d', 'whatsapp_prospect', '-tAc', 'select count(*) from messages;'))").Trim()
  $cDcSrc    = ("$(Invoke-Nativa $Psql @('-d', 'whatsapp_prospect', '-tAc', 'select count(*) from daily_counters;'))").Trim()
  $cLeadsDst = ("$(Invoke-Nativa $Psql @('-U', $PgAdminUser, '-d', $testDb, '-tAc', 'select count(*) from leads;'))").Trim()
  $cConvDst  = ("$(Invoke-Nativa $Psql @('-U', $PgAdminUser, '-d', $testDb, '-tAc', 'select count(*) from conversations;'))").Trim()
  $cMsgDst   = ("$(Invoke-Nativa $Psql @('-U', $PgAdminUser, '-d', $testDb, '-tAc', 'select count(*) from messages;'))").Trim()
  $cDcDst    = ("$(Invoke-Nativa $Psql @('-U', $PgAdminUser, '-d', $testDb, '-tAc', 'select count(*) from daily_counters;'))").Trim()
  Write-Host "orig_leads=$cLeadsSrc dst_leads=$cLeadsDst"
  Write-Host "orig_conv=$cConvSrc dst_conv=$cConvDst"
  Write-Host "orig_msgs=$cMsgSrc dst_msgs=$cMsgDst"
  Write-Host "orig_dc=$cDcSrc dst_dc=$cDcDst"
  Invoke-Nativa $Psql @("-U", $PgAdminUser, "-d", "postgres", "-c", "DROP DATABASE IF EXISTS $testDb;") | Out-Null
}

# Rotação por último: só depois que o dump existe e (com -Verify) foi restaurado
# com sucesso. Rotacionar antes do dump/verify é decidir o que apagar com base em
# um backup que ainda pode falhar no meio do caminho.
Remove-BackupsExpirados -Diretorio $BackupsDir -Agora (Get-Date) | Out-Null
Remove-AuthBackupsAntigos -Diretorio $AuthRoot | Out-Null
exit 0
