param([string]$Bundle,[string]$DataDirectory)
$ErrorActionPreference = 'Stop'
$module = Import-Module (Join-Path $Bundle 'windows-install.psm1') -Force -PassThru
$result = & $module {
  param($Bundle,$DataDirectory)
  function script:Install-ConveroomPrerequisite($Name,$Id) { }
  function script:Update-ConveroomPath { }
  function script:Set-ConveroomUserPath($Paths) { throw 'Persistent PATH must stay unchanged in the fixture' }
  function script:Find-ConveroomCommand($Name) { if ($Name -eq 'tailscale') { return 'tailscale-fixture.exe' }; return $null }
  function script:Invoke-ConveroomProgram($Command,$Arguments) {
    if ($Command -eq 'tailscale-fixture.exe') { return '{"BackendState":"NeedsLogin"}' }
    $output = & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Bundled program failed' }
    return ($output -join [Environment]::NewLine)
  }
  Install-ConveroomBundle -Bundle $Bundle -DataDirectory $DataDirectory -Products @() -NoPath
} $Bundle $DataDirectory
if ($result.sharedAccess -ne 'disabled' -or $result.tailscale -ne 'NeedsLogin') { throw 'Incorrect readiness boundary' }
Write-Output 'Bundled installation verified'
