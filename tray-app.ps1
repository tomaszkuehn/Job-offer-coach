# GEM tray launcher - starts/stops/monitors the app server (port 3000)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Hardcoded dir is a dev-machine convenience; the installed copy falls back
# to its own directory (installer ships the tray next to server.js).
$gemDir = 'D:\kody\GEM'
if (-not (Test-Path (Join-Path $gemDir 'server.js'))) { $gemDir = $PSScriptRoot }
$gemUrl = 'http://localhost:3000'
$script:running = $true
$script:wantRunning = $true
$script:failCount = 0
$script:restartAttempts = 0
$script:trayLog = Join-Path $env:TEMP 'GEM-tray.log'

function Write-TrayLog([string]$msg) {
  try { Add-Content -LiteralPath $script:trayLog -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $msg) -ErrorAction SilentlyContinue } catch {}
}

function Get-NodeExe {
  $c = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($c -and $c.Source) { return $c.Source }
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c -and $c.Source) { return $c.Source }
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
  # last resort: search nvm version dirs
  $roots = @($env:NVM_HOME, (Join-Path $env:APPDATA 'nvm'), (Join-Path $env:LOCALAPPDATA 'Author Software\nvm')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  foreach ($root in $roots) {
    $hit = Get-ChildItem -LiteralPath $root -Filter node.exe -Recurse -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$script:nodeExe = Get-NodeExe
Write-TrayLog ("tray started; nodeExe=" + ($script:nodeExe | Out-String).Trim())

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'GEMTrayLauncher', [ref]$created)
if (-not $created) { exit }

function Test-GemRunning {
  try {
    # Generous timeout: a busy server (long bulk run) must not be mistaken for
    # a dead one. Restarts are additionally gated on 3 consecutive failures.
    $r = Invoke-WebRequest -Uri $gemUrl -UseBasicParsing -TimeoutSec 8
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Start-Gem {
  if (Test-GemRunning) { Write-TrayLog 'Start-Gem: server already responds - not restarting'; return $true }
  if (-not $script:nodeExe) {
    Write-TrayLog 'Start-Gem: node.exe not found (not in PATH nor in standard install locations)'
    return $false
  }
  $c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  if ($c) {
    Write-TrayLog ('Start-Gem: killing unresponsive process ' + $c[0].OwningProcess + ' on port 3000')
    Stop-Process -Id $c[0].OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
  }
  try {
    Start-Process -FilePath $script:nodeExe -ArgumentList 'server.js' -WorkingDirectory $script:gemDir -WindowStyle Minimized -ErrorAction Stop
    Write-TrayLog 'Start-Gem: node process launched'
  } catch {
    Write-TrayLog ('Start-Gem: Start-Process failed: ' + $_.Exception.Message)
    return $false
  }
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-GemRunning) { Write-TrayLog 'Start-Gem: server is up'; return $true }
  }
  Write-TrayLog 'Start-Gem: server did not respond within 10s'
  return $false
}

function Stop-Gem {
  $c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  if ($c) { Stop-Process -Id $c[0].OwningProcess -Force -ErrorAction SilentlyContinue }
}

function Open-Gem {
  if ($script:wantRunning -and -not (Test-GemRunning)) {
    if (Start-Gem) {
      $script:running = $true
      $script:failCount = 0
      $script:notify.Icon = $script:iconOn
      $script:notify.Text = 'GEM - running'
    }
  }
  Start-Process $script:gemUrl
}

function New-GemIcon([System.Drawing.Color]$color) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $b = New-Object System.Drawing.SolidBrush $color
  $g.FillEllipse($b, 1, 1, 30, 30)
  $font = New-Object System.Drawing.Font 'Segoe UI', 13, ([System.Drawing.FontStyle]::Bold)
  $g.DrawString('G', $font, [System.Drawing.Brushes]::White, 8, 5)
  $g.Dispose(); $b.Dispose(); $font.Dispose()
  $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $bmp.Dispose()
  return $ico
}

$iconOn = New-GemIcon ([System.Drawing.Color]::FromArgb(34, 197, 94))
$iconOff = New-GemIcon ([System.Drawing.Color]::FromArgb(239, 68, 68))

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $iconOff
$notify.Text = 'GEM - starting...'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = $menu.Items.Add('Open GEM')
$openItem.add_Click({ Open-Gem })

$restartItem = $menu.Items.Add('Start / Restart server')
$restartItem.add_Click({
  $script:wantRunning = $true
  $script:failCount = 0
  $script:restartAttempts = 0
  if (Start-Gem) { $script:running = $true; $script:notify.Icon = $script:iconOn; $script:notify.Text = 'GEM - running' }
  else {
    $script:running = $false; $script:notify.Icon = $script:iconOff; $script:notify.Text = 'GEM - stopped'
    $script:notify.ShowBalloonTip(5000, 'GEM', 'Could not start server - details in %TEMP%\GEM-tray.log', [System.Windows.Forms.ToolTipIcon]::Error)
  }
})

$stopItem = $menu.Items.Add('Stop server')
$stopItem.add_Click({
  Stop-Gem
  $script:wantRunning = $false
  $script:running = $false
  $script:notify.Icon = $script:iconOff
  $script:notify.Text = 'GEM - stopped'
})

$menu.Items.Add('-') | Out-Null

$exitItem = $menu.Items.Add('Exit tray')
$exitItem.add_Click({
  $script:timer.Stop()
  $script:notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.add_Click({
  if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Gem }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  $up = Test-GemRunning
  if ($up) {
    if ($script:failCount -gt 0) {
      Write-TrayLog ('health restored after ' + $script:failCount + ' failed check(s) - no restart performed')
    }
    $script:failCount = 0
    $script:restartAttempts = 0
    if (-not $script:running) {
      $script:running = $true
      $script:notify.Icon = $script:iconOn
      $script:notify.Text = 'GEM - running'
    }
    return
  }
  if ($script:running) {
    $script:running = $false
    $script:notify.Icon = $script:iconOff
    $script:notify.Text = 'GEM - stopped'
  }
  $script:failCount++
  Write-TrayLog ('health check failed (' + $script:failCount + '/3)')
  if (-not $script:wantRunning) { return }
  # A slow check is not a crash: require 3 consecutive failures (~15 s) before
  # touching the process. A bulk run keeps the server busy for minutes.
  if ($script:failCount -lt 3) { return }
  if (Start-Gem) {
    $script:running = $true
    $script:failCount = 0
    $script:restartAttempts = 0
    $script:notify.Icon = $script:iconOn
    $script:notify.Text = 'GEM - running'
    $script:notify.ShowBalloonTip(5000, 'GEM', 'Server was down - restarted automatically', [System.Windows.Forms.ToolTipIcon]::Info)
  } else {
    $script:restartAttempts++
    if ($script:restartAttempts -ge 3) {
      $script:wantRunning = $false
      $script:notify.ShowBalloonTip(5000, 'GEM', 'Could not restart server - right-click the icon and use Start / Restart server (details in %TEMP%\GEM-tray.log)', [System.Windows.Forms.ToolTipIcon]::Error)
    }
  }
})
$timer.Start()

# Honest initial state: reflect reality instead of assuming "running".
$script:running = Test-GemRunning
if (-not $script:running) { $script:running = Start-Gem }
$notify.Icon = if ($script:running) { $iconOn } else { $iconOff }
$notify.Text = if ($script:running) { 'GEM - running' } else { 'GEM - stopped' }
if (-not $script:running) {
  $notify.ShowBalloonTip(5000, 'GEM', 'Could not start server - details in %TEMP%\GEM-tray.log', [System.Windows.Forms.ToolTipIcon]::Error)
}

[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
$mutex.ReleaseMutex()