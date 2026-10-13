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

$DataRoot = if ($env:DATA_ROOT) { $env:DATA_ROOT } else { "C:\whatsapp_prospecao" }
$BackupsDir = Join-Path $DataRoot "backups"

if (!$LogOnly -and !(Test-Path $BackupsDir)) {
  New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null
}

$serverVer = & $Psql -d whatsapp_prospect -tAc "SHOW server_version;" 2>&1
if ($LASTEXITCODE -ne 0) { throw "Erro ao obter server_version: $serverVer" }
$majorSrv = (($serverVer -split '\.')[0]).Trim()

$dumpVer = & $PgDump --version 2>&1
$dumpMatch = [regex]::Match($dumpVer, '(\d+)\.(\d+)')
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
& $PgDump -Fc -d whatsapp_prospect -f $dumpFile

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
  & $Psql -d postgres -c "DROP DATABASE IF EXISTS $testDb;" 2>&1 | Out-Null
  & $Psql -d postgres -c "CREATE DATABASE $testDb;" 2>&1 | Out-Null
  & $PgRestore -d $testDb -Fc --no-owner --no-privileges $dumpFile 2>&1 | Out-Null
  $cLeadsSrc = (& $Psql -d whatsapp_prospect -tAc "select count(*) from leads;").Trim()
  $cConvSrc  = (& $Psql -d whatsapp_prospect -tAc "select count(*) from conversations;").Trim()
  $cMsgSrc   = (& $Psql -d whatsapp_prospect -tAc "select count(*) from messages;").Trim()
  $cDcSrc    = (& $Psql -d whatsapp_prospect -tAc "select count(*) from daily_counters;").Trim()
  $cLeadsDst = (& $Psql -d $testDb -tAc "select count(*) from leads;").Trim()
  $cConvDst  = (& $Psql -d $testDb -tAc "select count(*) from conversations;").Trim()
  $cMsgDst   = (& $Psql -d $testDb -tAc "select count(*) from messages;").Trim()
  $cDcDst    = (& $Psql -d $testDb -tAc "select count(*) from daily_counters;").Trim()
  Write-Host "orig_leads=$cLeadsSrc dst_leads=$cLeadsDst"
  Write-Host "orig_conv=$cConvSrc dst_conv=$cConvDst"
  Write-Host "orig_msgs=$cMsgSrc dst_msgs=$cMsgDst"
  Write-Host "orig_dc=$cDcSrc dst_dc=$cDcDst"
  & $Psql -d postgres -c "DROP DATABASE IF EXISTS $testDb;" 2>&1 | Out-Null
}
exit 0
