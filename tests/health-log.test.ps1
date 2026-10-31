param([string]$HealthScript = (Join-Path $PSScriptRoot '..\tools\bridge-health.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Load only the pure log reader; never run the production probe, repair or notification.
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $HealthScript).Path, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('Get-Field', 'Get-BridgeLogWindowStats')) {
    $functionAst = $ast.Find({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if (-not $functionAst) { throw "Missing function: $name" }
    Invoke-Expression $functionAst.Extent.Text
}
$codes = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left.Extent.Text -eq '$script:LogFailureCodes'
}, $true)
Invoke-Expression $codes.Extent.Text

$script:LogDir = Join-Path ([IO.Path]::GetTempPath()) ('bridge-health-test-' + [guid]::NewGuid())
[void](New-Item -ItemType Directory -Path $script:LogDir)
$logPath = Join-Path $script:LogDir 'bridge.jsonl'
$clock = [datetime]::UtcNow.AddMinutes(-10)
$script:assertions = 0
function Assert-That($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:assertions += 1
}
function New-Record([int]$Offset, [int]$Status = 200, [string]$Code = '',
    [string]$Upstream = 'deepseek', [string]$Model = 'deepseek-flash', [string]$Event = '') {
    [ordered]@{ ts = $clock.AddSeconds($Offset).ToString('o'); status = $Status; error_code = $Code
        upstream = $Upstream; model = $Model; event = $Event }
}
function Read-Stats($Records) {
    @($Records | ForEach-Object { $_ | ConvertTo-Json -Compress }) |
        Set-Content -LiteralPath $logPath -Encoding UTF8
    Get-BridgeLogWindowStats -Minutes 90 -TailLines 1500
}
try {
    $failure = New-Record 0 402 'BRIDGE_UPSTREAM_ERROR'
    $s = Read-Stats @($failure)
    Assert-That ($s.active_failures['BRIDGE_UPSTREAM_ERROR'] -eq 1) '402 without recovery must alert'
    Assert-That ($s.failure_details[0].status -eq 402) 'preserve the HTTP billing status'

    $s = Read-Stats @($failure, (New-Record 1), (New-Record 2))
    Assert-That ($s.active_failures['BRIDGE_UPSTREAM_ERROR'] -eq 1) 'two successes are not enough'

    $s = Read-Stats @($failure, (New-Record 1), (New-Record 2), (New-Record 3))
    Assert-That ($s.active_failures.Count -eq 0) 'three completed successes must clear a recovered route'
    Assert-That ($s.failures['BRIDGE_UPSTREAM_ERROR'] -eq 1) 'keep the original failure count'
    Assert-That ($s.recovered_failures['BRIDGE_UPSTREAM_ERROR'] -eq 1) 'record recovery separately'

    $shapes = @(1..3 | ForEach-Object { New-Record $_ 200 '' 'deepseek' 'deepseek-flash' 'request_shape' })
    $s = Read-Stats (@($failure) + $shapes)
    Assert-That ($s.active_failures.Count -eq 1) 'request_shape 200 must never establish recovery'

    $otherProvider = @(1..3 | ForEach-Object { New-Record $_ 200 '' 'chatgpt' 'deepseek-flash' })
    $s = Read-Stats (@($failure) + $otherProvider)
    Assert-That ($s.active_failures.Count -eq 1) 'a different provider must not clear DeepSeek'
    $otherModel = @(1..3 | ForEach-Object { New-Record $_ 200 '' 'deepseek' 'deepseek-v4-pro' })
    $s = Read-Stats (@($failure) + $otherModel)
    Assert-That ($s.active_failures.Count -eq 1) 'a different model must not clear Flash'
    $s = Read-Stats @($failure, (New-Record 1), (New-Record 2), (New-Record 3),
        (New-Record 0 402 'BRIDGE_UPSTREAM_ERROR' 'deepseek' 'deepseek-v4-pro'))
    Assert-That ($s.active_failures['BRIDGE_UPSTREAM_ERROR'] -eq 1 -and
        $s.recovered_failures['BRIDGE_UPSTREAM_ERROR'] -eq 1) 'keep another failed route active under the same code'

    $s = Read-Stats @((New-Record -3), (New-Record -2), (New-Record -1), $failure)
    Assert-That ($s.active_failures.Count -eq 1) 'successes before the failure cannot clear it'
    $s = Read-Stats @($failure, (New-Record 1), (New-Record 2), (New-Record 3),
        (New-Record 4 502 'BRIDGE_UPSTREAM_ERROR'))
    Assert-That ($s.active_failures['BRIDGE_UPSTREAM_ERROR'] -eq 2) 'a later failure resets recovery'

    foreach ($case in @(@(401, 'BRIDGE_DEEPSEEK_AUTH_FAILED'), @(400, 'BRIDGE_PAYLOAD_INCOMPATIBLE'),
        @(422, 'BRIDGE_UPSTREAM_ERROR'), @(401, 'BRIDGE_AUTH_FAILED'))) {
        $s = Read-Stats @((New-Record 0 $case[0] $case[1]), (New-Record 1), (New-Record 2), (New-Record 3))
        Assert-That ($s.active_failures.Count -eq 1) ('caller-specific error must remain active: ' + $case[1])
    }
    foreach ($case in @(@(502, 'BRIDGE_UPSTREAM_ERROR'), @(504, 'BRIDGE_UPSTREAM_TIMEOUT'),
        @(502, 'BRIDGE_UPSTREAM_UNAVAILABLE'), @(503, 'BRIDGE_PROXY_UNAVAILABLE'), @(429, 'BRIDGE_UPSTREAM_RATE_LIMITED'))) {
        $s = Read-Stats @((New-Record 0 $case[0] $case[1]), (New-Record 1), (New-Record 2), (New-Record 3))
        Assert-That ($s.active_failures.Count -eq 0) ('recovered infrastructure failure should clear: ' + $case[1])
    }

    $s = Read-Stats @((New-Record 0 499 'BRIDGE_CLIENT_CANCELLED'), (New-Record 1 400 'BRIDGE_UNKNOWN_MODEL'))
    Assert-That ($s.failures.Count -eq 0 -and $s.client_cancelled -eq 1 -and $s.unknown_model -eq 1) 'preserve cancellation and unknown-model notes'
    $s = Read-Stats @((New-Record -7200 402 'BRIDGE_UPSTREAM_ERROR'))
    Assert-That ($s.failures.Count -eq 0) 'exclude expired failures'

    # Appends can interleave; use timestamps, not physical line order.
    $s = Read-Stats @((New-Record 3), (New-Record 1), $failure, (New-Record 2))
    Assert-That ($s.recovered_failures.Count -eq 1) 'interleaved lines should still recover by timestamp'
    $s = Read-Stats @($failure, (New-Record 1), (New-Record 2), (New-Record 3))
    Add-Content -LiteralPath $logPath -Value '{invalid json' -Encoding UTF8
    $s = Get-BridgeLogWindowStats -Minutes 90 -TailLines 1500
    Assert-That ($s.recovered_failures.Count -eq 1) 'a malformed line must not erase valid evidence'
    Add-Content -LiteralPath $logPath -Value ('{"ts":"' + $clock.AddSeconds(4).ToString('o') + '","status":"bad"}') -Encoding UTF8
    $s = Get-BridgeLogWindowStats -Minutes 90 -TailLines 1500
    Assert-That ($s.recovered_failures.Count -eq 1) 'a malformed status must not discard other evidence'
    Write-Output ('PASS: ' + $script:assertions + ' assertions; ' + $HealthScript)
} finally {
    # Delete only the exact files/directories created by this test, without recursion.
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:LogDir -Force
}
