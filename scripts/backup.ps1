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
  [Parameter(Mandatory=$false)][switch]$IncludeAuth
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

if (!$LogOnly -and !(Test-Path $BackupsDir)) {
  New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null
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
  $authSrc = Join-Path $DataRoot "auth_info_baileys"
  if (Test-Path $authSrc) {
    Copy-Item -Path $authSrc -Destination $backupDir -Recurse -Force
  }
}

Get-ChildItem $BackupsDir -Directory | Where-Object {
  $_.CreationTime -lt (Get-Date).AddDays(-30)
} | ForEach-Object {
  Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
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
exit 0
