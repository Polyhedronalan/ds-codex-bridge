# Pure decision helpers. They do not inspect credentials or control processes.
function Confirm-BridgeManualWedge {
    param($Probe, [int]$ConfirmProbes = 2)
    $streak = 1
    $owner = [int]$Probe.port_owner_pid
    while ($Probe.status -eq 'wedged' -and $streak -lt [Math]::Max(1, $ConfirmProbes)) {
        Start-Sleep -Milliseconds 400
        $Probe = Get-BridgeProbe
        if ([int]$Probe.port_owner_pid -ne $owner) { $streak = 0; break }
        if ($Probe.status -ne 'wedged') { $streak = 0; break }
        $streak++
    }
    return @{ probe = $Probe; streak = $streak }
}

function Get-BridgeRepairPlan {
    param($Probe, [bool]$Manual, [int]$WedgeStreak = 0, [int]$ConfirmProbes = 2)
    $plan = @{ repair = $false; status = [string]$Probe.status; outcome = 'not_needed_local_healthy' }
    switch ([string]$Probe.status) {
        'down' { $plan.repair = $true; $plan.outcome = 'start_local_bridge'; return $plan }
        'wedged' {
            $plan.repair = ($WedgeStreak -ge [Math]::Max(1, $ConfirmProbes))
            $plan.outcome = if ($plan.repair) { 'restart_confirmed_wedge' } else { 'awaiting_wedge_confirmation' }
            return $plan
        }
        'foreign' { $plan.outcome = 'refused_foreign_listener'; return $plan }
        'degraded' { $plan.outcome = 'refused_degraded_provider'; return $plan }
        'stopped' { $plan.outcome = 'skipped_intentional_stop'; return $plan }
        'healthy' {
            if ($Manual -and $Probe.log_active_failures.Contains('BRIDGE_AUTH_FAILED')) {
                $plan.repair = $true; $plan.status = 'auth'; $plan.outcome = 'reload_local_key'
            } elseif (@($Probe.problems).Count -gt 0) {
                $plan.outcome = 'requires_targeted_action'
            }
            return $plan
        }
        default { $plan.outcome = 'refused_unknown_state'; return $plan }
    }
}

function Get-BridgeRepairGuidance {
    param($Probe)
    $hints = New-Object System.Collections.Generic.List[string]
    if ($Probe.status -in @('down', 'wedged')) {
        $hints.Add('本地 Bridge 未恢复：可运行一次 BridgeRepair.cmd，查看修复步骤及退出码。')
    } elseif ($Probe.status -eq 'foreign') {
        $hints.Add('8799 的监听者身份未核实，未停止该进程；需先核对端口归属。')
    } elseif ($Probe.status -eq 'unknown') {
        $hints.Add('本地状态无法核实，未执行进程操作；需查看探测失败原因。')
    } elseif ($Probe.status -eq 'degraded') {
        $hints.Add('DeepSeek Key 未加载：检查当前用户凭据配置，反复重启无法补充凭据。')
    } elseif ($Probe.status -eq 'stopped') {
        $hints.Add('Bridge 已按用户要求停止；需使用 start-production.ps1 显式恢复。')
    }
    $active = @($Probe.log_failure_details | Where-Object { -not $_.recovered })
    if (@($active | Where-Object { $_.status -eq 402 }).Count) {
        $hints.Add('HTTP 402：检查对应上游账户余额/计费；重启 Bridge 无法解决。')
    }
    if (@($active | Where-Object { $_.code -in @('BRIDGE_CHATGPT_AUTH_FAILED', 'BRIDGE_DEEPSEEK_AUTH_FAILED') }).Count) {
        $hints.Add('上游 401/403：核对对应模型权限与登录/Key 状态；本地修复不会刷新 OAuth 或改变模型权限。')
    }
    if (@($active | Where-Object { $_.code -in @('BRIDGE_UPSTREAM_UNAVAILABLE', 'BRIDGE_PROXY_UNAVAILABLE', 'BRIDGE_UPSTREAM_TIMEOUT') }).Count) {
        $hints.Add('代理/上游连接异常：查看无凭据链路诊断；若 TLS 握手失败或连接断开，需检查代理节点/网络。反复重启健康的 Bridge 无法修复外部链路。')
    }
    if (@($active | Where-Object { $_.status -eq 429 }).Count) {
        $hints.Add('上游限流：等待服务允许重试；本地重启不会清除限流。')
    }
    if (@($active | Where-Object { $_.code -eq 'BRIDGE_UPSTREAM_ERROR' -and $_.status -ge 500 }).Count) {
        $hints.Add('上游 5xx：检查服务状态，稍后重试；本地健康不代表上游请求成功。')
    }
    if ($Probe.log_active_failures.Contains('BRIDGE_AUTH_FAILED')) {
        $hints.Add('本地 Key 不匹配：手动修复可尝试重新加载 Bridge 的 Key；若仍失败，需核对客户端配置并刷新客户端。')
    }
    if (@($Probe.problems | Where-Object { $_ -like 'config_*' }).Count) {
        $hints.Add('Codex 配置需针对性处理；修复入口不会自动覆盖 config.toml。')
    }
    if (@($Probe.problems | Where-Object { $_ -like 'recovery_*' -or $_ -like 'ensurer_*' }).Count) {
        $hints.Add('恢复任务/ensurer 异常：查看对应任务与记录；启动进程成功不代表恢复链已修复。')
    }
    if (@($active | Where-Object { $_.code -in @('BRIDGE_PAYLOAD_INCOMPATIBLE', 'BRIDGE_REQUEST_TOO_LARGE', 'BRIDGE_BUSY') }).Count) {
        $hints.Add('请求格式、大小或并发问题：查看对应错误码并调整请求；不会通过重启自动消除。')
    }
    if (-not $hints.Count -and @($Probe.problems).Count) {
        $hints.Add('本地 Bridge 已响应，但仍有需针对性处理的问题，查看上方问题与错误码。')
    }
    return ($hints -join ' ')
}

function Get-BridgeLocalRepairOutcome {
    param([string]$AttemptOutcome, $Probe)
    if ($AttemptOutcome -ne 'repair_attempted') { return $AttemptOutcome }
    if ($Probe.status -eq 'healthy' -and @($Probe.problems).Count -eq 0) { return 'local_recovery_verified' }
    if ($Probe.status -eq 'healthy') { return 'local_ready_other_problem_remains' }
    return 'local_recovery_failed'
}
