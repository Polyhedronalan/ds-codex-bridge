<#
  tools/bridge-health.ps1 - deterministic, LLM-free health probe for the local Codex Bridge.

  Why this file exists
    The production ensurer (bridge\ensure-bridge.ps1, driven by Task Scheduler
    \CodexBridgeSupervisor: Desktop activation event + PT5M keep-alive) already keeps the
    Bridge alive, but it is silent in BOTH directions. Four real conditions ended up only in
    runtime\ensure-last.json, where nobody looks:
      * wedge            - port 8799 has our own listener but /health never answers
      * start_timeout    - the ensurer could not bring the Bridge up (exit 2)
      * proxy_not_ready  - the local proxy is down, so the Bridge is deliberately not started
      * recovery broken  - the scheduled task that performs recovery is gone or the ensurer
                           has not run for hours

  This is the read side. It never starts, stops or configures anything unless -Repair or
  -Watch is passed, and even then it only ever touches a process it can prove is our own
  bridge.mjs (recorded pid + node.exe + bridge.mjs command line + port owner), by calling the
  existing stop-production.ps1 / start-production.ps1 code paths in a child process.

  Modes
    (default)   probe, write runtime\health-last.json, print one JSON line, exit 0/2
    -Report     probe and print a readable Chinese report
    -Repair     probe, repair once if needed, re-probe, print the result   (human one-click)
    -Watch      silent scheduled mode: probe, repair once, raise/clear alerts, no stdout

  Alerting (only while something is actually wrong)
    runtime\health-last.json          - last probe, always overwritten
    runtime\health-alert.current.json - present only while an alert is active
    logs\health-alerts.jsonl          - append-only alert/repair/cleared history
    <mirror>\<MACHINE>\*.json         - mirror in the explicitly configured mirror directory so the state is
                                        visible from the laptop (skipped silently if absent)
    Windows balloon notification      - best effort, never fatal

  Exit codes
    0 = healthy, or intentionally stopped (runtime\stop.flag present)
    2 = a real problem remains: down / wedged / foreign / degraded (or a repair was
        performed and something is still wrong). "degraded" = the bridge serves the
        ChatGPT path but the DeepSeek credential is missing; restarting cannot fix it.
    1 = the probe itself failed
#>
[CmdletBinding()]
param(
    [switch]$Report,
    [switch]$Repair,
    [switch]$Watch,
    [switch]$NoNotify,
    [string]$Proxy = $env:HTTPS_PROXY,
    [int]$WedgeConfirmProbes = 2,
    [int]$AlertRepeatMinutes = 30,
    [int]$EnsurerStaleMinutes = 20,
    [int]$EnsurerDeadMinutes = 60,
    [int]$LogWindowMinutes = 90,
    [int]$LogTailLines = 1500,
    [string]$ConfigPath = '',
    [string]$MirrorRoot = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\runtime-lib.ps1')
. (Join-Path $PSScriptRoot 'repair-policy.ps1')
Initialize-BridgeRuntime

$healthPath     = Join-Path $script:RuntimeDir 'health-last.json'
$currentPath    = Join-Path $script:RuntimeDir 'health-alert.current.json'
$alertLogPath   = Join-Path $script:LogDir 'health-alerts.jsonl'
$ensureLastPath = Join-Path $script:RuntimeDir 'ensure-last.json'
$recoveryTask   = $script:TaskName          # CodexBridgeSupervisor
$machine        = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { 'unknown-host' }

# Mirroring is opt-in through -MirrorRoot.
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $env:USERPROFILE '.codex\config.toml'
}

# Infrastructure failures in the Bridge request log that mean "a client request really failed".
# BRIDGE_CLIENT_CANCELLED and BRIDGE_UNKNOWN_MODEL are deliberately NOT in this set: the first is
# the client walking away (often just a stopped generation), the second is a model name the
# caller asked for. Both are counted and reported as notes instead of alarms.
$script:LogFailureCodes = @(
    'BRIDGE_UPSTREAM_UNAVAILABLE',
    'BRIDGE_UPSTREAM_TIMEOUT',
    'BRIDGE_UPSTREAM_ERROR',
    'BRIDGE_PROXY_UNAVAILABLE',
    'BRIDGE_UPSTREAM_RATE_LIMITED',
    'BRIDGE_DEEPSEEK_AUTH_FAILED',
    'BRIDGE_CHATGPT_AUTH_FAILED',
    'BRIDGE_PAYLOAD_INCOMPATIBLE',
    'BRIDGE_AUTH_FAILED',
    'BRIDGE_BUSY',
    'BRIDGE_REQUEST_TOO_LARGE',
    'BRIDGE_DEEPSEEK_KEY_MISSING'
)

# ---------------------------------------------------------------- small helpers

function Get-Field {
    param($Object, [string]$Name)
    if (-not $Object) { return $null }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json) } catch { return $null }
}

function Get-PortOwner {
    # 0 = no listener, >0 = owning pid, -1 = the lookup itself failed (do not cry wolf)
    param([int]$Port = $script:BridgePort)
    try {
        $netstat = Join-Path "$env:WINDIR\System32" 'netstat.exe'
        $lines = @(& $netstat -ano -p tcp 2>$null)
        if ($lines.Count -eq 0) { return -1 }
        foreach ($line in $lines) {
            if ($line -match ('TCP\s+\S*:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)')) { return [int]$Matches[1] }
        }
        return 0
    } catch {
        return -1
    }
}

function Get-RecoveryTaskState {
    try {
        $task = Get-ScheduledTask -TaskName $recoveryTask -ErrorAction Stop
        if (-not $task) { return 'missing' }
        if ([string]$task.State -eq 'Disabled') { return 'disabled' }
        return 'ok'
    } catch {
        if ($_.FullyQualifiedErrorId -match 'ObjectNotFound') { return 'missing' }
        return 'unknown'
    }
}

function Send-BridgeBalloon {
    param([string]$Title, [string]$Text)
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $icon = New-Object System.Windows.Forms.NotifyIcon
        $icon.Icon = [System.Drawing.SystemIcons]::Warning
        $icon.BalloonTipTitle = $Title
        $icon.BalloonTipText = $Text
        $icon.Visible = $true
        $icon.ShowBalloonTip(10000)
        $deadline = (Get-Date).AddSeconds(7)
        while ((Get-Date) -lt $deadline) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 200
        }
        $icon.Visible = $false
        $icon.Dispose()
        return $true
    } catch {
        return $false
    }
}

function Write-JsonFile {
    param([string]$Path, $Object)
    try {
        $dir = Split-Path -Parent $Path
        if ($dir) { [void](New-Item -ItemType Directory -Path $dir -Force) }
        $tmp = "$Path.tmp"
        ($Object | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $Path -Force
        return $true
    } catch {
        return $false
    }
}

function Write-AlertRecord {
    param($Record)
    try {
        $line = $Record | ConvertTo-Json -Compress -Depth 6
        Invoke-LogRotation -Path $alertLogPath -IncomingBytes ([Text.Encoding]::UTF8.GetByteCount($line + "`r`n")) | Out-Null
        Add-Content -LiteralPath $alertLogPath -Value $line -Encoding UTF8
    } catch {
    }
}

function Write-Mirror {
    param($Status, $Alert)
    if ([string]::IsNullOrWhiteSpace($MirrorRoot)) { return }
    try {
        $machineDir = Join-Path $MirrorRoot $machine
        [void](New-Item -ItemType Directory -Path $machineDir -Force)
        Write-JsonFile -Path (Join-Path $machineDir 'last-status.json') -Object $Status | Out-Null
        $alertFile = Join-Path $machineDir 'current-alert.json'
        if ($Alert) {
            Write-JsonFile -Path $alertFile -Object $Alert | Out-Null
        } elseif (Test-Path -LiteralPath $alertFile) {
            Remove-Item -LiteralPath $alertFile -Force -ErrorAction SilentlyContinue
        }
    } catch {
    }
}

# ---------------------------------------------------------------- the probe

function Get-BridgeLogWindowStats {
    # Reads the tail of the Bridge request log and counts what actually failed inside the window.
    # The log is allowlisted JSONL (no prompts, no credentials), so this stays a metadata read.
    param([int]$Minutes, [int]$TailLines)
    $stats = [ordered]@{
        records          = 0
        window_start     = ''
        last_ts          = ''
        client_cancelled = 0
        unknown_model    = 0
        failures         = [ordered]@{}
        active_failures  = [ordered]@{}
        recovered_failures = [ordered]@{}
        failure_details  = @()
    }
    $routes = @{}
    $groups = [ordered]@{}
    # Only transport, capacity and billing failures can be cleared by later traffic.
    # Payload/auth/local errors can affect one caller even while another caller succeeds.
    $recoverableCodes = @('BRIDGE_UPSTREAM_ERROR', 'BRIDGE_UPSTREAM_UNAVAILABLE',
        'BRIDGE_UPSTREAM_TIMEOUT', 'BRIDGE_PROXY_UNAVAILABLE', 'BRIDGE_UPSTREAM_RATE_LIMITED')
    try {
        $logPath = Join-Path $script:LogDir 'bridge.jsonl'
        if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) { return $stats }
        $cut = (Get-Date).ToUniversalTime().AddMinutes(-1 * [Math]::Abs($Minutes))
        $stats.window_start = $cut.ToString('o')
        foreach ($line in @(Get-Content -LiteralPath $logPath -Tail $TailLines)) {
            if (-not $line) { continue }
            $o = $null
            try { $o = $line | ConvertFrom-Json } catch { continue }
            $tsRaw = Get-Field $o 'ts'
            if (-not $tsRaw) { continue }
            $when = $null
            try { $when = ([datetime]$tsRaw).ToUniversalTime() } catch { continue }
            if ($when -lt $cut) { continue }
            $stats.records = $stats.records + 1
            if ($when.ToString('o') -gt $stats.last_ts) { $stats.last_ts = $when.ToString('o') }
            # request_shape carries the HTTP headers status before the response completes.
            # It is not evidence of a successful request (nor is /health).
            if (Get-Field $o 'event') { continue }
            $upstream = [string](Get-Field $o 'upstream')
            $model = [string](Get-Field $o 'model')
            $status = 0
            [void][int]::TryParse([string](Get-Field $o 'status'), [ref]$status)
            $routeKey = $upstream + '|' + $model
            if (-not $routes.ContainsKey($routeKey)) {
                $routes[$routeKey] = @{ last_failure = [datetime]::MinValue; successes = @() }
            }
            $route = $routes[$routeKey]
            $code = [string](Get-Field $o 'error_code')
            if (-not $code) {
                if ($status -eq 200 -and $upstream -and $model) { $route.successes += $when }
                continue
            }
            if ($code -eq 'BRIDGE_CLIENT_CANCELLED') { $stats.client_cancelled = $stats.client_cancelled + 1; continue }
            if ($code -eq 'BRIDGE_UNKNOWN_MODEL') { $stats.unknown_model = $stats.unknown_model + 1; continue }
            if ($script:LogFailureCodes -contains $code) {
                if ($stats.failures.Contains($code)) { $stats.failures[$code] = $stats.failures[$code] + 1 }
                else { $stats.failures[$code] = 1 }
                if ($when -gt $route.last_failure) { $route.last_failure = $when }
                $groupKey = $routeKey + '|' + $code + '|' + $status
                if (-not $groups.Contains($groupKey)) {
                    $groups[$groupKey] = [ordered]@{
                        code = $code; upstream = $upstream; model = $model; status = $status
                        count = 0; last_failure_ts = ''; recovery_successes = 0; recovered = $false
                    }
                }
                $group = $groups[$groupKey]
                $group.count += 1
                if ($when.ToString('o') -gt $group.last_failure_ts) { $group.last_failure_ts = $when.ToString('o') }
            }
        }
        foreach ($group in $groups.Values) {
            $route = $routes[$group.upstream + '|' + $group.model]
            $group.recovery_successes = @($route.successes | Where-Object { $_ -gt $route.last_failure }).Count
            $group.recovered = [bool]($group.upstream -and $group.model -and
                $group.code -in $recoverableCodes -and $group.recovery_successes -ge 3 -and
                ($group.code -ne 'BRIDGE_UPSTREAM_ERROR' -or $group.status -eq 402 -or $group.status -ge 500))
            $target = if ($group.recovered) { $stats.recovered_failures } else { $stats.active_failures }
            if ($target.Contains($group.code)) { $target[$group.code] += $group.count }
            else { $target[$group.code] = $group.count }
            $stats.failure_details += $group
        }
    } catch {
    }
    return $stats
}

function Get-ConfigSanity {
    # Read-only structural check of the Codex config. It never reads or prints a key value: it only
    # looks at section headers and at how many bridge_key lines sit inside each section.
    #
    # Calibrated 2026-10-08 on ALAN: config.toml legitimately carries THREE bridge_key lines, one
    # each in [model_providers.bridge.query_params], [model_providers.bridge-deepseek.query_params]
    # and [model_providers.deepseek.query_params]. Only a duplicate INSIDE one section is a defect
    # (that is what "duplicate key" broke on 2026-10-08), and an unclosed [table header is the other
    # real signature ("unclosed table, expected ]").
    param([string]$Path)
    $r = [ordered]@{
        exists               = $false
        path                 = $Path
        bridge_section       = $false
        key_line_count       = 0
        duplicate_sections   = @()
        unclosed_table_lines = @()
    }
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $r }
        $r.exists = $true
        $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8)
        $section = '(top)'
        $seen = @{}
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $t = ([string]$lines[$i]).Trim()
            if ($t.StartsWith('[') -and -not $t.Contains(']')) { $r.unclosed_table_lines += ($i + 1) }
            if ($t -match '^\[([^\]]+)\]') {
                $section = $Matches[1]
                if ($section -match '^model_providers\.bridge(\.|$)') { $r.bridge_section = $true }
                continue
            }
            if ($t -match '^bridge_key\s*=') {
                $r.key_line_count = $r.key_line_count + 1
                if ($seen.ContainsKey($section)) { $r.duplicate_sections += $section } else { $seen[$section] = $true }
            }
        }
    } catch {
    }
    return $r
}

function Get-BridgeProbe {
    $p = [ordered]@{
        probed_at           = (Get-Date).ToUniversalTime().ToString('o')
        machine             = $machine
        status              = 'unknown'
        problems            = @()
        notes               = @()
        port                = $script:BridgePort
        port_query          = 'ok'
        port_owner_pid      = 0
        identity            = 'unknown'
        health_ok           = $false
        health              = ''
        state_pid           = 0
        state_status        = ''
        state_matches_live  = $false
        stop_flag           = $false
        recovery_task       = 'unknown'
        ensurer_age_seconds = -1
        ensurer_outcome     = ''
        ensurer_reason      = ''
        console_hwnd        = 0
        log_window_minutes  = 0
        log_records         = 0
        log_last_ts         = ''
        log_client_cancelled = 0
        log_unknown_model   = 0
        log_failures        = [ordered]@{}
        log_active_failures = [ordered]@{}
        log_recovered_failures = [ordered]@{}
        log_failure_details = @()
        config_exists       = $false
        config_bridge_section = $false
        config_key_lines    = 0
        config_duplicate_sections = @()
        config_unclosed_lines = @()
    }

    try {
        # Visibility self-check (same trick as ensure-bridge.ps1): the scheduled probe must not
        # own a console window, so a hidden run proves itself here instead of needing a watcher.
        try { $p.console_hwnd = [int64](Get-Process -Id $PID -ErrorAction Stop).MainWindowHandle } catch { }

        $p.stop_flag = [bool](Test-Path -LiteralPath $script:StopFlagPath)

        # 1) end-to-end truth: /health
        $healthBody = Get-BridgeHealth -TimeoutSec 3
        $p.health = $healthBody
        $healthFingerprintOk = $false   # status=ok + local_auth=configured (the bridge itself)
        $healthDeepseekOk = $false      # deepseek credential loaded (provider-level)
        if ($healthBody) {
            try {
                $h = $healthBody | ConvertFrom-Json
                $healthFingerprintOk = ([string](Get-Field $h 'status') -eq 'ok' -and
                    ([string](Get-Field $h 'local_auth') -eq 'configured'))
                $healthDeepseekOk = [bool](Get-Field $h 'deepseek_configured')
                $p.health_ok = ($healthFingerprintOk -and $healthDeepseekOk)
                if (-not [bool](Get-Field $h 'proxy_configured')) { $p.notes += 'health_reports_no_proxy' }
            } catch {
                $p.notes += 'health_body_unparsable'
            }
        }

        # 2) recorded state (read before the identity check: it is the fallback proof when the
        #    bridge runs at a higher integrity level and its command line is unreadable)
        $state = Read-BridgeState
        if ($state) {
            $p.state_pid = [int](Get-Field $state 'bridge_pid')
            $p.state_status = [string](Get-Field $state 'status')
        }

        # 3) listener + process identity
        $owner = Get-PortOwner
        if ($owner -lt 0) { $p.port_query = 'unavailable' }
        $p.port_owner_pid = [int]([Math]::Max(0, $owner))
        if ($owner -gt 0) {
            $ident = Get-ProcessIdentity -ProcessId $owner
            if ($ident -and [string]$ident.name -ne 'node.exe') {
                $p.identity = 'not_node'
                $p.notes += ('port_owner_name=' + [string]$ident.name)
            } elseif (Test-BridgeListenerIdentity -ProcessId $owner -State $state -HealthBody $healthBody) {
                $p.identity = 'our_bridge'
            } elseif ($ident -and $ident.command_line) {
                $p.identity = 'node_other_script'
            } else {
                $p.identity = 'node_unverifiable'
            }
        } elseif ($owner -eq 0) {
            $p.identity = 'none'
        }
        if ($state) {
            $p.state_matches_live = ($p.state_pid -gt 0 -and $p.state_pid -eq $p.port_owner_pid)
        }

        # 4) the recovery path itself
        $p.recovery_task = Get-RecoveryTaskState

        # 5) last ensurer run
        $ensure = Read-JsonFile -Path $ensureLastPath
        if ($ensure) {
            $p.ensurer_outcome = [string](Get-Field $ensure 'outcome')
            $p.ensurer_reason = [string](Get-Field $ensure 'reason')
            $startedAt = Get-Field $ensure 'started_at'
            if ($startedAt) {
                try {
                    $p.ensurer_age_seconds = [int]((Get-Date).ToUniversalTime() - ([datetime]$startedAt).ToUniversalTime()).TotalSeconds
                } catch { }
            }
        }

        # ---- classify ----------------------------------------------------------
        if ($p.stop_flag) {
            $p.status = 'stopped'
            $p.notes += 'intentional_stop_flag_present'
        } elseif ($p.identity -eq 'our_bridge') {
            if ($healthFingerprintOk) {
                if (-not $healthDeepseekOk) {
                    # Provider isolation: the bridge itself is up and serving the ChatGPT path;
                    # only the deepseek branch has no credential. A restart cannot fix this.
                    $p.status = 'degraded'
                    $p.problems += 'deepseek_not_configured_degraded'
                } else {
                    $p.status = 'healthy'
                }
                if (-not $p.state_matches_live) {
                    # The ensurer rewrites a stale record on its own fast/slow path and runs every
                    # 5 minutes, so a mismatch that outlives a full cycle means the recovery path is
                    # not doing its job. That is worth reporting; anything younger is just a note.
                    $ensurerHadChance = ($p.recovery_task -eq 'ok' -and $p.ensurer_age_seconds -ge 0 -and
                        $p.ensurer_age_seconds -le ($EnsurerStaleMinutes * 60))
                    if ($ensurerHadChance) { $p.notes += 'state_record_mismatch_ensurer_will_repair' }
                    else { $p.problems += 'state_record_stale_unrepaired' }
                }
            } else {
                $p.status = 'wedged'
                $p.problems += 'bridge_wedged_no_health'
            }
        } elseif ($p.port_owner_pid -gt 0) {
            $p.status = 'foreign'
            $p.problems += 'foreign_listener_on_8799'
        } elseif ($p.health_ok) {
            # listener lookup failed but the service answers: trust the service
            $p.status = 'healthy'
            $p.notes += 'port_query_unavailable'
        } else {
            $p.status = 'down'
            $p.problems += 'bridge_not_reachable'
        }

        if ($p.status -ne 'stopped') {
            switch ($p.recovery_task) {
                'missing' { $p.problems += 'recovery_task_missing' }
                'disabled' { $p.problems += 'recovery_task_disabled' }
                'unknown' { $p.notes += 'recovery_task_query_unavailable' }
            }
            if ($p.ensurer_age_seconds -ge 0) {
                if ($p.ensurer_age_seconds -gt ($EnsurerDeadMinutes * 60)) {
                    $p.problems += 'ensurer_not_running'
                } elseif ($p.ensurer_age_seconds -gt ($EnsurerStaleMinutes * 60)) {
                    if ($p.status -eq 'healthy') { $p.notes += 'ensurer_stale_but_bridge_healthy' }
                    else { $p.problems += 'ensurer_stale' }
                }
            }
            if ($p.ensurer_reason -eq 'proxy_not_ready' -or $p.ensurer_reason -eq 'proxy_not_ready_wait_5s') {
                $p.problems += 'proxy_not_ready_so_bridge_not_started'
            }
            switch ($p.ensurer_outcome) {
                'failed'  { $p.problems += ('ensurer_last_run_failed:' + $p.ensurer_reason) }
                'foreign' { $p.problems += 'ensurer_saw_foreign_listener' }
                'pending' { $p.problems += 'ensurer_last_run_incomplete' }
            }
        }

        # 6) what the Bridge's own request log says about the recent window
        $logStats = Get-BridgeLogWindowStats -Minutes $LogWindowMinutes -TailLines $LogTailLines
        $p.log_window_minutes = $LogWindowMinutes
        $p.log_records = $logStats.records
        $p.log_last_ts = $logStats.last_ts
        $p.log_client_cancelled = $logStats.client_cancelled
        $p.log_unknown_model = $logStats.unknown_model
        foreach ($code in $logStats.failures.Keys) { $p.log_failures[$code] = $logStats.failures[$code] }
        $p.log_active_failures = $logStats.active_failures
        $p.log_recovered_failures = $logStats.recovered_failures
        $p.log_failure_details = @($logStats.failure_details)
        foreach ($code in $logStats.recovered_failures.Keys) {
            $p.notes += ('recovered_' + ([string]$code).ToLower() + '_x' + $logStats.recovered_failures[$code])
        }
        if ($p.status -ne 'stopped') {
            foreach ($code in $logStats.active_failures.Keys) {
                $p.problems += ('recent_' + ([string]$code).ToLower() + '_x' + $logStats.active_failures[$code])
            }
        }

        # 7) Codex config structural sanity (read-only, no key values)
        $cfg = Get-ConfigSanity -Path $ConfigPath
        $p.config_exists = $cfg.exists
        $p.config_bridge_section = $cfg.bridge_section
        $p.config_key_lines = $cfg.key_line_count
        $p.config_duplicate_sections = @($cfg.duplicate_sections | Select-Object -Unique)
        $p.config_unclosed_lines = @($cfg.unclosed_table_lines)
        if ($cfg.exists) {
            if (@($p.config_duplicate_sections).Count -gt 0) {
                $p.problems += ('config_duplicate_key_in_section:' + (@($p.config_duplicate_sections) -join '|'))
            }
            if (@($p.config_unclosed_lines).Count -gt 0) {
                $p.problems += ('config_unclosed_table_lines:' + (@($p.config_unclosed_lines) -join ','))
            }
            if (-not $cfg.bridge_section) { $p.problems += 'config_bridge_provider_missing' }
        } else {
            $p.notes += 'config_toml_not_found'
        }
    } catch {
        $p.status = 'unknown'
        $p.problems += ('probe_error:' + $_.Exception.Message)
    }

    return $p
}

# ---------------------------------------------------------------- repair

function Invoke-BridgeLifecycleStep {
    param([string]$Path, [string]$ProxyAddress = '', [switch]$Start)
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ($Start) { & $ps -NoProfile -ExecutionPolicy Bypass -File $Path -Proxy $ProxyAddress -Quiet *> $null }
    else { & $ps -NoProfile -ExecutionPolicy Bypass -File $Path *> $null }
    return [int]$LASTEXITCODE
}

function Invoke-BridgeRepair {
    param([string]$Status, [string]$ProxyAddress)
    $stopScript = Join-Path $script:BridgeRoot 'stop-production.ps1'
    $startScript = Join-Path $script:BridgeRoot 'start-production.ps1'
    $actions = @()

    if ($Status -eq 'foreign') {
        # A foreign process owns 8799. Starting a second Bridge is never correct and stopping a
        # process that is not provably ours is never allowed: report, do not touch.
        return @{ outcome = 'refused_foreign_listener'; actions = @('none:port_owned_by_foreign_process') }
    }
    if ($Status -eq 'degraded') {
        # Provider isolation: restarting cannot create a missing credential. Report only.
        return @{ outcome = 'refused_degraded_provider'; actions = @('none:deepseek_credential_missing') }
    }
    if ($Status -eq 'stopped') {
        return @{ outcome = 'skipped_intentional_stop'; actions = @('none:stop_flag_present') }
    }
    if ($Status -notin @('down', 'wedged', 'auth')) {
        return @{ outcome = 'refused_unknown_or_healthy_state'; actions = @('none:local_restart_not_indicated') }
    }

    if (($Status -eq 'wedged' -or $Status -eq 'auth') -and (Test-Path -LiteralPath $stopScript)) {
        # stop-production.ps1 re-verifies the identity itself and refuses unknown pids.
        $stepExit = Invoke-BridgeLifecycleStep -Path $stopScript
        $actions += ('stop-production.ps1 exit=' + $stepExit)
        if ($stepExit -ne 0) {
            return @{ outcome = 'local_stop_failed'; actions = $actions }
        }
        Start-Sleep -Seconds 2
    } elseif ($Status -eq 'wedged' -or $Status -eq 'auth') {
        return @{ outcome = 'local_stop_missing'; actions = @('stop-production.ps1 missing') }
    }

    if (Test-Path -LiteralPath $startScript) {
        $stepExit = Invoke-BridgeLifecycleStep -Path $startScript -ProxyAddress $ProxyAddress -Start
        $actions += ('start-production.ps1 exit=' + $stepExit)
        if ($stepExit -ne 0) {
            return @{ outcome = 'local_start_failed'; actions = $actions }
        }
    } else {
        $actions += 'start-production.ps1 missing'
        return @{ outcome = 'local_start_missing'; actions = $actions }
    }

    return @{ outcome = 'repair_attempted'; actions = $actions }
}

# ---------------------------------------------------------------- main

$probe = Get-BridgeProbe
$action = $null
$previous = Read-JsonFile -Path $healthPath
$wedgeStreak = 0
if ($previous -and [int](Get-Field $previous 'port_owner_pid') -eq [int]$probe.port_owner_pid) {
    $prevStreak = Get-Field $previous 'wedge_streak'
    if ($prevStreak) { $wedgeStreak = [int]$prevStreak }
}
$wedgeStreak = if ($probe.status -eq 'wedged') { $wedgeStreak + 1 } else { 0 }

if ($Watch -or $Repair) {
    if ($Repair -and -not $Watch -and $probe.status -eq 'wedged') {
        # A human click confirms consecutive probes now; it does not require another click/hour.
        $confirmed = Confirm-BridgeManualWedge -Probe $probe -ConfirmProbes $WedgeConfirmProbes
        $probe = $confirmed.probe
        $wedgeStreak = $confirmed.streak
    }
    $plan = Get-BridgeRepairPlan -Probe $probe -Manual ([bool]($Repair -and -not $Watch)) -WedgeStreak $wedgeStreak -ConfirmProbes $WedgeConfirmProbes
    if ($plan.repair) {
        $action = Invoke-BridgeRepair -Status $plan.status -ProxyAddress $Proxy
        $probe = Get-BridgeProbe
        $wedgeStreak = if ($probe.status -eq 'wedged') { 2 } else { 0 }
    } elseif ($Repair) {
        $action = @{ outcome = $plan.outcome; actions = @('none:no_local_restart_required_or_safe') }
    }
}

$repairActions = New-Object System.Collections.ArrayList
$repairOutcome = ''
if ($action) {
    $repairOutcome = Get-BridgeLocalRepairOutcome -AttemptOutcome ([string]$action.outcome) -Probe $probe
    foreach ($a in @($action.actions)) { [void]$repairActions.Add([string]$a) }
}
$probe['wedge_streak'] = $wedgeStreak
$probe['repaired'] = [bool]($repairOutcome -eq 'local_recovery_verified')
$probe['repair_attempted'] = [bool]($action -and $action.outcome -in @('repair_attempted', 'local_stop_failed', 'local_start_failed'))
$probe['repair_actions'] = @($repairActions.ToArray())
$probe['repair_outcome'] = $repairOutcome
$probe['repair_guidance'] = Get-BridgeRepairGuidance -Probe $probe
$probe['transport_checks'] = @()
# Explicit manual diagnostics only; never poll an upstream on the scheduled Watch path.
# This sends HEAD without API keys/OAuth or model requests. Any HTTP response proves TLS only.
if ($Repair -and -not $Watch -and $probe.status -eq 'healthy') {
    $routes = @($probe.log_failure_details | Where-Object {
        -not $_.recovered -and $_.upstream -in @('chatgpt', 'deepseek') -and
        $_.code -in @('BRIDGE_UPSTREAM_UNAVAILABLE', 'BRIDGE_PROXY_UNAVAILABLE', 'BRIDGE_UPSTREAM_TIMEOUT')
    } | ForEach-Object { $_.upstream } | Select-Object -Unique)
    foreach ($route in $routes) {
        $originalHttpsProxy = $env:HTTPS_PROXY
        try {
            $node = Resolve-BridgeNode
            # Match the proxy argument that this entrypoint passes to start-production.
            $env:HTTPS_PROXY = $Proxy
            $transportOutput = & $node (Join-Path $PSScriptRoot 'test-transport.mjs') $route 2>$null
            $transportResult = $transportOutput | ConvertFrom-Json
            $probe['transport_checks'] += $transportResult
        } catch {
            $probe['transport_checks'] += @{ upstream = $route; scope = 'transport_only'; reason = 'probe_unavailable'; transport_reachable = $false }
        } finally {
            $env:HTTPS_PROXY = $originalHttpsProxy
        }
    }
}

Write-JsonFile -Path $healthPath -Object $probe | Out-Null

# ---- alert bookkeeping -------------------------------------------------------

$previousAlert = Read-JsonFile -Path $currentPath
$isProblem = ($probe.status -notin @('healthy', 'stopped')) -or (@($probe.problems).Count -gt 0)
$repairedNow = [bool]$probe.repaired

if ($isProblem) {
    $reason = (@($probe.problems) -join ',')
    if (-not $reason -and $probe.status -ne 'healthy') { $reason = $probe.status }
    $nowUtc = (Get-Date).ToUniversalTime()
    $firstSeen = $nowUtc.ToString('o')
    $count = 1
    if ($previousAlert -and [string](Get-Field $previousAlert 'reason') -eq $reason) {
        $firstSeen = [string](Get-Field $previousAlert 'first_seen')
        $count = [int](Get-Field $previousAlert 'count') + 1
    }
    $billingProblem = @($probe.log_failure_details | Where-Object { $_.status -eq 402 -and -not $_.recovered }).Count -gt 0
    $helpText = [string]$probe.repair_guidance
    $alert = [ordered]@{
        active          = $true
        machine         = $machine
        reason          = $reason
        status          = $probe.status
        problems        = @($probe.problems)
        notes           = @($probe.notes)
        first_seen      = $firstSeen
        last_seen       = $nowUtc.ToString('o')
        count           = $count
        port_owner_pid  = $probe.port_owner_pid
        identity        = $probe.identity
        state_pid       = $probe.state_pid
        recovery_task   = $probe.recovery_task
        ensurer_outcome = $probe.ensurer_outcome
        ensurer_reason  = $probe.ensurer_reason
        repair_outcome  = [string]$probe.repair_outcome
        repair_actions  = @($probe.repair_actions)
        help            = $helpText
    }
    Write-JsonFile -Path $currentPath -Object $alert | Out-Null

    $shouldNotify = $true
    if ($previousAlert -and [string](Get-Field $previousAlert 'reason') -eq $reason) {
        $lastNotified = Get-Field $previousAlert 'last_notified'
        if ($lastNotified) {
            try {
                $ageMinutes = ($nowUtc - ([datetime]$lastNotified).ToUniversalTime()).TotalMinutes
                if ($ageMinutes -lt $AlertRepeatMinutes -and -not $repairedNow) { $shouldNotify = $false }
            } catch { }
        }
        if ($repairedNow) { $shouldNotify = $true }
    }

    if ($shouldNotify) {
        $notified = $false
        if (-not $NoNotify) {
            $notifyHint = $helpText
            $notified = Send-BridgeBalloon -Title 'Codex Bridge 异常' -Text ($probe.status + ' | ' + $reason + ' | ' + $notifyHint)
        }
        $alert['last_notified'] = $nowUtc.ToString('o')
        Write-JsonFile -Path $currentPath -Object $alert | Out-Null
        Write-AlertRecord -Record ([ordered]@{
            ts = $nowUtc.ToString('o'); event = if ($probe.repair_attempted) { 'local-repair-result-problem-remains' } else { 'alert' }
            machine = $machine; status = $probe.status; reason = $reason; count = $count
            owner_pid = $probe.port_owner_pid; identity = $probe.identity
            repair_outcome = [string]$probe.repair_outcome; repair_actions = @($probe.repair_actions)
            notified = $notified
        })
    }
    Write-Mirror -Status $probe -Alert $alert
} else {
    if ($previousAlert) {
        Write-AlertRecord -Record ([ordered]@{
            ts = (Get-Date).ToUniversalTime().ToString('o'); event = 'cleared'
            machine = $machine; status = $probe.status
            previous_reason = [string](Get-Field $previousAlert 'reason')
            previous_count = [int](Get-Field $previousAlert 'count')
        })
        Remove-Item -LiteralPath $currentPath -Force -ErrorAction SilentlyContinue
    }
    if ($repairedNow) {
        Write-AlertRecord -Record ([ordered]@{
            ts = (Get-Date).ToUniversalTime().ToString('o'); event = 'repaired'
            machine = $machine; status = $probe.status
            repair_outcome = [string]$probe.repair_outcome; repair_actions = @($probe.repair_actions)
            owner_pid = $probe.port_owner_pid
        })
    }
    Write-Mirror -Status $probe -Alert $null
}

# ---- output ------------------------------------------------------------------

if ($Report) {
    $label = switch ($probe.status) {
        'healthy' { '正常 (healthy)' }
        'stopped' { '已按用户要求停止 (intentional stop)' }
        'wedged'  { '卡死：端口在听但 /health 不通 (wedged)' }
        'degraded' { '降级运行：DeepSeek 凭据缺失，仅 ChatGPT 通道可用 (degraded provider)' }
        'down'    { '未运行 / 不可达 (down)' }
        'foreign' { '8799 被其它进程占用 (foreign listener)' }
        default   { '未知 (unknown)' }
    }
    Write-Output ''
    Write-Output ('  Codex Bridge 巡检  ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
    Write-Output ('  ------------------------------------------------------------')
    Write-Output ('  状态        : ' + $label)
    Write-Output ('  监听/进程   : 127.0.0.1:' + $probe.port + '  pid=' + $probe.port_owner_pid + '  identity=' + $probe.identity)
    Write-Output ('  /health     : ' + $(if ($probe.health_ok) { 'ok' } elseif ($probe.health) { 'unexpected body' } else { 'unreachable' }))
    Write-Output ('  恢复任务    : ' + $recoveryTask + ' = ' + $probe.recovery_task)
    Write-Output ('  ensurer     : ' + $probe.ensurer_outcome + '/' + $probe.ensurer_reason + '  ' + $probe.ensurer_age_seconds + 's ago')
    Write-Output ('  控制台窗口  : hwnd=' + $probe.console_hwnd + '  (0 = 无窗口，静默运行)')

    $failureTotal = 0
    foreach ($k in $probe.log_failures.Keys) { $failureTotal = $failureTotal + [int]$probe.log_failures[$k] }
    Write-Output ('  请求日志    : 近 ' + $probe.log_window_minutes + ' 分钟 ' + $probe.log_records + ' 条; 上游/鉴权失败=' + $failureTotal + ', 客户端取消=' + $probe.log_client_cancelled + ', 未知模型=' + $probe.log_unknown_model)
    if ($failureTotal -gt 0) {
        foreach ($k in $probe.log_failures.Keys) { Write-Output ('                ' + $k + ' x' + $probe.log_failures[$k]) }
        foreach ($detail in $probe.log_failure_details) {
            $recoveryLabel = if ($detail.recovered) { 'recovered' } else { 'active' }
            Write-Output ('                ' + $detail.upstream + '/' + $detail.model + ' HTTP ' + $detail.status + ': ' + $recoveryLabel + ' (later successes=' + $detail.recovery_successes + ')')
            if ($detail.status -eq 402) {
                Write-Output '                HTTP 402: 上游计费/余额问题；重启 Bridge 无法补充余额。'
            }
        }
    }

    $cfgLabel = 'ok'
    if (-not $probe.config_exists) { $cfgLabel = 'missing' }
    elseif ((@($probe.config_duplicate_sections).Count -gt 0) -or (@($probe.config_unclosed_lines).Count -gt 0) -or (-not $probe.config_bridge_section)) { $cfgLabel = '结构有问题' }
    Write-Output ('  config.toml : ' + $cfgLabel + '  (bridge_key 行=' + $probe.config_key_lines + ')')

    if (@($probe.problems).Count -gt 0) { Write-Output ('  问题        : ' + (@($probe.problems) -join ', ')) }
    if (@($probe.notes).Count -gt 0) { Write-Output ('  备注        : ' + (@($probe.notes) -join ', ')) }
    if ($probe.status -eq 'degraded') {
        Write-Output '  说明        : DeepSeek Key 未加载（桥仍服务 GPT 通道）。用本用户运行 tools\protect-secret.ps1 -DeepSeekApiKey <key> 写回 DPAPI 文件即可恢复。'
    }
    if (@($probe.repair_actions).Count -gt 0) { Write-Output ('  修复动作    : ' + (@($probe.repair_actions) -join ' | ')) }
    if ($probe.repair_outcome) { Write-Output ('  修复结论    : ' + $probe.repair_outcome) }
    if ($probe.repair_guidance) { Write-Output ('  下一步      : ' + $probe.repair_guidance) }
    foreach ($check in $probe.transport_checks) {
        Write-Output ('  链路诊断    : ' + $check.upstream + ' reachable=' + $check.transport_reachable + ' reason=' + $check.reason)
    }

    if ((@($probe.config_duplicate_sections).Count -gt 0) -or (@($probe.config_unclosed_lines).Count -gt 0)) {
        Write-Output ''
        Write-Output '  config.toml 结构异常。一键修复不会自动改它（那是 Codex 的配置，不是 Bridge 的进程）。'
        Write-Output '  如果 Codex 报 "duplicate key" / "unclosed table" 打不开，从备份还原，注意要挑"损坏之前"的那一份：'
        Write-Output '    $c = Join-Path $env:USERPROFILE ".codex\config.toml"'
        Write-Output '    Get-ChildItem "$c.bak*" | Sort-Object LastWriteTime -Descending | Select-Object -First 6 Name,Length,LastWriteTime'
        Write-Output '    Copy-Item -LiteralPath "<备份文件>" -Destination $c -Force'
    }

    Write-Output ('  记录        : ' + $healthPath)
    Write-Output ('  告警历史    : ' + $alertLogPath)
    Write-Output ''
    if ($isProblem) {
        Write-Output '  结果: PROBLEM - 查看“下一步”；未确认恢复，不要反复点击修复。'
    } else {
        Write-Output '  结果: PASS'
    }
    Write-Output ''
} elseif (-not $Watch) {
    Write-Output ($probe | ConvertTo-Json -Compress -Depth 6)
}

if ($isProblem) { exit 2 }
exit 0
