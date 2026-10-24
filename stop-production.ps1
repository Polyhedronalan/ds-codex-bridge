<#
  Intentional, precise stop for the on-demand production Bridge lifecycle.
  A stop flag is written before either process is touched so the supervisor does
  not interpret the Bridge exit as a crash.
#>
[CmdletBinding()]
param(
    [int]$WaitSeconds = 20
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-lib.ps1')
Initialize-BridgeRuntime

Set-Content -LiteralPath $script:StopFlagPath -Value ((Get-Date).ToUniversalTime().ToString('o')) -Encoding ASCII
$state = Read-BridgeState
$bridgePid = if ($state -and $state.bridge_pid) { [int]$state.bridge_pid } else { 0 }
$supervisorPid = 0
if ($state -and $state.supervisor_pid) {
    $supervisorPid = [int]$state.supervisor_pid
}

try {
    Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
} catch {
}

$deadline = (Get-Date).AddSeconds([Math]::Max(1, $WaitSeconds))
if ($supervisorPid -gt 0 -and (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue)) {
    if (-not (Test-SupervisorIdentity -ProcessId $supervisorPid)) {
        throw "refusing to stop pid $supervisorPid because Supervisor identity validation failed"
    }
    Stop-Process -Id $supervisorPid -Force -ErrorAction SilentlyContinue
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue) {
        throw "Bridge stop failed: verified Supervisor pid $supervisorPid did not exit within $WaitSeconds seconds"
    }
}

$deadline = (Get-Date).AddSeconds([Math]::Max(1, $WaitSeconds))
$portOwner = Get-BridgePortOwner
if ($portOwner -lt 0) { throw 'Bridge stop failed: could not verify the 8799 listener owner' }
$candidatePids = @()
if ($state -and $state.bridge_pid) { $candidatePids += [int]$state.bridge_pid }
if ($portOwner -gt 0 -and $candidatePids -notcontains $portOwner) { $candidatePids += $portOwner }

foreach ($candidatePid in $candidatePids) {
    $proc = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    $ident = Get-ProcessIdentity -ProcessId $candidatePid
    $commandProvesBridge = [bool]($ident -and $ident.name -eq 'node.exe' -and $ident.command_line -and
        $ident.command_line.IndexOf($script:BridgeScript, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    $listenerProvesBridge = ($portOwner -eq $candidatePid -and
        (Test-BridgeListenerIdentity -ProcessId $candidatePid -State $state -HealthBody (Get-BridgeHealth)))
    if (-not ($commandProvesBridge -or $listenerProvesBridge)) {
        if ($portOwner -eq $candidatePid) {
            throw "Bridge stop failed: 8799 owner pid $candidatePid is not a verified production Bridge; left it untouched"
        }
        continue
    }
    $bridgePid = $candidatePid
    Stop-Process -Id $bridgePid -Force -ErrorAction SilentlyContinue
    break
}

while ((Get-Date) -lt $deadline) {
    $bridgeStillAlive = $false
    if ($bridgePid -gt 0) { $bridgeStillAlive = [bool](Get-Process -Id $bridgePid -ErrorAction SilentlyContinue) }
    $portOwner = Get-BridgePortOwner
    if ($portOwner -lt 0) { throw 'Bridge stop failed: could not verify whether port 8799 was released' }
    if (-not $bridgeStillAlive -and $portOwner -eq 0) { break }
    Start-Sleep -Milliseconds 250
}
$bridgeStillAlive = $false
if ($bridgePid -gt 0) { $bridgeStillAlive = [bool](Get-Process -Id $bridgePid -ErrorAction SilentlyContinue) }
$portOwner = Get-BridgePortOwner
if ($portOwner -lt 0) { throw 'Bridge stop failed: could not verify whether port 8799 was released' }
if ($bridgeStillAlive) { throw "Bridge stop failed: verified Bridge pid $bridgePid did not exit within $WaitSeconds seconds" }
if ($portOwner -gt 0) { throw "Bridge stop failed: port 8799 remains occupied by pid $portOwner; process left untouched" }

Remove-RuntimePidFile -Path $script:BridgePidPath
Remove-RuntimePidFile -Path $script:SupervisorPidPath
$nodePath = if ($state) { [string]$state.executable_path } else { '' }
Write-BridgeState -SupervisorPid $null -BridgePid $null -NodePath $nodePath -Status 'intentional_stop'
Write-LifecycleEvent -Event intentional_stop -SupervisorPid $supervisorPid -BridgePid $bridgePid -ParentPid (Get-ParentPid) -Reason 'stop-production.ps1' -Health (Get-BridgeHealth)

Write-Output "intentional stop complete (supervisor=$supervisorPid bridge=$bridgePid port=8799 released)"
