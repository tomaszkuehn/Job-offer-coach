# GEM installer - copies the app, installs deps, registers the tray at logon
# Usage:  powershell -ExecutionPolicy Bypass -File tools\install.ps1 [-InstallDir <path>] [-NoStartup] [-NoStart]
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'GEM'),
  [switch]$NoStartup,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $src 'server.js'))) { throw "server.js not found next to tools\ (got: $src)" }

function Get-NodeExe {
  foreach ($name in @('node.exe', 'node')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c -and $c.Source) { return $c.Source }
  }
  $candidates = @(
    (Join-Path ${env:ProgramFiles} 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    'C:\Program Files\nodejs\node.exe'
  )
  if ($env:NVM_SYMLINK) { $candidates += (Join-Path $env:NVM_SYMLINK 'node.exe') }
  if ($env:NVM_HOME) { $candidates += (Join-Path $env:NVM_HOME '.nodejs\node.exe') }
  $candidates += @(
    (Join-Path $env:APPDATA 'nvm\.nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Author Software\nvm\.nodejs\node.exe'),
    (Join-Path $env:APPDATA 'nvm\node.exe')
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  foreach ($root in @($env:NVM_HOME, (Join-Path $env:APPDATA 'nvm'), (Join-Path $env:LOCALAPPDATA 'Author Software\nvm')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }) {
    $hit = Get-ChildItem -LiteralPath $root -Filter node.exe -Recurse -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$nodeExe = Get-NodeExe
if (-not $nodeExe) {
  Write-Host 'Node.js not found.'
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    $yn = Read-Host 'Install Node.js LTS via winget now? [Y/n]'
    if ($yn -notmatch '^n') {
      & $winget.Source install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
      $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
      $nodeExe = Get-NodeExe
    }
  }
}
if (-not $nodeExe) { throw 'Node.js is required but was not found. Install it from https://nodejs.org and re-run.' }
Write-Host "Node: $nodeExe"

# --- copy app files (fresh or upgrade; data/ is never overwritten) ---
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$items = @('server.js', 'package.json', 'package-lock.json', 'public', 'tools')
foreach ($item in $items) {
  $from = Join-Path $src $item
  if (-not (Test-Path $from)) { continue }
  Copy-Item -LiteralPath $from -Destination $InstallDir -Recurse -Force
}
Write-Host "App files copied to $InstallDir"

# --- npm dependencies ---
Push-Location $InstallDir
try {
  $npmCmd = Join-Path (Split-Path -Parent $nodeExe) 'npm.cmd'
  $npmCli = Join-Path (Split-Path -Parent $nodeExe) 'node_modules\npm\bin\npm-cli.js'
  if (Test-Path -LiteralPath $npmCmd) { & $npmCmd ci --omit=dev }
  elseif (Test-Path -LiteralPath $npmCli) { & $nodeExe $npmCli ci --omit=dev }
  elseif (Get-Command npm.cmd -ErrorAction SilentlyContinue) { & npm.cmd ci --omit=dev }
  else { throw 'npm not found next to node.exe nor in PATH' }
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }
Write-Host 'Dependencies installed'

# --- tray script bound to the install dir ---
$traySrc = Get-Content -Raw (Join-Path $src 'tray-app.ps1')
$trayOut = $traySrc.Replace("`$gemDir = 'D:\kody\GEM'", "`$gemDir = '$InstallDir'")
if ($trayOut -eq $traySrc -and $InstallDir -ne 'D:\kody\GEM') { Write-Warning 'Could not rebind gemDir in tray-app.ps1 - tray would point at D:\kody\GEM' }
$trayOut | Set-Content -LiteralPath (Join-Path $InstallDir 'tray-app.ps1') -Encoding UTF8

# --- uninstaller ---
@'
# Removes GEM: stops server + tray, deletes startup shortcut and install dir
$ErrorActionPreference = 'SilentlyContinue'
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'tray-app\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$startup = [System.IO.Path]::Combine([Environment]::GetFolderPath('Startup'), 'GEM Tray.lnk')
if (Test-Path $startup) { Remove-Item $startup -Force }
Remove-Item -LiteralPath $PSScriptRoot -Recurse -Force
'@ | Set-Content -LiteralPath (Join-Path $InstallDir 'uninstall.ps1') -Encoding UTF8

# --- logon autostart ---
if (-not $NoStartup) {
  $wsh = New-Object -ComObject WScript.Shell
  $lnk = $wsh.CreateShortcut((Join-Path [Environment]::GetFolderPath('Startup') 'GEM Tray.lnk'))
  $lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstallDir\tray-app.ps1`""
  $lnk.WorkingDirectory = $InstallDir
  $lnk.Save()
  Write-Host 'Startup shortcut created (shell:startup\GEM Tray.lnk)'
}

# --- start now ---
if (-not $NoStart) {
  Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstallDir\tray-app.ps1`""
  Write-Host 'Tray started. App: http://localhost:3000'
}

Write-Host "Done. Uninstall: powershell -File `"$InstallDir\uninstall.ps1`""
