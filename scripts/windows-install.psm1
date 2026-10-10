$ErrorActionPreference = 'Stop'

function Find-ConveroomCommand([string]$Name) {
  $entry = Get-Command $Name -CommandType Application,ExternalScript -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -match '\.(exe|ps1)$' } | Select-Object -First 1
  if ($entry) { return $entry.Source }
  return $null
}

function Update-ConveroomPath {
  $paths = @($env:PATH, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'),
    (Join-Path $env:ProgramFiles 'Git/cmd'), (Join-Path $env:ProgramFiles 'Tailscale'))
  $env:PATH = ($paths | Where-Object { $_ }) -join ';'
}

function Set-ConveroomUserPath([string[]]$Paths) {
  $existing = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($existing -split ';' | Where-Object { $_ })
  foreach ($path in $Paths) { if ($entries -notcontains $path) { $entries += $path } }
  [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
}

function Invoke-ConveroomProgram([string]$Command, [string[]]$Arguments) {
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $Command
  $info.Arguments = ($Arguments | ForEach-Object {
    $value = [regex]::Replace($_, '(\\*)"', '$1$1\"')
    '"' + [regex]::Replace($value, '(\\+)$', '$1$1') + '"'
  }) -join ' '
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $info.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $info
  try {
    if (!$process.Start()) { throw ('Could not start ' + $Command) }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit(600000)) {
      $process.Kill()
      throw ('Installer timed out: ' + $Command + '. Inspect any remaining installer work before rerunning.')
    }
    $output = $stdout.GetAwaiter().GetResult()
    $failure = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw ('Failed: ' + $Command + '. Exit ' + $process.ExitCode + '. ' + $failure) }
    return $output
  } finally { $process.Dispose() }
}

function Assert-ConveroomBundle([string]$Bundle) {
  $manifest = [System.IO.File]::ReadAllText((Join-Path $Bundle 'bundle.json')) | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.version -notmatch '^\d+\.\d+\.\d+$' -or
      $manifest.nodeVersion -ne '24.21.0' -or !$manifest.assets.Count) { throw 'Unsupported bundle manifest' }
  $seen = @{}
  foreach ($asset in $manifest.assets) {
    if ($asset.path -isnot [string] -or $asset.path -match '[<>:"\\|?*\x00-\x1f]' -or
        $asset.path -match '(^|/)(\.{1,2})?(/|$)' -or $asset.path -match '[. ]($|/)' -or
        $seen.ContainsKey($asset.path)) { throw 'Invalid bundle asset path' }
    $seen[$asset.path] = $true
    $path = Join-Path $Bundle $asset.path
    if (![System.IO.File]::Exists($path)) { throw ('Missing bundle asset: ' + $asset.path) }
    $hash = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($path)
    try { $digest = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hash.Dispose() }
    if ($digest -ne $asset.sha256) { throw ('Bundle digest mismatch: ' + $asset.path) }
  }
  foreach ($required in @('node/node.exe', 'node/node_modules/npm/bin/npm-cli.js', 'runtime/dist/cli.js', 'runtime/package.json')) {
    if (!$seen.ContainsKey($required)) { throw ('Missing required bundle asset: ' + $required) }
  }
  return $manifest
}

function Install-ConveroomPrerequisite([string]$Name, [string]$Id) {
  if (Find-ConveroomCommand $Name) { return }
  $winget = Find-ConveroomCommand 'winget'
  if (!$winget) { throw 'Windows App Installer (winget) is required. Install it from Microsoft Store, then rerun this installer.' }
  Write-Host ('Installing ' + $Id + ', Windows may ask for administrator approval.')
  try {
    $output = Invoke-ConveroomProgram $winget @('install', '--id', $Id, '--exact', '--source', 'winget', '--silent',
      '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')
    if ($output) { Write-Host $output }
  } catch { throw ($Id + ' installation failed. Rerun after resolving administrator, network or package-manager access. ' + $_.Exception.Message) }
  Update-ConveroomPath
  if (!(Find-ConveroomCommand $Name)) { throw ($Id + ' installed but its executable is unavailable. Restart the terminal and rerun.') }
}

function Install-ConveroomBundle {
  param([string]$Bundle, [string]$DataDirectory, [string[]]$Products = @('codex'), [switch]$NoPath, [switch]$LocalOnly)
  $Bundle = [System.IO.Path]::GetFullPath($Bundle)
  $DataDirectory = [System.IO.Path]::GetFullPath($DataDirectory)
  $manifest = Assert-ConveroomBundle $Bundle
  if ([System.IO.File]::Exists((Join-Path $DataDirectory 'runtime.lock'))) { throw 'Stop the runtime before installing or repairing Converoom. Existing files were preserved.' }
  $definitions = @{
    codex = @{ command = 'codex'; npm = '@openai/codex' }
    claude = @{ command = 'claude'; npm = '@anthropic-ai/claude-code' }
    opencode = @{ command = 'opencode'; npm = 'opencode-ai' }
    qoder = @{ command = 'qoder'; npm = '@qoder-ai/qodercli' }
    cursor = @{ command = 'agent'; url = 'https://cursor.com/docs/cli/installation' }
    antigravity = @{ command = 'agy'; url = 'https://antigravity.google/docs/cli/installation' }
    kiro = @{ command = 'kiro-cli'; url = 'https://kiro.dev/docs/cli/' }
    grok = @{ command = 'grok'; url = 'https://docs.x.ai/build' }
  }
  $Products = @($Products | Select-Object -Unique)
  Update-ConveroomPath
  foreach ($product in $Products) {
    if (!$definitions.ContainsKey($product)) { throw ('Unknown product: ' + $product) }
    $definition = $definitions[$product]
    if (!$definition.npm -and !(Find-ConveroomCommand $definition.command)) {
      throw ('Install ' + $product + ' from ' + $definition.url + ', then rerun. This preview does not automate that vendor installer.')
    }
  }
  Install-ConveroomPrerequisite 'git' 'Git.Git'
  if (!$LocalOnly) { Install-ConveroomPrerequisite 'tailscale' 'Tailscale.Tailscale' }
  $tools = Join-Path $DataDirectory ('tools/node-v' + $manifest.nodeVersion)
  [System.IO.Directory]::CreateDirectory($tools) | Out-Null
  foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries((Join-Path $Bundle 'node'))) {
    Copy-Item -LiteralPath $entry -Destination $tools -Recurse -Force
  }
  $node = Join-Path $tools 'node.exe'
  $agents = Join-Path $DataDirectory 'tools/agents'
  [System.IO.Directory]::CreateDirectory($agents) | Out-Null
  $env:PATH = $tools + ';' + $agents + ';' + $env:PATH
  foreach ($product in $Products) {
    $definition = $definitions[$product]
    if (!(Find-ConveroomCommand $definition.command)) {
      Write-Host ('Installing ' + $product + ' from its official npm package.')
      $output = Invoke-ConveroomProgram $node @((Join-Path $tools 'node_modules/npm/bin/npm-cli.js'), 'install', '--global',
        '--prefix', $agents, '--registry', 'https://registry.npmjs.org', '--no-audit', '--no-fund', $definition.npm)
      if ($output) { Write-Host $output }
      if (!(Find-ConveroomCommand $definition.command)) { throw ('Vendor executable unavailable after installing ' + $product) }
    }
  }
  $output = Invoke-ConveroomProgram $node @((Join-Path $Bundle 'runtime/dist/cli.js'), 'setup', '--data-dir', $DataDirectory)
  if ($output) { Write-Host $output }
  $cli = Join-Path $DataDirectory ('runtime/' + $manifest.version + '/dist/cli.js')
  if (![System.IO.File]::Exists($cli)) { throw 'Stable Converoom runtime is missing after setup' }
  $doctor = Invoke-ConveroomProgram $node @($cli, 'doctor', '--data-dir', $DataDirectory) | ConvertFrom-Json
  foreach ($product in $Products) {
    $profile = $doctor.products | Where-Object { $_.product -eq $product } | Select-Object -First 1
    if (!$profile -or !$profile.installed) { throw ('Doctor could not verify ' + $product + '. Native sign-in and vendor acceptance remain separate.') }
  }
  $tailscale = 'skipped for local-only install'
  if (!$LocalOnly) {
    $tailscale = 'unknown'
    try { $tailscale = (Invoke-ConveroomProgram (Find-ConveroomCommand 'tailscale') @('status', '--json') | ConvertFrom-Json).BackendState }
    catch { Write-Host 'Tailscale is installed. Its service or native sign-in needs attention.' }
  }
  $bin = Join-Path $DataDirectory 'bin'
  [System.IO.Directory]::CreateDirectory($bin) | Out-Null
  $launcher = @'
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tools = Join-Path $root 'tools/node-v24.21.0'
$env:PATH = $tools + ';' + (Join-Path $root 'tools/agents') + ';' + $env:PATH
& (Join-Path $tools 'node.exe') (Join-Path $root 'runtime/VERSION/dist/cli.js') @args --data-dir $root
exit $LASTEXITCODE
'@
  [System.IO.File]::WriteAllText((Join-Path $bin 'converoom.ps1'), ($launcher.Replace('VERSION', $manifest.version) + "`n"))
  [System.IO.File]::WriteAllText((Join-Path $bin 'converoom.cmd'), '@powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0converoom.ps1" %*' + "`r`n")
  if (!$NoPath) { Set-ConveroomUserPath @($bin, $tools, $agents) }
  return @{ version = $manifest.version; node = $node; cli = $cli; dataDirectory = $DataDirectory; products = $Products;
    localInstallation = 'verified'; vendorSignIn = 'required or unverified'; tailscale = $tailscale; sharedAccess = 'disabled' }
}

Export-ModuleMember -Function Install-ConveroomBundle,Assert-ConveroomBundle
