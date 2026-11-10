$ErrorActionPreference = 'Stop'

$installDir = Join-Path $env:LOCALAPPDATA 'PelcoPT'
$startup = [Environment]::GetFolderPath('Startup')
$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'

Get-Process -Name 'PelcoPT' -ErrorAction SilentlyContinue | Stop-Process -Force

Remove-Item -Force (Join-Path $startup 'PelcoPT.lnk') -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $startMenu 'PelcoPT.lnk') -ErrorAction SilentlyContinue
Remove-Item -Property 'PelcoPT' -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue

Write-Host 'PelcoPT removed.'
