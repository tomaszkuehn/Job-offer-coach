# GEM tray launcher - starts/stops/monitors the app server (port 3000)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$gemDir = 'D:\kody\GEM'
$gemUrl = 'http://localhost:3000'
$script:running = $true

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'GEMTrayLauncher', [ref]$created)
if (-not $created) { exit }

function Test-GemRunning {
  try {
    $r = Invoke-WebRequest -Uri $gemUrl -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Start-Gem {
  $c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  if ($c) {
    Stop-Process -Id $c[0].OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
  }
  Start-Process node -ArgumentList 'server.js' -WorkingDirectory $gemDir -WindowStyle Minimized
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-GemRunning) { return $true }
  }
  return $false
}

function Stop-Gem {
  $c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  if ($c) { Stop-Process -Id $c[0].OwningProcess -Force -ErrorAction SilentlyContinue }
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
$notify.Icon = $iconOn
$notify.Text = 'GEM - running'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = $menu.Items.Add('Open GEM')
$openItem.add_Click({ Start-Process $gemUrl })

$restartItem = $menu.Items.Add('Start / Restart server')
$restartItem.add_Click({
  if (Start-Gem) { $script:running = $true; $script:notify.Icon = $script:iconOn; $script:notify.Text = 'GEM - running' }
  else { $script:running = $false; $script:notify.Icon = $script:iconOff; $script:notify.Text = 'GEM - stopped' }
})

$stopItem = $menu.Items.Add('Stop server')
$stopItem.add_Click({
  Stop-Gem
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
  if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-Process $gemUrl }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  $up = Test-GemRunning
  if ($up -ne $script:running) {
    $script:running = $up
    if ($up) { $script:notify.Icon = $script:iconOn; $script:notify.Text = 'GEM - running' }
    else { $script:notify.Icon = $script:iconOff; $script:notify.Text = 'GEM - stopped' }
  }
})
$timer.Start()

if (-not (Test-GemRunning)) { Start-Gem | Out-Null }

[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
$mutex.ReleaseMutex()