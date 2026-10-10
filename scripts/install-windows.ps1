param(
  [string]$Bundle = $PSScriptRoot,
  [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA 'Converoom'),
  [string[]]$Products = @('codex'),
  [switch]$NoStart,
  [switch]$NoPath,
  [switch]$LocalOnly
)
$ErrorActionPreference = 'Stop'
if (![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or [Environment]::OSVersion.Version.Build -lt 22000) {
  throw 'This bundle requires Windows 11 x64 and 64-bit PowerShell.'
}
Import-Module (Join-Path $PSScriptRoot 'windows-install.psm1') -Force
Write-Host 'Installing Converoom, its Node runtime, missing Git and Tailscale, and the selected native agents.'
Write-Host 'Git/Tailscale package agreements are accepted for this installation. Vendor sign-in remains in each native client.'
$result = Install-ConveroomBundle -Bundle $Bundle -DataDirectory $DataDirectory -Products $Products -NoPath:$NoPath -LocalOnly:$LocalOnly
Write-Host ('Local installation verified. Tailscale: ' + $result.tailscale + '. Shared access: disabled.')
Write-Host ('Launcher: ' + (Join-Path $DataDirectory 'bin/converoom.ps1') + '. New terminals can use converoom.')
if (!$LocalOnly) { Write-Host 'Sign in to Tailscale using its tray icon.' }
Write-Host 'Sign in through your chosen native agents before granting a room turn.'
if (!$NoStart) {
  $selection = $Products -join ','
  if (!$selection) { $selection = ',' }
  & $result.node $result.cli onboard --products $selection --data-dir $result.dataDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Converoom onboarding failed. Rerun the launcher with onboard after resolving the displayed issue.' }
}
