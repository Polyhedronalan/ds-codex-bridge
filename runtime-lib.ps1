Set-StrictMode -Version 2.0

$script:BridgeRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$script:RuntimeDir = Join-Path $script:BridgeRoot 'runtime'
$script:LogDir = Join-Path $script:BridgeRoot 'logs'
$script:LifecycleLog = Join-Path $script:LogDir 'lifecycle.jsonl'
$script:StatePath = Join-Path $script:RuntimeDir 'state.json'
$script:SupervisorPidPath = Join-Path $script:RuntimeDir 'supervisor.pid'
$script:BridgePidPath = Join-Path $script:RuntimeDir 'bridge.pid'
$script:StopFlagPath = Join-Path $script:RuntimeDir 'stop.flag'
$script:BridgeScript = (Join-Path $script:BridgeRoot 'bridge.mjs')
# Optional lifecycle tools use the short-lived ensurer. No task is installed by this package.
$script:LegacySupervisorScript = (Join-Path $script:BridgeRoot 'bridge-supervisor.ps1')
$script:NodeSupervisorScript = (Join-Path $script:BridgeRoot 'supervisor\bridge-supervisor.mjs')
$script:SupervisorScript = if (Test-Path -LiteralPath $script:LegacySupervisorScript) {
    $script:LegacySupervisorScript
} else {
    $script:NodeSupervisorScript
}
$script:TaskName = 'CodexBridgeSupervisor'
$script:BridgePort = 8799
$script:HealthUri = 'http://127.0.0.1:8799/health'
$script:DefaultProxy = $env:HTTPS_PROXY
$script:CodexAppId = 'OpenAI.Codex_2p2nqsd0c76g0!App'
$script:LogMaxBytes = 10MB
$script:LogMaxFiles = 5

function Invoke-LogRotation {
    param(
        [Parameter(Mandatory)][string]$Path,
        [long]$IncomingBytes = 0,
        [long]$MaxBytes = $script:LogMaxBytes,
        [int]$MaxFiles = $script:LogMaxFiles
    )
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
        $length = (Get-Item -LiteralPath $Path -ErrorAction Stop).Length
        if ($length -eq 0 -or ($length + [Math]::Max(0, $IncomingBytes)) -le $MaxBytes) { return $false }
        $oldest = "$Path.$MaxFiles"
        if (Test-Path -LiteralPath $oldest) { Remove-Item -LiteralPath $oldest -Force }
        for ($i = $MaxFiles - 1; $i -ge 1; $i--) {
            $from = "$Path.$i"
            if (Test-Path -LiteralPath $from) { Move-Item -LiteralPath $from -Destination "$Path.$($i + 1)" -Force }
        }
        Move-Item -LiteralPath $Path -Destination "$Path.1" -Force
        return $true
    } catch {
        return $false
    }
}

function Initialize-BridgeRuntime {
    [void](New-Item -ItemType Directory -Path $script:RuntimeDir -Force)
    [void](New-Item -ItemType Directory -Path $script:LogDir -Force)
}

function Get-ParentPid {
    param([int]$ProcessId = $PID)
    try {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
        return [int]$p.ParentProcessId
    } catch {
        return 0
    }
}

function Write-LifecycleEvent {
    param(
        [Parameter(Mandatory)][ValidateSet(
            'launcher_start',
            'supervisor_start',
            'supervisor_adopt_bridge',
            'supervisor_stop_requested',
            'supervisor_exit',
            'bridge_start',
            'bridge_ready',
            'bridge_exit',
            'bridge_restart',
            'intentional_stop',
            'proxy_wait',
            'launcher_complete'
        )][string]$Event,
        [Nullable[int]]$SupervisorPid = $null,
        [Nullable[int]]$BridgePid = $null,
        [Nullable[int]]$ParentPid = $null,
        [Nullable[int]]$ExitCode = $null,
        [int]$RestartCount = 0,
        [string]$Reason = '',
        [string]$Health = ''
    )

    Initialize-BridgeRuntime
    $record = [ordered]@{
        timestamp      = (Get-Date).ToUniversalTime().ToString('o')
        event          = $Event
        supervisor_pid = $SupervisorPid
        bridge_pid     = $BridgePid
        parent_pid     = $ParentPid
        exit_code      = $ExitCode
        restart_count  = $RestartCount
        reason         = $Reason
        health         = $Health
    }
    $line = $record | ConvertTo-Json -Compress
    Invoke-LogRotation -Path $script:LifecycleLog -IncomingBytes ([Text.Encoding]::UTF8.GetByteCount($line + "`r`n")) | Out-Null
    Add-Content -LiteralPath $script:LifecycleLog -Value $line -Encoding UTF8
}

function Get-BridgeHealth {
    param([int]$TimeoutSec = 2)
    try {
        $response = Invoke-WebRequest -Uri $script:HealthUri -UseBasicParsing -TimeoutSec $TimeoutSec
        if ($response.StatusCode -eq 200) {
            return [string]$response.Content
        }
    } catch {
    }
    return ''
}

function Test-BridgeHealth {
    param([int]$TimeoutSec = 2)
    return [bool](Get-BridgeHealth -TimeoutSec $TimeoutSec)
}

function Get-BridgePortOwner {
    try {
        $netstat = Join-Path "$env:WINDIR\System32" 'netstat.exe'
        $lines = @(& $netstat -ano -p tcp 2>$null)
        if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0) { return -1 }
        foreach ($line in $lines) {
            if ($line -match ('TCP\s+\S*:' + $script:BridgePort + '\s+\S+\s+LISTENING\s+(\d+)\s*$')) {
                return [int]$Matches[1]
            }
        }
        return 0
    } catch {
        return -1
    }
}

function Resolve-BridgeNode {
    $runtimeRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
    $candidates = @()
    if (Test-Path -LiteralPath $runtimeRoot) {
        $candidates += Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            ForEach-Object { Join-Path $_.FullName 'bin\node.exe' }
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $candidates += $nodeCommand.Source
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'node.exe not found in the Codex CUA runtime or PATH'
}

function Read-BridgeState {
    if (-not (Test-Path -LiteralPath $script:StatePath)) {
        return $null
    }
    try {
        # -Encoding UTF8 is required: the Node host writes state.json as BOM-less
        # UTF-8, and Windows PowerShell 5.1 would otherwise decode it as ANSI and
        # fail to parse (measured 2026-09-28: mojibake -> "Unrecognized escape
        # sequence" -> Read-BridgeState returned $null).
        return Get-Content -Raw -Encoding UTF8 -LiteralPath $script:StatePath | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Write-BridgeState {
    param(
        [Nullable[int]]$SupervisorPid,
        [Nullable[int]]$BridgePid,
        [string]$NodePath,
        [string]$Status
    )
    Initialize-BridgeRuntime
    $state = [ordered]@{
        updated_at        = (Get-Date).ToUniversalTime().ToString('o')
        status            = $Status
        supervisor_pid    = $SupervisorPid
        supervisor_script = $script:SupervisorScript
        bridge_pid        = $BridgePid
        executable_path   = $NodePath
        bridge_script     = $script:BridgeScript
        port              = $script:BridgePort
        health_uri        = $script:HealthUri
    }
    $tempPath = $script:StatePath + '.tmp'
    $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tempPath -Encoding UTF8
    Move-Item -LiteralPath $tempPath -Destination $script:StatePath -Force
}

function Get-ProcessIdentity {
    param([Parameter(Mandatory)][int]$ProcessId)
    try {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
        $path = [string]$cim.ExecutablePath
        if (-not $path) {
            try { $path = (Get-Process -Id $ProcessId -ErrorAction Stop).Path } catch { }
        }
        return [pscustomobject]@{
            pid          = [int]$cim.ProcessId
            parent_pid   = [int]$cim.ParentProcessId
            name         = [string]$cim.Name
            path         = $path
            command_line = [string]$cim.CommandLine
        }
    } catch {
        return $null
    }
}

function Test-SupervisorIdentity {
    param([Parameter(Mandatory)][int]$ProcessId)
    $identity = Get-ProcessIdentity -ProcessId $ProcessId
    if (-not $identity) { return $false }

    # Legacy / rollback host: Windows PowerShell or pwsh running bridge-supervisor.ps1
    if ($identity.name -in @('powershell.exe', 'pwsh.exe')) {
        if ($identity.command_line) {
            return $identity.command_line.IndexOf($script:SupervisorScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }
        return $false
    }

    # Node host: proven by the owner record (PID + script path + script hash + host tag).
    if ($identity.name -eq 'node.exe') {
        $owner = Get-SupervisorOwnerRecord
        if (-not $owner) { return $false }
        if ([string]$owner.host -ne 'node') { return $false }
        if ([int]$owner.pid -ne $ProcessId) { return $false }
        $ownerScript = [string]$owner.script_path
        if (-not $ownerScript -or -not (Test-Path -LiteralPath $ownerScript)) { return $false }
        $actualHash = (Get-FileHash -LiteralPath $ownerScript -Algorithm SHA256).Hash.ToLower()
        if ([string]$owner.script_sha256 -ne $actualHash) { return $false }
        return $true
    }
    return $false
}

function Get-SupervisorOwnerRecord {
    $ownerPath = Join-Path $script:RuntimeDir 'supervisor-owner.json'
    if (-not (Test-Path -LiteralPath $ownerPath)) { return $null }
    $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $ownerPath -ErrorAction SilentlyContinue
    if (-not $raw) { return $null }
    try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

function Test-BridgeIdentity {
    param(
        [Parameter(Mandatory)][int]$ProcessId,
        $State = $null,
        [switch]$RequireHealth
    )

    if (-not $State) {
        $State = Read-BridgeState
    }
    if (-not $State -or [int]$State.bridge_pid -ne $ProcessId) {
        return $false
    }
    if ([int]$State.port -ne $script:BridgePort) {
        return $false
    }
    if ([string]$State.bridge_script -ne $script:BridgeScript) {
        return $false
    }

    $identity = Get-ProcessIdentity -ProcessId $ProcessId
    if (-not $identity -or $identity.name -ne 'node.exe') {
        return $false
    }
    if ($identity.path -and $State.executable_path) {
        if (-not [string]::Equals(
            (Resolve-Path -LiteralPath $identity.path).Path,
            (Resolve-Path -LiteralPath ([string]$State.executable_path)).Path,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            return $false
        }
    }
    if ($identity.command_line) {
        if ($identity.command_line.IndexOf($script:BridgeScript, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            return $false
        }
    }

    $owner = Get-BridgePortOwner
    if ($owner -ne 0 -and $owner -ne $ProcessId) {
        return $false
    }
    if ($RequireHealth -and -not (Test-BridgeHealth)) {
        return $false
    }
    return $true
}

function Test-BridgeListenerIdentity {
    param(
        [Parameter(Mandatory)][int]$ProcessId,
        $State = $null,
        [string]$HealthBody = ''
    )

    $identity = Get-ProcessIdentity -ProcessId $ProcessId
    if (-not $identity) {
        try {
            if ((Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName -ne 'node') { return $false }
        } catch { return $false }
    } elseif ($identity.name -ne 'node.exe') { return $false }
    if ($identity -and $identity.command_line) {
        return ($identity.command_line.IndexOf($script:BridgeScript, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    }

    # Command-line access can be blocked across integrity levels. In that case require
    # the live listener PID, the exact Bridge script/port record, and this Bridge's health shape.
    if (-not $State) { $State = Read-BridgeState }
    if (-not $State -or [int]$State.bridge_pid -ne $ProcessId -or
        [int]$State.port -ne $script:BridgePort -or
        [string]$State.bridge_script -ne $script:BridgeScript -or -not $HealthBody) {
        return $false
    }
    try {
        $health = $HealthBody | ConvertFrom-Json
        return ([string]$health.status -eq 'ok' -and [string]$health.local_auth -eq 'configured')
    } catch {
        return $false
    }
}

function Test-ProxyReady {
    param(
        [string]$Proxy = $script:DefaultProxy,
        [int]$TimeoutMs = 2000
    )
    try {
        $uri = [Uri]$Proxy
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
        $ready = $async.AsyncWaitHandle.WaitOne($TimeoutMs)
        if ($ready) {
            $client.EndConnect($async)
        }
        $client.Close()
        return $ready
    } catch {
        return $false
    }
}

function Remove-RuntimePidFile {
    param([Parameter(Mandatory)][string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
}
