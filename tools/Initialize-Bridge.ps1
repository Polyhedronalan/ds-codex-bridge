<# Creates local configuration only; never edits the user's Codex home. #>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$configPath = Join-Path $root 'config.json'
$secretPath = Join-Path $root 'secrets.dpapi.json'
$providerPath = Join-Path $root 'examples\codex.local.toml'
foreach ($target in @($configPath, $secretPath, $providerPath)) {
    if (Test-Path -LiteralPath $target) { throw "Already exists; refusing to overwrite: $target" }
}

$secure = Read-Host 'DeepSeek API Key (hidden; Enter to skip)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$created = [Collections.Generic.List[string]]::new()
try {
    $deepseek = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $random = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($random) } finally { $rng.Dispose() }
    $localKey = [Convert]::ToBase64String($random).Replace('+','-').Replace('/','_').TrimEnd('=')
    $values = @{ BRIDGE_LOCAL_KEY = $localKey }
    if (-not [string]::IsNullOrWhiteSpace($deepseek)) { $values.DEEPSEEK_API_KEY = $deepseek.Trim() }
    $encrypted = @{}
    foreach ($key in $values.Keys) {
        $blob = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($values[$key]), $null, 'CurrentUser')
        $encrypted[$key] = [Convert]::ToBase64String($blob)
    }
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($secretPath, ($encrypted | ConvertTo-Json), $utf8)
    $created.Add($secretPath)
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = Get-Acl -LiteralPath $secretPath
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $secretPath -AclObject $acl
    $example = [IO.File]::ReadAllText((Join-Path $root 'examples\codex.config.example.toml'))
    [IO.File]::WriteAllText($providerPath, $example.Replace('REPLACE_WITH_YOUR_GENERATED_LOCAL_KEY', $localKey), $utf8)
    $created.Add($providerPath)
    Set-Acl -LiteralPath $providerPath -AclObject $acl
    Copy-Item -LiteralPath (Join-Path $root 'config.example.json') -Destination $configPath
    $created.Add($configPath)
    Write-Output 'Local configuration created. No service was started and no global configuration changed.'
    Write-Output 'Merge examples\codex.local.toml into your Codex configuration, then run npm start.'
} catch {
    foreach ($target in $created) { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue }
    throw
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $deepseek = $null; $localKey = $null; $values = $null
    $secure.Dispose()
}
