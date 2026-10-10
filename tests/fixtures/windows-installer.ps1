param([string]$Root, [string]$Mode, [string]$ModulePath, [string]$NodePath)
$ErrorActionPreference = 'Stop'
$calls = [System.Collections.Generic.List[object]]::new()
$receipt = $null
$failure = $null
$data = Join-Path $Root 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
Set-Content -LiteralPath (Join-Path $data 'retained.txt') -Value 'keep existing work' -NoNewline
if ($Mode -eq 'locked') { Set-Content -LiteralPath (Join-Path $data 'runtime.lock') -Value '{}' }
try {
  if (![System.IO.File]::Exists($ModulePath)) { throw 'Installer implementation missing' }
  $module = Import-Module $ModulePath -Force -PassThru
  if ($Mode -eq 'entry') {
    $stub = 'param($Bundle, $DataDirectory, $Products, [switch]$NoPath, [switch]$LocalOnly); return @{ node = $env:CONVEROOM_TEST_NODE; cli = (Join-Path $Bundle "argv.mjs"); dataDirectory = $DataDirectory; tailscale = "NeedsLogin" }'
    [System.IO.File]::WriteAllText((Join-Path $Root 'windows-install.psm1'), ('function Install-ConveroomBundle { ' + $stub + ' }'))
    [System.IO.File]::WriteAllText((Join-Path $Root 'argv.mjs'), 'import{writeFileSync}from"node:fs";writeFileSync(process.env.CONVEROOM_TEST_ARGV,JSON.stringify(process.argv.slice(2)))')
    $env:CONVEROOM_TEST_NODE = $NodePath
    $env:CONVEROOM_TEST_ARGV = Join-Path $Root 'argv.json'
    & (Join-Path $Root 'install.ps1') -Bundle $Root -DataDirectory $data -Products @() -NoPath
    $receipt = [System.IO.File]::ReadAllText($env:CONVEROOM_TEST_ARGV) | ConvertFrom-Json
  } elseif ($Mode -eq 'argv') {
    $receipt = & $module {
      param($NodePath)
      $output = Invoke-ConveroomProgram $NodePath @('-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--',
        'a "quote"', '', 'C:\space path\', '$(literal); & whoami', 'Tiếng Việt')
      return ($output | ConvertFrom-Json)
    } $NodePath
  } else {
  $receipt = & $module {
    param($Root, $Mode, $Calls, $Data)
    $script:installed = @{}
    if ($Mode -eq 'existing') { foreach ($name in @('git', 'tailscale', 'codex')) { $script:installed[$name] = $true } }
    function script:Find-ConveroomCommand($Name) {
      if ($Name -eq 'winget' -or $script:installed[$Name]) { return ($Name + '.exe') }
      return $null
    }
    function script:Update-ConveroomPath { }
    function script:Set-ConveroomUserPath($Paths) { }
    function script:Invoke-ConveroomProgram($Command, $Arguments) {
      $Calls.Add(@{ command = $Command; args = @($Arguments) })
      if ($Arguments[0] -eq 'install') {
        if ($Mode -eq 'failed') { throw 'Git.Git installer failed' }
        if ($Arguments -contains 'Git.Git') { $script:installed['git'] = $true }
        if ($Arguments -contains 'Tailscale.Tailscale') { $script:installed['tailscale'] = $true }
      }
      if ($Arguments -contains '@openai/codex') { $script:installed['codex'] = $true }
      if ($Arguments -contains 'setup') {
        $target = Join-Path $Data 'runtime/0.2.0/dist'
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $target 'cli.js') -Value 'stable fixture'
      }
      if ($Arguments -contains 'doctor') { return '{"products":[{"product":"codex","installed":true}]}' }
      if ($Arguments -contains '--json') { return '{"BackendState":"NeedsLogin"}' }
      return ''
    }
    Install-ConveroomBundle -Bundle (Join-Path $Root 'bundle') -DataDirectory $Data -Products @('codex')
  } $Root $Mode $calls $data
  }
} catch { $failure = $_.Exception.Message }
$launcher = Join-Path $data 'bin/converoom.ps1'
$retained = [System.IO.File]::ReadAllText((Join-Path $data 'retained.txt'))
$launcherText = ''
if ([System.IO.File]::Exists($launcher)) { $launcherText = [System.IO.File]::ReadAllText($launcher) }
$result = @{ error = $failure; calls = @($calls.ToArray()); receipt = $receipt; retained = $retained; launcher = $launcherText } | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText((Join-Path $Root 'result.json'), $result)
