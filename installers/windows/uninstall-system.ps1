#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Remove the all-users SPECTRE install so the listen port is free for development.

.DESCRIPTION
  Stops any SPECTRE node/Electron process, deletes Scheduled Task + HKLM Run
  autostart, removes Start Menu shortcuts (all-users + current user), clears
  uninstall registry, deletes C:\Program Files\SPECTRE\, and removes the
  desktop workaround launcher if present.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\installers\windows\uninstall-system.ps1
#>
[CmdletBinding()]
param(
  [switch]$KeepProgramData
)

$ErrorActionPreference = 'Stop'

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  throw 'Run elevated (Run as Administrator) to uninstall the system SPECTRE service.'
}

Write-Host '==> Uninstalling system SPECTRE (free listen port for development)'

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'SPECTRE|Program Files\\SPECTRE|server\\dist\\src\\index|server/dist/src/index' } |
  ForEach-Object {
    Write-Host "    Stopping PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    if ($_.Path -match 'SPECTRE|pip-shell|spectre-pip-shell') {
      Write-Host "    Stopping Electron PID $($_.Id)"
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

schtasks /Delete /TN 'SPECTRE' /F 2>$null | Out-Null
Remove-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'SPECTRE' -ErrorAction SilentlyContinue
Remove-Item -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SPECTRE' -Recurse -Force -ErrorAction SilentlyContinue

foreach ($sm in @(
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\SPECTRE'),
  (Join-Path $env:AppData 'Microsoft\Windows\Start Menu\Programs\SPECTRE')
)) {
  if (Test-Path $sm) {
    Write-Host "    Removing Start Menu: $sm"
    Remove-Item $sm -Recurse -Force
  }
}

$desktopWorkaround = Join-Path $env:USERPROFILE 'Desktop\Start SPECTRE (fixed).cmd'
if (Test-Path $desktopWorkaround) {
  Write-Host "    Removing $desktopWorkaround"
  Remove-Item $desktopWorkaround -Force
}

$inst = Join-Path ${env:ProgramFiles} 'SPECTRE'
if (Test-Path $inst) {
  Write-Host "    Removing $inst"
  Start-Sleep -Seconds 1
  Remove-Item -LiteralPath $inst -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $inst) { cmd /c "rmdir /s /q `"$inst`"" | Out-Null }
}

if (-not $KeepProgramData -and (Test-Path 'C:\ProgramData\SpectrePT')) {
  Write-Host '    Left C:\ProgramData\SpectrePT (config/presets). Delete manually if you want a factory reset.'
}

Write-Host ''
Write-Host 'System SPECTRE removed — listen port is free for development.'
Write-Host '  npm run server:build && npm run server:start'
Write-Host '  Open the console on the configured listen port (default 9000)'
Write-Host ''
Write-Host 'Re-install later: .\release\SPECTRE-Setup.exe'
