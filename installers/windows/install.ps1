#Requires -RunAsAdministrator
<#
.SYNOPSIS
  SPECTRE all-users installer (Program Files + autostart).

.DESCRIPTION
  Copies the staged payload to C:\Program Files\SPECTRE\, creates Start Menu
  shortcuts, registers HKLM Run (user logon) autostart so the desktop overlay
  can appear, starts the service, and opens the local console (default port 9000).
#>
[CmdletBinding()]
param(
  [string]$PayloadDir = '',
  [string]$InstallDir = $(Join-Path ${env:ProgramFiles} 'SPECTRE'),
  [switch]$SkipLaunch
)

$ErrorActionPreference = 'Stop'
$ProductName = 'SPECTRE'
$Publisher = 'SPECTRE'
$Tagline = 'SPECTRE pan/tilt pedestal controller'
$Url = 'http://127.0.0.1:9000/'
$TaskName = 'SPECTRE'

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  throw 'Run install.ps1 elevated (Run as Administrator) for all-users install.'
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $PayloadDir) {
  $candidates = @(
    $scriptDir,
    (Join-Path $scriptDir 'payload'),
    (Join-Path $scriptDir '..\..\release\windows\payload-clean'),
    (Join-Path $scriptDir '..\..\release\windows\payload'),
    (Join-Path $scriptDir '..\windows\payload-clean'),
    (Join-Path $scriptDir '..\windows\payload')
  )
  foreach ($c in $candidates) {
    $resolved = Resolve-Path $c -ErrorAction SilentlyContinue
    if ($resolved -and (Test-Path (Join-Path $resolved 'server\dist\src\index.js'))) {
      $PayloadDir = $resolved.Path
      break
    }
  }
}

if (-not $PayloadDir -or -not (Test-Path (Join-Path $PayloadDir 'server\dist\src\index.js'))) {
  throw "SPECTRE payload not found. Expected server\dist\src\index.js under payload. Got: $PayloadDir"
}

$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) { $nodeOk = $true }
elseif (Test-Path (Join-Path $PayloadDir 'runtime\node.exe')) { $nodeOk = $true }
if (-not $nodeOk) {
  Write-Warning 'Node.js not detected on PATH and no runtime\node.exe in payload. Install Node.js LTS before starting SPECTRE.'
}

Write-Host "==> Installing $ProductName"
Write-Host "    From: $PayloadDir"
Write-Host "    To:   $InstallDir"
Write-Host "    $Tagline"

# Stop previous SPECTRE node + overlay processes
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'SPECTRE|spectre|server\\dist\\src\\index' } |
  ForEach-Object {
    Write-Host "    Stopping PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object {
    try { $_.Path -match 'SPECTRE|pip-shell|spectre-pip-shell' } catch { $false }
  } |
  ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $PayloadDir '*') -Destination $InstallDir -Recurse -Force

$launcher = Join-Path $InstallDir 'spectre.cmd'
if (-not (Test-Path $launcher)) {
  throw "spectre.cmd missing after copy ($launcher)"
}

Set-Content -Path (Join-Path $InstallDir 'BRANDING.txt') -Encoding UTF8 -Value @(
  $ProductName
  $Tagline
  'Local web service: available on port 9000 (or saved httpPort)'
)

# Start Menu (all users)
$startMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\SPECTRE'
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
$w = New-Object -ComObject WScript.Shell

$sc = $w.CreateShortcut((Join-Path $startMenu 'SPECTRE Service.lnk'))
$sc.TargetPath = $launcher
$sc.WorkingDirectory = $InstallDir
$sc.WindowStyle = 7
$sc.Description = $Tagline
$sc.Save()

$sc2 = $w.CreateShortcut((Join-Path $startMenu 'Open SPECTRE Console.lnk'))
$sc2.TargetPath = $Url
$sc2.Description = 'Open SPECTRE web console'
$sc2.Save()

# HKLM Run — all users at logon (user session so Electron overlay can appear).
# Do NOT also register a SYSTEM ONSTART task: it races for :9000 and cannot show UI.
$runKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
New-ItemProperty -Path $runKey -Name $ProductName -Value "`"$launcher`"" -PropertyType String -Force | Out-Null
# Remove legacy SYSTEM task from older installers if present
schtasks /Delete /TN $TaskName /F 2>$null | Out-Null

$nodeAbs = $null
foreach ($cand in @(
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  (Join-Path ${env:ProgramFiles} 'nodejs\node.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
  (Join-Path $InstallDir 'runtime\node.exe')
)) {
  if ($cand -and (Test-Path -LiteralPath $cand)) { $nodeAbs = $cand; break }
}
if ($nodeAbs) {
  Set-Content -Path (Join-Path $InstallDir 'node.path.txt') -Value $nodeAbs -Encoding ASCII
}

# Uninstall helper
$uninstallPs1 = @'
$ErrorActionPreference = "Stop"
$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
schtasks /Delete /TN "SPECTRE" /F 2>$null | Out-Null
Remove-ItemProperty -Path "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "SPECTRE" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match "SPECTRE|spectre|server\\dist\\src\\index" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    if ($_.Path -match "SPECTRE|pip-shell") { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  } catch {}
}
$sm = Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\SPECTRE"
if (Test-Path $sm) { Remove-Item $sm -Recurse -Force }
Write-Host "Removing $InstallDir ..."
Start-Sleep -Seconds 1
Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "SPECTRE uninstalled."
'@
Set-Content -Path (Join-Path $InstallDir 'uninstall.ps1') -Value $uninstallPs1 -Encoding UTF8

Write-Host ""
Write-Host "Installed to $InstallDir"
Write-Host "Autostart: HKLM Run (user logon) — desktop overlay enabled"

if (-not $SkipLaunch) {
  Start-Process -FilePath $launcher -WorkingDirectory $InstallDir -WindowStyle Minimized
  Start-Sleep -Seconds 2
  Start-Process $Url
}

Write-Host 'Open: available on port 9000 (or saved httpPort)'
