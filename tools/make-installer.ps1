# Builds dist\GEM-Setup-<version>.zip: the app + installer runnable from install.cmd
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("GEM-stage-" + [guid]::NewGuid().ToString('N'))
$outZip = Join-Path $dist "GEM-Setup-$version.zip"

New-Item -ItemType Directory -Path (Join-Path $stage 'app') -Force | Out-Null

# app payload (no node_modules, no data, no dist/ijfw/moje_dok)
foreach ($item in @('server.js', 'package.json', 'package-lock.json', 'public', 'tools')) {
  $from = Join-Path $root $item
  if (Test-Path $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $stage 'app') -Recurse -Force }
}
Copy-Item -LiteralPath (Join-Path $root 'tray-app.ps1') -Destination (Join-Path $stage 'app') -Force

# installer + launcher on the zip root
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Destination $stage -Force
Set-Content -LiteralPath (Join-Path $stage 'install.cmd') -Value '@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -InstallDir "%LOCALAPPDATA%\GEM"
pause' -Encoding ASCII
Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination (Join-Path $stage 'README.txt') -Force

if (Test-Path $outZip) { Remove-Item $outZip -Force }
New-Item -ItemType Directory -Path $dist -Force | Out-Null
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $outZip -CompressionLevel Optimal
Remove-Item -LiteralPath $stage -Recurse -Force

$size = '{0:N1} MB' -f ((Get-Item $outZip).Length / 1MB)
Write-Host "Built $outZip ($size)"
