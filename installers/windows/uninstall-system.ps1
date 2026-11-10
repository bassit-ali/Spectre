#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Remove the all-users SPECTRE install so development on :9000 is clean.
  Developed by 26 Sig Bn R&D Wing

.DESCRIPTION
  Stops any SPECTRE node process, deletes Scheduled Task + HKLM Run autostart,
  removes Start Menu shortcuts, and deletes C:\Program Files\SPECTRE\.

  Use this before `npm run server:start` / local regression if the installer
  was previously run on this machine.

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

Write-Host '==> Uninstalling system SPECTRE (free :9000 for development)'
Write-Host '    Developed by 26 Sig Bn R&D Wing'

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'SPECTRE|Program Files\\SPECTRE|server\\dist\\src\\index|server/dist/src/index' } |
  ForEach-Object {
    Write-Host "    Stopping PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

schtasks /Delete /TN 'SPECTRE' /F 2>$null | Out-Null
Remove-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'SPECTRE' -ErrorAction SilentlyContinue

$sm = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\SPECTRE'
if (Test-Path $sm) { Remove-Item $sm -Recurse -Force }

$inst = Join-Path ${env:ProgramFiles} 'SPECTRE'
if (Test-Path $inst) {
  Start-Sleep -Seconds 1
  Remove-Item -LiteralPath $inst -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $inst) { cmd /c "rmdir /s /q `"$inst`"" | Out-Null }
}

if (-not $KeepProgramData -and (Test-Path 'C:\ProgramData\SpectrePT')) {
  Write-Host '    Left C:\ProgramData\SpectrePT (config/presets). Delete manually if you want a factory reset.'
}

Write-Host ''
Write-Host 'System SPECTRE removed — :9000 is free for development.'
Write-Host '  npm run server:build && npm run server:start'
Write-Host '  http://127.0.0.1:9000/'
Write-Host ''
Write-Host 'Re-install later: .\release\SPECTRE-Setup.exe'
