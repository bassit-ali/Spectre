$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @(
  (Join-Path $scriptDir '..\PelcoPT.exe'),
  (Join-Path $scriptDir '..\..\PelcoPT.exe'),
  (Join-Path $scriptDir '..\win-unpacked\PelcoPT.exe'),
  (Join-Path $scriptDir '..\release\win-unpacked\PelcoPT.exe')
)

$exe = $null
foreach ($c in $candidates) {
  $resolved = Resolve-Path $c -ErrorAction SilentlyContinue
  if ($resolved) {
    $exe = Get-Item $resolved
    break
  }
}

if (-not $exe) {
  $searchRoots = @(
    (Resolve-Path (Join-Path $scriptDir '..') -ErrorAction SilentlyContinue),
    (Resolve-Path (Join-Path $scriptDir '..\..') -ErrorAction SilentlyContinue),
    (Resolve-Path (Join-Path $scriptDir '..\release') -ErrorAction SilentlyContinue)
  ) | Where-Object { $_ }
  foreach ($root in $searchRoots) {
    $found = Get-ChildItem -Path $root -Filter 'PelcoPT.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $exe = $found; break }
  }
}

if (-not $exe) {
  throw "PelcoPT.exe not found. Build with 'npm run pack:win' first, or run this from the unpacked release."
}

$sourceDir = $exe.Directory.FullName
$installDir = Join-Path $env:LOCALAPPDATA 'PelcoPT'
$startup = [Environment]::GetFolderPath('Startup')
$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'

Write-Host "==> Installing PelcoPT from $sourceDir"
Write-Host "    to $installDir"

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Path (Join-Path $sourceDir '*') -Destination $installDir -Recurse -Force

$installedExe = Get-ChildItem -Path $installDir -Filter 'PelcoPT.exe' | Select-Object -First 1
if (-not $installedExe) { throw 'PelcoPT.exe missing after copy' }

$w = New-Object -ComObject WScript.Shell
foreach ($shortcutPath in @((Join-Path $startMenu 'PelcoPT.lnk'), (Join-Path $startup 'PelcoPT.lnk'))) {
  $sc = $w.CreateShortcut($shortcutPath)
  $sc.TargetPath = $installedExe.FullName
  $sc.WorkingDirectory = $installedExe.DirectoryName
  $sc.Description = 'Pelco-D pan/tilt controller'
  $sc.Save()
}

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-ItemProperty -Path $runKey -Name 'PelcoPT' -Value "`"$($installedExe.FullName)`"" -PropertyType String -Force | Out-Null

$extSrc = Join-Path $sourceDir 'resources\extension'
if (Test-Path $extSrc) {
  Write-Host "Browser extension available at: $extSrc"
  Write-Host "Chrome/Edge -> chrome://extensions -> Load unpacked"
}

Write-Host ""
Write-Host "Installed. Autostart registered."
Write-Host "Launch: $($installedExe.FullName)"
