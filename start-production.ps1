<#
  bridge/start-production.ps1 - explicit start (and stop-flag clearing) for the production bridge.

  2026-09-28 SHORT-LIVED BRIDGE ENSURER migration:
    * start and the periodic Task Scheduler trigger now share ONE code path
      (bridge\ensure-bridge.ps1: identity check + duplicate prevention + health fingerprint)
    * this script's only extra semantics is the intentional-start side of the persistent
      stop flag: stop-production.ps1 writes runtime\stop.flag and the ensurer then refuses to
      start the bridge; an explicit start clears that flag and ensures the bridge is up.

  Usage:
    powershell -NoProfile -File bridge\start-production.ps1
    powershell -NoProfile -File bridge\start-production.ps1 -Proxy <HTTP_PROXY_URL>

  Verification semantics (2026-10-14): "bridge ready" is printed only after the live
  /health answers 200 within a bounded wait. A skipped ensurer run (lock_busy, proxy
  warming up) is never treated as success, and a failure prints the ensurer's recorded
  outcome/reason (see runtime\ensure-last.json).
#>
[CmdletBinding()]
param(
    [string]$BridgeDir = '',
    [string]$Proxy = $env:HTTPS_PROXY,
    [string]$Port = '8799',
    [int]$MaxWaitSeconds = 120,
    [int]$RetryIntervalSeconds = 10,
    [int]$ProxyProbeTimeoutMs = 2000,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
# $RetryIntervalSeconds / $ProxyProbeTimeoutMs are kept for CLI compatibility; the ensurer
# owns retry + proxy-wait semantics now.

if (-not $BridgeDir) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { (Get-Location).Path }
    $BridgeDir = $scriptDir
}
$BridgeDir = (Resolve-Path -LiteralPath $BridgeDir).Path
. (Join-Path $BridgeDir 'runtime-lib.ps1')
Initialize-BridgeRuntime
$healthUri = "http://127.0.0.1:$Port/health"

function Write-Line([string]$m) { if (-not $Quiet) { Write-Output $m } }

# 1) intentional start clears the persistent stop flag written by stop-production.ps1
$stopFlagPath = Join-Path $BridgeDir 'runtime\stop.flag'
if (Test-Path -LiteralPath $stopFlagPath) {
    Remove-Item -LiteralPath $stopFlagPath -Force -ErrorAction SilentlyContinue
    Write-Line 'cleared persistent stop flag (runtime\stop.flag)'
}

# 2) shared code path with the periodic ensurer
$ensure = Join-Path $BridgeDir 'ensure-bridge.ps1'
if (-not (Test-Path -LiteralPath $ensure)) { throw "ensure-bridge.ps1 not found: $ensure" }
$readyTimeout = 45
if ($MaxWaitSeconds -gt 0 -and $MaxWaitSeconds -lt 45) { $readyTimeout = $MaxWaitSeconds }
& $ensure -Proxy $Proxy -BridgeReadyTimeoutSeconds $readyTimeout -ProxyReadyTimeoutSeconds 30 -Quiet:$Quiet
$ensureExit = $LASTEXITCODE

# 3) caller-facing verification - decided by the live service only.
#    The ensurer's exit code just says the ensurer ran; a skipped lock_busy run, a proxy
#    still warming up, or a start that failed for a recorded reason are all NOT proof that
#    the bridge is up. So: read the ensurer's last record for diagnostics, then wait
#    (bounded) for real /health before reporting anything.
$ensureRecord = $null
$ensureLastPath = Join-Path $BridgeDir 'runtime\ensure-last.json'
try {
    if (Test-Path -LiteralPath $ensureLastPath) {
        $ensureRecord = Get-Content -Raw -Encoding UTF8 -LiteralPath $ensureLastPath | ConvertFrom-Json
    }
} catch { $ensureRecord = $null }
$ensureDesc = if ($ensureRecord -and $ensureRecord.outcome) {
    ([string]$ensureRecord.outcome + '/' + [string]$ensureRecord.reason)
} else {
    'no-record'
}

$waitSeconds = if ($MaxWaitSeconds -gt 0) { [Math]::Min($MaxWaitSeconds, 120) } else { 30 }
$deadline = (Get-Date).AddSeconds($waitSeconds)
$ok = $false
while ($true) {
    try {
        $r = Invoke-WebRequest -Uri $healthUri -UseBasicParsing -TimeoutSec 3
        $ok = ($r.StatusCode -eq 200)
    } catch { $ok = $false }
    if ($ok) { break }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Seconds 2
}

if ($ok) {
    $ownerPid = Get-BridgePortOwner
    $state = Read-BridgeState
    $healthBody = Get-BridgeHealth
    if ($ownerPid -gt 0 -and (Test-BridgeListenerIdentity -ProcessId $ownerPid -State $state -HealthBody $healthBody)) {
        Write-Line "bridge ready (ensure exit=$ensureExit; ensure=$ensureDesc; health=200; verified_pid=$ownerPid)"
        exit 0
    }
    Write-Line "BRIDGE_START_FAILED (health=200 but listener identity could not be verified; port_owner=$ownerPid)"
    exit 1
}
Write-Line "BRIDGE_START_FAILED (ensure exit=$ensureExit; ensure=$ensureDesc; /health not 200 after ${waitSeconds}s)"
exit 1
