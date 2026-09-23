# GEM (Job Offer Coach) installer - installs everything needed to run the app:
#   1. Node.js (auto: winget -> portable download fallback, no admin needed)
#   2. App files (server.js, public/, tools/) + npm dependencies
#   3. pandoc via winget (optional, only for the ODT export; -NoPandoc skips)
#   4. Tray launcher + logon autostart + desktop shortcut, waits for the
#      server to answer and opens the app in the browser
# Usage:  powershell -ExecutionPolicy Bypass -File tools\install.ps1 [-InstallDir <path>] [-NoStartup] [-NoStart] [-NoPandoc] [-NoBrowser]
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'GEM'),
  [switch]$NoStartup,
  [switch]$NoStart,
  [switch]$NoPandoc,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'

# App source: zip layout has install.ps1 next to an app\ folder; repo layout
# has this script inside tools\ with server.js one level up.
$src = $PSScriptRoot
if (Test-Path (Join-Path $src 'app\server.js')) { $src = Join-Path $src 'app' }
elseif (-not (Test-Path (Join-Path $src 'server.js'))) { $src = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path (Join-Path $src 'server.js'))) { throw "server.js not found (got: $src)" }

function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
}

function Get-Winget {
  $c = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($c -and $c.Source) { return $c.Source }
  $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
  if (Test-Path -LiteralPath $alias) { return $alias }
  return $null
}

function Get-NodeExe {
  foreach ($name in @('node.exe', 'node')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c -and $c.Source) { return $c.Source }
  }
  # portable Node installed by a previous run of this installer (upgrade path)
  $candidates = @(
    (Join-Path $InstallDir 'node\node.exe'),
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

function Install-NodePortable {
  # Last resort when winget is unavailable: user-scope portable Node inside
  # $InstallDir\node (removed together with the install dir by uninstall.ps1).
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host 'Downloading portable Node.js LTS (no admin rights needed)...'
    $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
    $lts = ($idx | Where-Object { $_.lts } | Select-Object -First 1)
    if (-not $lts) { return $null }
    $url = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-win-x64.zip"
    $zip = Join-Path ([System.IO.Path]::GetTempPath()) ("node-lts-" + [guid]::NewGuid().ToString('N') + '.zip')
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 900
    $dest = Join-Path $InstallDir 'node'
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    $inner = Get-ChildItem -LiteralPath $dest -Directory | Where-Object { $_.Name -like 'node-*-win-x64' } | Select-Object -First 1
    if ($inner -and (Test-Path (Join-Path $inner.FullName 'node.exe'))) {
      $final = Join-Path $dest 'node'
      if (Test-Path -LiteralPath $final) { Remove-Item -LiteralPath $final -Recurse -Force }
      if ($inner.FullName -ne $final) { Move-Item -LiteralPath $inner.FullName -Destination $final -Force }
      return (Join-Path $final 'node.exe')
    }
    return $null
  } catch {
    Write-Warning "Portable Node download failed: $($_.Exception.Message)"
    return $null
  }
}

$winget = Get-Winget
$nodeExe = Get-NodeExe
if (-not $nodeExe) {
  Write-Host 'Node.js not found - installing it automatically...'
  if ($winget) {
    try {
      & $winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent
      Refresh-Path
    } catch {
      Write-Warning "winget Node install failed: $($_.Exception.Message)"
    }
    $nodeExe = Get-NodeExe
  }
  if (-not $nodeExe) { $nodeExe = Install-NodePortable }
}
if (-not $nodeExe) { throw 'Node.js is required but could not be installed automatically. Install it from https://nodejs.org and re-run.' }
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

# --- npm dependencies (npm ci; retry once with npm install) ---
function Invoke-Npm {
  param([string[]]$NpmArgs)
  $npmDir = Split-Path -Parent $nodeExe
  $npmCmd = Join-Path $npmDir 'npm.cmd'
  $npmCli = Join-Path $npmDir 'node_modules\npm\bin\npm-cli.js'
  # Capture output so it does not pollute the return value, but keep it visible
  $out = @()
  if (Test-Path -LiteralPath $npmCmd) { $out = & $npmCmd @NpmArgs 2>&1 }
  elseif (Test-Path -LiteralPath $npmCli) { $out = & $nodeExe $npmCli @NpmArgs 2>&1 }
  elseif (Get-Command npm.cmd -ErrorAction SilentlyContinue) { $out = & npm.cmd @NpmArgs 2>&1 }
  else { throw 'npm not found next to node.exe nor in PATH' }
  $out | ForEach-Object { Write-Host $_ }
  return $LASTEXITCODE
}

Push-Location $InstallDir
try {
  $code = Invoke-Npm @('ci', '--omit=dev')
  if ($code -ne 0) {
    Write-Warning "npm ci failed (exit $code) - retrying with npm install..."
    Remove-Item -LiteralPath (Join-Path $InstallDir 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
    $code = Invoke-Npm @('install', '--omit=dev')
  }
  if ($code -ne 0) { throw "npm install failed (exit $code)" }
} finally { Pop-Location }
Write-Host 'Dependencies installed'

# --- pandoc (optional, only needed for the ODT export) ---
if (-not $NoPandoc) {
  $havePandoc = $false
  try { $null = & pandoc --version 2>$null; $havePandoc = ($LASTEXITCODE -eq 0) } catch { $havePandoc = $false }
  if (-not $havePandoc) {
    $standard = @(
      (Join-Path ${env:ProgramFiles} 'Pandoc\pandoc.exe'),
      (Join-Path $env:LOCALAPPDATA 'Pandoc\pandoc.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($standard) {
      Write-Host "Pandoc found: $standard"
    } elseif ($winget) {
      Write-Host 'Installing pandoc (needed only for the ODT export)...'
      try {
        & $winget install --id JohnMacFarlane.Pandoc -e --accept-source-agreements --accept-package-agreements --silent
        Refresh-Path
        Write-Host 'Pandoc installed'
      } catch {
        Write-Warning 'pandoc could not be installed (only the ODT export will be unavailable; everything else works)'
      }
    } else {
      Write-Warning 'pandoc not found and winget unavailable (only the ODT export will be unavailable; everything else works)'
    }
  }
}

# --- tray script bound to the install dir ---
$traySrc = Get-Content -Raw (Join-Path $src 'tray-app.ps1')
$trayOut = $traySrc.Replace("`$gemDir = 'D:\kody\GEM'", "`$gemDir = '$InstallDir'")
if ($trayOut -eq $traySrc -and $InstallDir -ne 'D:\kody\GEM') { Write-Warning 'Could not rebind gemDir in tray-app.ps1 - tray will self-locate the app dir' }
$trayOut | Set-Content -LiteralPath (Join-Path $InstallDir 'tray-app.ps1') -Encoding UTF8

# --- uninstaller ---
@'
# Removes GEM: stops server + tray, deletes shortcuts and the install dir
$ErrorActionPreference = 'SilentlyContinue'
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'tray-app\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$startup = [System.IO.Path]::Combine([Environment]::GetFolderPath('Startup'), 'GEM Tray.lnk')
if (Test-Path $startup) { Remove-Item $startup -Force }
$desktop = [System.IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'Job Offer Coach.url')
if (Test-Path $desktop) { Remove-Item $desktop -Force }
Remove-Item -LiteralPath $PSScriptRoot -Recurse -Force
'@ | Set-Content -LiteralPath (Join-Path $InstallDir 'uninstall.ps1') -Encoding UTF8

# --- desktop shortcut to the app ---
$desktopUrl = '[InternetShortcut]' + "`r`n" + 'URL=http://localhost:3000' + "`r`n"
Set-Content -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Job Offer Coach.url') -Value $desktopUrl -Encoding ASCII
Write-Host 'Desktop shortcut created (Job Offer Coach)'

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

# --- start now, wait until the server answers, open the browser ---
if (-not $NoStart) {
  Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstallDir\tray-app.ps1`""
  $up = $false
  for ($i = 0; $i -lt 30 -and -not $up; $i++) {
    Start-Sleep -Milliseconds 1000
    try {
      $r = Invoke-WebRequest -Uri 'http://localhost:3000/api/config' -UseBasicParsing -TimeoutSec 2
      $up = ($r.StatusCode -eq 200)
    } catch { $up = $false }
  }
  if ($up) {
    Write-Host 'App is running.'
    if (-not $NoBrowser) { Start-Process 'http://localhost:3000' }
  } else {
    Write-Warning 'App did not respond within 30 s - check %TEMP%\GEM-tray.log'
  }
}

Write-Host "Done. Uninstall: powershell -File `"$InstallDir\uninstall.ps1`""