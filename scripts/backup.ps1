# backup.ps1 - backup verificado com pg_dump -Fc (R-032)
param(
  [Parameter(Mandatory=False)][switch]$LogOnly,
  [Parameter(Mandatory=False)][switch]$Verify,
  [Parameter(Mandatory=False)][switch]$IncludeAuth
)

$ErrorActionPreference = "Stop"

$DataRoot = "C:\whatsapp_prospecao"
$BackupsDir = Join-Path $DataRoot "backups"

if (!(Test-Path $BackupsDir)) {
  New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null
}

$serverVer = psql -d whatsapp_prospect -tAc "SHOW server_version;" 2>&1
if ($LASTEXITCODE -ne 0) { throw "Erro ao obter server_version: $serverVer" }
$majorSrv = (($serverVer -split '\.')[0]).Trim()

$dumpVer = pg_dump --version 2>&1
$dumpMatch = [regex]::Match($dumpVer, '(\d+)\.(\d+)')
if (!$dumpMatch.Success) { throw "pg_dump --version n�o reconhecido: $dumpVer" }
$majorDump = $dumpMatch.Groups[1].Value
if ($majorSrv -ne $majorDump) { throw "PGDUMP_VERSION_MISMATCH: pg_dump major ($majorDump) difere de servidor ($majorSrv)" }

$timestamp = (Get-Date).ToString("yyyyMMddTHHmmss")
$backupDir = Join-Path $BackupsDir ("" + "_pg" + $majorSrv)
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$dumpFile = Join-Path $backupDir "dump.dump"

if ($LogOnly) {
  Write-Host "pg_dump -Fc -> $dumpFile"
  exit 0
}

pg_dump -Fc -d whatsapp_prospect -f $dumpFile

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
  psql -d postgres -c "DROP DATABASE IF EXISTS $testDb;" 2>&1 | Out-Null
  psql -d postgres -c "CREATE DATABASE $testDb;" 2>&1 | Out-Null
  pg_restore -d $testDb -Fc --no-owner --no-privileges $dumpFile 2>&1 | Out-Null
  $cLeadsSrc = (psql -d whatsapp_prospect -tAc "select count(*) from leads;").Trim()
  $cConvSrc  = (psql -d whatsapp_prospect -tAc "select count(*) from conversations;").Trim()
  $cMsgSrc   = (psql -d whatsapp_prospect -tAc "select count(*) from messages;").Trim()
  $cDcSrc    = (psql -d whatsapp_prospect -tAc "select count(*) from daily_counters;").Trim()
  $cLeadsDst = (psql -d $testDb -tAc "select count(*) from leads;").Trim()
  $cConvDst  = (psql -d $testDb -tAc "select count(*) from conversations;").Trim()
  $cMsgDst   = (psql -d $testDb -tAc "select count(*) from messages;").Trim()
  $cDcDst    = (psql -d $testDb -tAc "select count(*) from daily_counters;").Trim()
  Write-Host "orig_leads=$cLeadsSrc dst_leads=$cLeadsDst"
  Write-Host "orig_conv=$cConvSrc dst_conv=$cConvDst"
  Write-Host "orig_msgs=$cMsgSrc dst_msgs=$cMsgDst"
  Write-Host "orig_dc=$cDcSrc dst_dc=$cDcDst"
  psql -d postgres -c "DROP DATABASE IF EXISTS $testDb;" 2>&1 | Out-Null
}
exit 0