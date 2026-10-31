param([string]$HealthScript = (Join-Path $PSScriptRoot '..\tools\bridge-health.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path (Split-Path -Parent $HealthScript) 'repair-policy.ps1')
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($HealthScript, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fn = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-BridgeRepair'}, $true)
Invoke-Expression $fn.Extent.Text
$script:assertions = 0
function Assert-That($Value, [string]$Message) {
    if (-not $Value) { throw $Message }; $script:assertions++
}
function New-Probe([string]$Status = 'healthy', [string]$Code = '', [int]$HttpStatus = 502) {
    $p = @{ status = $Status; port_owner_pid = 123; problems = @(); log_active_failures = [ordered]@{};
        log_failures = [ordered]@{}; log_failure_details = @() }
    if ($Code) {
        $p.problems = @('recent_failure'); $p.log_active_failures[$Code] = 1; $p.log_failures[$Code] = 1
        $p.log_failure_details = @(@{code=$Code; status=$HttpStatus; recovered=$false; upstream='chatgpt'; model='test'})
    }
    return $p
}
$p = New-Probe 'healthy' 'BRIDGE_UPSTREAM_UNAVAILABLE'
$plan = Get-BridgeRepairPlan $p $true
Assert-That (-not $plan.repair) 'do not restart a healthy bridge for upstream transport failures'
Assert-That ((Get-BridgeRepairGuidance $p) -like '*TLS*') 'give transport guidance'
$p = New-Probe 'healthy' 'BRIDGE_CHATGPT_AUTH_FAILED' 403
Assert-That (-not (Get-BridgeRepairPlan $p $true).repair) 'upstream 403 is not a local key fault'
Assert-That ((Get-BridgeRepairGuidance $p) -like '*模型权限*') '403 guidance must distinguish model access'
$p = New-Probe 'healthy' 'BRIDGE_UPSTREAM_ERROR' 402
Assert-That ((Get-BridgeRepairGuidance $p) -like '*余额*') '402 needs billing guidance'
$p = New-Probe 'healthy' 'BRIDGE_AUTH_FAILED' 401
Assert-That ((Get-BridgeRepairPlan $p $true).status -eq 'auth') 'manual local-key reload uses existing local lifecycle'
Assert-That (-not (Get-BridgeRepairPlan $p $false).repair) 'watch must never restart for local auth history'
$p.log_active_failures.Clear()
Assert-That (-not (Get-BridgeRepairPlan $p $true).repair) 'historical inactive local auth does not trigger restart'
foreach ($status in @('foreign','stopped','degraded','unknown')) {
    Assert-That (-not (Get-BridgeRepairPlan (New-Probe $status) $true).repair) ('unsafe state: ' + $status)
}
Assert-That ((Get-BridgeRepairPlan (New-Probe 'down') $true).repair) 'local down is repairable'
Assert-That (-not (Get-BridgeRepairPlan (New-Probe 'wedged') $true 1 2).repair) 'one wedge observation cannot trigger restart'
Assert-That ((Get-BridgeRepairPlan (New-Probe 'wedged') $true 2 2).repair) 'confirmed wedge can restart'
function Start-Sleep { param([int]$Milliseconds, [int]$Seconds) }
function Get-BridgeProbe { return $script:nextProbe }
$script:nextProbe = New-Probe 'wedged'
$confirmed = Confirm-BridgeManualWedge (New-Probe 'wedged') 2
Assert-That ($confirmed.streak -eq 2) 'manual first click confirms wedge in one invocation'
$script:nextProbe = New-Probe 'healthy'
Assert-That ((Confirm-BridgeManualWedge (New-Probe 'wedged') 2).streak -eq 0) 'transient wedge that recovers is not restarted'
$script:nextProbe = New-Probe 'wedged'; $script:nextProbe.port_owner_pid = 456
Assert-That ((Confirm-BridgeManualWedge (New-Probe 'wedged') 2).streak -eq 0) 'listener change invalidates consecutive identity evidence'
Assert-That ((Get-BridgeLocalRepairOutcome 'repair_attempted' (New-Probe)) -eq 'local_recovery_verified') 'local verified recovery'
Assert-That ((Get-BridgeLocalRepairOutcome 'repair_attempted' (New-Probe 'healthy' 'BRIDGE_CHATGPT_AUTH_FAILED' 403)) -eq 'local_ready_other_problem_remains') 'local readiness is not upstream recovery'
Assert-That ((Get-BridgeLocalRepairOutcome 'local_start_failed' (New-Probe)) -eq 'local_start_failed') 'step failure must not be called recovery'

# Stub lifecycle calls; never launch production stop/start scripts in a regression test.
$script:BridgeRoot = $PSScriptRoot
$script:stopExists = $true; $script:startExists = $true
function Test-Path { param([string]$LiteralPath)
    if ($LiteralPath -like '*stop-production.ps1') { return $script:stopExists }
    return $script:startExists
}
$script:steps = @(); $script:stopExit = 1; $script:startExit = 0
function Invoke-BridgeLifecycleStep {
    param([string]$Path, [string]$ProxyAddress, [switch]$Start)
    if ($Start) { $script:steps += 'start'; return $script:startExit }
    $script:steps += 'stop'; return $script:stopExit
}
$r = Invoke-BridgeRepair -Status 'wedged' -ProxyAddress ''
Assert-That ($r.outcome -eq 'local_stop_failed' -and $script:steps.Count -eq 1) 'stop failure aborts start and preserves code'
$script:steps = @(); $script:stopExists = $false
$r = Invoke-BridgeRepair -Status 'wedged' -ProxyAddress ''
Assert-That ($r.outcome -eq 'local_stop_missing' -and $script:steps.Count -eq 0) 'missing stop cannot start duplicate process'
$script:stopExists = $true; $script:stopExit = 0; $script:startExit = 1
$r = Invoke-BridgeRepair -Status 'wedged' -ProxyAddress ''
Assert-That ($r.outcome -eq 'local_start_failed' -and ($script:steps -join ',') -eq 'stop,start') 'start failure is recorded after successful stop'
$script:steps = @(); $script:startExit = 0
Assert-That ((Invoke-BridgeRepair -Status 'down' -ProxyAddress '').outcome -eq 'repair_attempted') 'down starts without a stop'
Assert-That (($script:steps -join ',') -eq 'start') 'down only invokes start'
Write-Output ('PASS: ' + $script:assertions + ' repair assertions; no process controls executed')
