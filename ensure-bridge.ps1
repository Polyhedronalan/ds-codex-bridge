<#
  bridge/ensure-bridge.ps1 - SHORT-LIVED bridge ensurer (replaces the long-lived supervisor).

  Contract (see the approved design):
    1. runtime\stop.flag present            -> do NOT start, do NOT clear it, reason=stop_flag, exit 0
    2. ensure.lock serialises triggers      -> PID + timestamp; >LockStaleSeconds or dead PID = stale, take over
    3. port 8799 has a listener             -> owner must be node.exe running bridge\bridge.mjs
                                               AND /health must answer with our fingerprint
                                               healthy  -> repair pid/state if needed, exit 0
                                               foreign  -> never start a 2nd bridge, reason=foreign_listener, exit 0
    4. port 8799 has no listener            -> start bridge.mjs detached + hidden, wait <=45s for
                                               health 200 AND owner pid == our child pid
    5. duplicate prevention                 -> lock + single OS port instance + owner-pid verification
    6. logging                              -> lifecycle.jsonl only when something actually happened;
                                               runtime\ensure-last.json overwritten on every run

  Exit codes: 0 = ensured / no-op / policy skip (stop flag, foreign listener, wedged listener, lock busy)
              2 = could not bring the bridge up
              1 = unexpected error

  Failure reasons recorded in runtime\ensure-last.json (never just "failed"):
    stop_flag | lock_busy | proxy_not_ready | bridge_healthy | bridge_started |
    record_mismatch | adopted_race_winner | foreign_listener | listener_up_no_health |
    process_exit_<code> | health_timeout | port_taken_by_foreign

  It never modifies bridge.mjs, config, providers, credentials or history.
#>
[CmdletBinding()]
param(
    [string]$Proxy = $env:HTTPS_PROXY,
    [int]$BridgeReadyTimeoutSeconds = 45,
    [int]$LockStaleSeconds = 120,
    [int]$ProxyReadyTimeoutSeconds = 30,
    [switch]$SkipProxyCheck,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-lib.ps1')
Initialize-BridgeRuntime

$startedAt = Get-Date
$ensureLastPath = Join-Path $script:RuntimeDir 'ensure-last.json'
$lockPath = Join-Path $script:RuntimeDir 'ensure.lock'
$script:EnsureResult = [ordered]@{
    started_at = $startedAt.ToUniversalTime().ToString('o')
    pid        = $PID
    parent_pid = $null          # filled in only on non-fast paths (CIM lookup is ~250ms)
    outcome    = 'pending'
    reason     = ''
    action     = 'none'
    owner_pid  = 0
    health     = ''
    console_hwnd = 0
    console_visible_hint = $false
    took_ms    = 0
}

function Complete-Ensure {
    param(
        [Parameter(Mandatory)][string]$Outcome,
        [string]$Reason = '',
        [string]$Action = 'none',
        [int]$OwnerPid = 0,
        [string]$HealthBody = ''
    )
    $script:EnsureResult.outcome = $Outcome
    $script:EnsureResult.reason = $Reason
    $script:EnsureResult.action = $Action
    $script:EnsureResult.owner_pid = $OwnerPid
    $script:EnsureResult.health = $HealthBody
    $script:EnsureResult.took_ms = [int]((Get-Date) - $startedAt).TotalMilliseconds
    # Visibility self-check (cheap, no P/Invoke): Task Scheduler launches us with
    # -WindowStyle Hidden, so the process must not own a main console window.
    try {
        $hwnd = (Get-Process -Id $PID -ErrorAction Stop).MainWindowHandle
        $script:EnsureResult.console_hwnd = [int64]$hwnd
        $script:EnsureResult.console_visible_hint = ($hwnd -ne 0)
    } catch { }
    try {
        ($script:EnsureResult | ConvertTo-Json -Compress) | Set-Content -LiteralPath $ensureLastPath -Encoding UTF8
    } catch { }
    if (-not $Quiet) { Write-Output ($script:EnsureResult | ConvertTo-Json -Compress) }
}

function Test-OurBridgeListener {
    param([int]$ProcessId)
    return (Test-BridgeListenerIdentity -ProcessId $ProcessId -State (Read-BridgeState) -HealthBody (Get-BridgeHealth))
}

# Native port->PID lookup (netstat): ~10x faster than the Get-NetTCPConnection CIM class,
# which matters for the <2s steady-state budget. Falls back to the CIM helper if needed.
function Get-PortOwnerFast {
    try {
        $netstat = Join-Path "$env:WINDIR\System32" 'netstat.exe'
        $out = & $netstat -ano -p tcp 2>$null
        foreach ($line in $out) {
            if ($line -match ('TCP\s+\S*:' + $script:BridgePort + '\s+\S+\s+LISTENING\s+(\d+)')) {
                return [int]$Matches[1]
            }
        }
        return 0
    } catch {
        return -1
    }
}

# ---- 1) persistent intentional stop -------------------------------------------------
if (Test-Path -LiteralPath $script:StopFlagPath) {
    Complete-Ensure -Outcome 'skipped' -Reason 'stop_flag' -Action 'none'
    exit 0
}

# ---- 2) serialise concurrent triggers ------------------------------------------------
# The lock file is created atomically (CreateNew). A live lock means another ensurer is
# already doing the work: that run is allowed to finish and this one is a policy no-op
# (exit 0), reported as skipped/lock_busy with the lock owner's pid. A stale lock (owner
# gone, or older than LockStaleSeconds) is taken over here - same lock file, no second
# lock manager, no infinite wait.
function New-EnsureLockFile {
    param([Parameter(Mandatory)][string]$Path)
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $record = [ordered]@{ pid = $PID; started_at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($record)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    } finally {
        $stream.Dispose()
    }
}

function Get-EnsureLockInfo {
    param([Parameter(Mandatory)][string]$Path)
    $info = [ordered]@{ exists = (Test-Path -LiteralPath $Path); pid = 0; started_at = ''; age_seconds = -1; stale = $true }
    if (-not $info.exists) { return $info }
    $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $raw) { return $info }   # empty / unreadable lock counts as stale
    try {
        $lock = $raw | ConvertFrom-Json
        $info.pid = [int]$lock.pid
        $info.started_at = [string]$lock.started_at
        $ageSeconds = ((Get-Date).ToUniversalTime() - ([datetime]$lock.started_at).ToUniversalTime()).TotalSeconds
        $info.age_seconds = [int]$ageSeconds
        $ownerAlive = $false
        if ($info.pid) { $ownerAlive = [bool](Get-Process -Id ([int]$info.pid) -ErrorAction SilentlyContinue) }
        $info.stale = ($ageSeconds -gt $LockStaleSeconds) -or (-not $ownerAlive)
    } catch {
        $info.stale = $true
    }
    return $info
}

$lockAcquired = $false
try {
    for ($lockAttempt = 1; $lockAttempt -le 2 -and -not $lockAcquired; $lockAttempt++) {
        try {
            New-EnsureLockFile -Path $lockPath
            $lockAcquired = $true
        } catch [System.IO.IOException] {
            $lockInfo = Get-EnsureLockInfo -Path $lockPath
            if (-not $lockInfo.exists) { continue }   # holder released between open and read: retry
            if (-not $lockInfo.stale) {
                Complete-Ensure -Outcome 'skipped' -Reason 'lock_busy' -Action 'none' -OwnerPid ([int]$lockInfo.pid)
                exit 0
            }
            Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not $lockAcquired) {
        Complete-Ensure -Outcome 'skipped' -Reason 'lock_busy' -Action 'none'
        exit 0
    }

    # ---- 3) existing listener? ------------------------------------------------------
    $ownerPid = Get-PortOwnerFast
    if ($ownerPid -lt 0) { $ownerPid = Get-BridgePortOwner }
    if ($ownerPid -lt 0) {
        Complete-Ensure -Outcome 'skipped' -Reason 'port_query_unavailable' -Action 'none'
        exit 0
    }
    if ($ownerPid -gt 0) {
        $healthBody = Get-BridgeHealth
        $state = Read-BridgeState
        $procName = ''
        try { $procName = (Get-Process -Id $ownerPid -ErrorAction Stop).ProcessName } catch { $procName = '' }
        $recordMatches = ($state -and [int]$state.bridge_pid -eq $ownerPid -and
            ([string]$state.bridge_script -eq $script:BridgeScript) -and
            ([int]$state.port -eq $script:BridgePort))
        $hashMatches = $false
        if ($recordMatches -and $procName -eq 'node' -and $healthBody) {
            $liveHash = (Get-FileHash -LiteralPath $script:BridgeScript -Algorithm SHA256).Hash.ToLower()
            # Set-StrictMode is active (runtime-lib), so property access must be guarded:
            # the PowerShell-written state.json has no bridge_script_sha256 field.
            $recordedHash = $null
            $hashField = $state.PSObject.Properties['bridge_script_sha256']
            if ($hashField) { $recordedHash = [string]$hashField.Value }
            $hashMatches = (-not $recordedHash) -or ($recordedHash -eq $liveHash)
        }

        # FAST PATH: recorded by us, still the same node process, script unchanged, health ok
        # -> no CIM/cmdline round-trip needed (keeps the steady-state run under 2s).
        $verifiedListener = Test-BridgeListenerIdentity -ProcessId $ownerPid -State $state -HealthBody $healthBody
        if ($recordMatches -and $procName -eq 'node' -and $healthBody -and $hashMatches -and $verifiedListener) {
            Complete-Ensure -Outcome 'ok' -Reason 'bridge_healthy' -OwnerPid $ownerPid -HealthBody $healthBody
            exit 0
        }

        # SLOW PATH: full identity proof (node.exe + bridge.mjs command line) before touching anything.
        # When the command line is not readable (the process may run at a higher integrity level than
        # this ensurer - measured 2026-10-14), fall back to the recorded identity: same user, same
        # state record, same port. Anything less than that remains "foreign" and is left alone.
        $identity = Get-ProcessIdentity -ProcessId $ownerPid
        $isOurBridge = Test-BridgeListenerIdentity -ProcessId $ownerPid -State $state -HealthBody $healthBody
        $script:EnsureResult.parent_pid = (Get-ParentPid)
        if ($isOurBridge -and $healthBody) {
            $needsRepair = (-not $state) -or ([int]$state.bridge_pid -ne $ownerPid) -or
                ([string]$state.bridge_script -ne $script:BridgeScript) -or
                ([string]$state.status -ne 'bridge_ready')
            if ($needsRepair) {
                Set-Content -LiteralPath $script:BridgePidPath -Value $ownerPid -Encoding ASCII
                Write-BridgeState -SupervisorPid $null -BridgePid $ownerPid -NodePath (Resolve-BridgeNode) -Status 'bridge_ready'
                Write-LifecycleEvent -Event bridge_ready -BridgePid $ownerPid -Reason 'ensure_repaired_record' -Health $healthBody
                Complete-Ensure -Outcome 'repaired' -Reason 'record_mismatch' -OwnerPid $ownerPid -HealthBody $healthBody
            } else {
                Complete-Ensure -Outcome 'ok' -Reason 'bridge_healthy' -OwnerPid $ownerPid -HealthBody $healthBody
            }
            exit 0
        }
        if ($isOurBridge) {
            # Our listener is up but /health never answered -> wedged. Never restart from here;
            # wedged repair belongs to the health watch (two confirmed probes, then stop+start).
            Complete-Ensure -Outcome 'wedged' -Reason 'listener_up_no_health' -OwnerPid $ownerPid
            exit 0
        }
        Complete-Ensure -Outcome 'foreign' -Reason 'foreign_listener' -OwnerPid $ownerPid -HealthBody $healthBody
        exit 0
    }

    # ---- 4) start detached -----------------------------------------------------------
    $env:HTTPS_PROXY = $Proxy
    $env:HTTP_PROXY = $Proxy
    $env:NO_PROXY = '127.0.0.1,localhost,api.deepseek.com'
    $node = Resolve-BridgeNode

    # bridge.mjs refuses to start when its ChatGPT-upstream proxy is unreachable, so wait
    # (bounded) for the proxy instead of burning a failed start; the next run retries.
    if ($Proxy -and -not $SkipProxyCheck) {
        $proxyDeadline = (Get-Date).AddSeconds($ProxyReadyTimeoutSeconds)
        while (-not (Test-ProxyReady -Proxy $Proxy) -and (Get-Date) -lt $proxyDeadline) {
            Write-LifecycleEvent -Event proxy_wait -Reason 'proxy_not_ready_wait_5s' -Health ''
            Start-Sleep -Seconds 5
        }
        if (-not (Test-ProxyReady -Proxy $Proxy)) {
            Complete-Ensure -Outcome 'skipped' -Reason 'proxy_not_ready' -Action 'none'
            exit 0
        }
    }

    # -WindowStyle Hidden keeps this fully invisible; the bridge itself logs to logs\bridge.jsonl,
    # so no stdout/stderr redirection is needed (and plain shell-exec spawn keeps the child outside
    # the Task Scheduler instance/job, which is what makes the bridge survive independently).
    $proc = Start-Process -FilePath $node `
        -ArgumentList ('"' + $script:BridgeScript + '"') `
        -WorkingDirectory $script:BridgeRoot `
        -WindowStyle Hidden -PassThru

    Write-LifecycleEvent -Event bridge_start -BridgePid $proc.Id -Reason 'ensure_started' -Health ''

    $deadline = (Get-Date).AddSeconds($BridgeReadyTimeoutSeconds)
    $ready = $false
    $portOwner = 0
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { break }
        $healthBody = Get-BridgeHealth
        $portOwner = Get-BridgePortOwner
        if ($healthBody -and $portOwner -eq $proc.Id) { $ready = $true; break }
        if ($healthBody -and $portOwner -gt 0 -and $portOwner -ne $proc.Id) { break }  # another instance won the port
        Start-Sleep -Milliseconds 700
    }

    if ($ready) {
        Set-Content -LiteralPath $script:BridgePidPath -Value $proc.Id -Encoding ASCII
        Write-BridgeState -SupervisorPid $null -BridgePid $proc.Id -NodePath $node -Status 'bridge_ready'
        Write-LifecycleEvent -Event bridge_ready -BridgePid $proc.Id -Reason 'ensure_health_200' -Health (Get-BridgeHealth)
        Complete-Ensure -Outcome 'ok' -Reason 'bridge_started' -Action 'started' -OwnerPid $proc.Id -HealthBody (Get-BridgeHealth)
        exit 0
    }

    # race: someone else won the port while we were starting -> adopt it if it is ours
    $portOwner = Get-BridgePortOwner
    if ($portOwner -gt 0 -and (Test-OurBridgeListener -ProcessId $portOwner) -and (Get-BridgeHealth)) {
        Set-Content -LiteralPath $script:BridgePidPath -Value $portOwner -Encoding ASCII
        Write-BridgeState -SupervisorPid $null -BridgePid $portOwner -NodePath $node -Status 'bridge_ready'
        Write-LifecycleEvent -Event bridge_ready -BridgePid $portOwner -Reason 'ensure_adopted_race_winner' -Health (Get-BridgeHealth)
        Complete-Ensure -Outcome 'ok' -Reason 'adopted_race_winner' -Action 'adopted' -OwnerPid $portOwner -HealthBody (Get-BridgeHealth)
        exit 0
    }

    # Failed to come up: record WHY (process exit code / no health while alive / foreign port
    # owner), so the health watch and start-production.ps1 never have to guess and never report
    # a false success.
    try { if (-not $proc.HasExited) { [void]$proc.WaitForExit(3000) } } catch { }
    $procExited = $false
    $procExitCode = $null
    try {
        $procExited = [bool]$proc.HasExited
        if ($procExited) { $procExitCode = [int]$proc.ExitCode }
    } catch { }
    $failureReason = if ($procExited) { 'process_exit_' + ([string]$procExitCode) } elseif ($portOwner -gt 0) { 'port_taken_by_foreign' } else { 'health_timeout' }
    Write-LifecycleEvent -Event bridge_exit -BridgePid $proc.Id -Reason ('ensure_start_failed:' + $failureReason) -Health ''
    Complete-Ensure -Outcome 'failed' -Reason $failureReason -Action 'started' -OwnerPid $portOwner
    exit 2
} finally {
    if ($lockAcquired -and (Test-Path -LiteralPath $lockPath)) {
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
}
