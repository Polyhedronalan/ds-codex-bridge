<#
  tools/protect-secret.ps1 — store bridge secrets with Windows DPAPI (user scope).

  Writes bridge\secrets.dpapi.json containing DPAPI-protected blobs for:
    DEEPSEEK_API_KEY  (DeepSeek bearer used by the deepseek-* branch)
    BRIDGE_LOCAL_KEY  (local client key; must equal query_params.bridge_key
                       in the candidate CODEX_HOME config.toml)

  The plaintext never leaves this process except into the protected blob.
  Environment variables take precedence at runtime, so this file is optional.

  Usage:
    pwsh -NoProfile -File tools/protect-secret.ps1 -DeepSeekApiKey <key> -LocalKey <key>
    pwsh -NoProfile -File tools/protect-secret.ps1 -GenerateLocalKey
#>
[CmdletBinding()]
param(
    [string]$DeepSeekApiKey = '',
    [string]$LocalKey = '',
    [switch]$GenerateLocalKey,
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
if (-not $OutFile) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { (Get-Location).Path }
    $OutFile = Join-Path $scriptDir '..\secrets.dpapi.json'
}

if ($GenerateLocalKey) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $LocalKey = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
    Write-Output "generated local key (write this into the candidate config.toml query_params):"
    Write-Output $LocalKey
}

if (-not $DeepSeekApiKey -and -not $LocalKey) {
    throw 'nothing to protect: pass -DeepSeekApiKey and/or -LocalKey (or -GenerateLocalKey)'
}

$protect = {
    param([string]$value)
    $bytes = [Text.Encoding]::UTF8.GetBytes($value)
    $blob = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
    return [Convert]::ToBase64String($blob)
}

$existing = @{}
if (Test-Path -LiteralPath $OutFile) {
    $raw = Get-Content -Raw -LiteralPath $OutFile
    if ($raw.Trim().Length -gt 0) {
        (ConvertFrom-Json $raw).PSObject.Properties | ForEach-Object { $existing[$_.Name] = $_.Value }
    }
}
if ($DeepSeekApiKey) { $existing['DEEPSEEK_API_KEY'] = & $protect $DeepSeekApiKey }
if ($LocalKey) { $existing['BRIDGE_LOCAL_KEY'] = & $protect $LocalKey }

$json = $existing | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))

$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$aclStatus = 'not applied'
try {
    $acl = Get-Acl -LiteralPath $OutFile
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $OutFile -AclObject $acl
    $aclStatus = "ACL restricted to $me"
} catch {
    $aclStatus = "ACL step skipped: $($_.Exception.Message)"
}

Write-Output "wrote $OutFile (DPAPI user scope, $aclStatus)"
Write-Output ("keys: " + (($existing.Keys | Sort-Object) -join ', '))
