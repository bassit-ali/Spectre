#Requires -Version 5.1
<#
.SYNOPSIS
  Copy pip-shell sources into a payload and npm-install Electron for the overlay.
  Supports cross-packing Linux Electron from a Windows host via npm_config_platform/arch.
#>
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][string]$PayloadDir,
  [switch]$SkipElectronInstall,
  # Host default when omitted. Use linux + x64/arm64 when packaging Linux archives on Windows.
  [ValidateSet('win32', 'linux', 'darwin')]
  [string]$TargetPlatform = '',
  [ValidateSet('x64', 'arm64', 'ia32')]
  [string]$TargetArch = ''
)

$ErrorActionPreference = 'Stop'
$src = Join-Path $RepoRoot 'pip-shell'
$dst = Join-Path $PayloadDir 'pip-shell'
if (-not (Test-Path (Join-Path $src 'main.js'))) {
  throw "pip-shell main.js missing at $src"
}

function Remove-TreeRobust([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  $parent = Split-Path -Parent $Path
  $bakName = "_trash_" + [guid]::NewGuid().ToString('N').Substring(0, 8)
  $bak = Join-Path $parent $bakName
  try {
    Rename-Item -LiteralPath $Path -NewName $bakName -ErrorAction Stop
    Start-Process -WindowStyle Hidden -FilePath cmd -ArgumentList '/c', "rmdir /s /q `"$bak`"" | Out-Null
    return $true
  } catch {
    $empty = Join-Path $env:TEMP ("spectre_empty_" + $PID)
    New-Item -ItemType Directory -Force -Path $empty | Out-Null
    robocopy $empty $Path /MIR /NFL /NDL /NJH /NJS /nc /ns /np /R:1 /W:1 | Out-Null
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $empty -Force -ErrorAction SilentlyContinue
  }
  return -not (Test-Path -LiteralPath $Path)
}

function Test-ElectronBinary([string]$PipDir, [string]$Platform) {
  $dist = Join-Path $PipDir 'node_modules\electron\dist'
  if ($Platform -eq 'win32') {
    return Test-Path (Join-Path $dist 'electron.exe')
  }
  if ($Platform -eq 'linux' -or $Platform -eq 'darwin') {
    return Test-Path (Join-Path $dist 'electron')
  }
  # Unknown: accept either
  return (Test-Path (Join-Path $dist 'electron.exe')) -or (Test-Path (Join-Path $dist 'electron'))
}

$cleared = Remove-TreeRobust $dst
if (-not $cleared) {
  Write-Warning "pip-shell path is locked — refreshing overlay sources in place (Electron binary reused if present)."
}
New-Item -ItemType Directory -Force -Path $dst | Out-Null

Copy-Item (Join-Path $src 'main.js') $dst -Force
Copy-Item (Join-Path $src 'preload.js') $dst -Force
# Ship Electron as a runtime dependency (not only a local devDependency).
$pkg = @{
  name = 'spectre-pip-shell'
  version = '1.0.0'
  private = $true
  description = 'SPECTRE always-on-top widget overlay'
  main = 'main.js'
  dependencies = @{
    electron = '^33.2.0'
  }
} | ConvertTo-Json -Depth 5
Set-Content -Path (Join-Path $dst 'package.json') -Value $pkg -Encoding UTF8

if (-not $TargetPlatform) {
  $TargetPlatform = if ($IsLinux) { 'linux' } elseif ($IsMacOS) { 'darwin' } else { 'win32' }
}
if (-not $TargetArch) {
  $TargetArch = if ($env:PROCESSOR_ARCHITECTURE -match 'ARM') { 'arm64' } else { 'x64' }
}

$hasElectron = Test-ElectronBinary $dst $TargetPlatform

if (-not $SkipElectronInstall -and -not $hasElectron) {
  Write-Host "==> Installing Electron into payload/pip-shell ($TargetPlatform-$TargetArch)"
  Push-Location $dst
  $prevPlatform = $env:npm_config_platform
  $prevArch = $env:npm_config_arch
  $prevTargetArch = $env:npm_config_target_arch
  $prevElectronPlatform = $env:npm_config_electron_platform
  try {
    $env:npm_config_platform = $TargetPlatform
    $env:npm_config_arch = $TargetArch
    $env:npm_config_target_arch = $TargetArch
    # electron/@electron/get honor these for the download zip
    $env:npm_config_electron_platform = $TargetPlatform
    npm install --omit=dev --no-audit --no-fund
  } finally {
    if ($null -eq $prevPlatform) { Remove-Item Env:npm_config_platform -ErrorAction SilentlyContinue } else { $env:npm_config_platform = $prevPlatform }
    if ($null -eq $prevArch) { Remove-Item Env:npm_config_arch -ErrorAction SilentlyContinue } else { $env:npm_config_arch = $prevArch }
    if ($null -eq $prevTargetArch) { Remove-Item Env:npm_config_target_arch -ErrorAction SilentlyContinue } else { $env:npm_config_target_arch = $prevTargetArch }
    if ($null -eq $prevElectronPlatform) { Remove-Item Env:npm_config_electron_platform -ErrorAction SilentlyContinue } else { $env:npm_config_electron_platform = $prevElectronPlatform }
    Pop-Location
  }
  $hasElectron = Test-ElectronBinary $dst $TargetPlatform
  if (-not $hasElectron) {
    throw "Electron binary missing after npm install for $TargetPlatform-$TargetArch under $dst"
  }
} elseif ($hasElectron) {
  Write-Host '    Electron binary already present — skipping npm install'
} elseif ($SkipElectronInstall) {
  Write-Host '    SkipElectronInstall — overlay binary not staged (browser widget still works)'
}

Write-Host "    pip-shell staged at $dst"
