#Requires -Version 5.1
<#
.SYNOPSIS
  Copy pip-shell sources into a payload and npm-install Electron for the overlay.
#>
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [Parameter(Mandatory = $true)][string]$PayloadDir,
  [switch]$SkipElectronInstall
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

$winElectron = Join-Path $dst 'node_modules\electron\dist\electron.exe'
$nixElectron = Join-Path $dst 'node_modules\electron\dist\electron'
$hasElectron = (Test-Path $winElectron) -or (Test-Path $nixElectron)

if (-not $SkipElectronInstall -and -not $hasElectron) {
  Write-Host '==> Installing Electron into payload/pip-shell'
  Push-Location $dst
  try {
    npm install --omit=dev --no-audit --no-fund
  } finally {
    Pop-Location
  }
  $hasElectron = (Test-Path $winElectron) -or (Test-Path $nixElectron)
  if (-not $hasElectron) {
    Write-Warning 'Electron binary may be missing after npm install — overlay open will fail until fixed.'
  }
} elseif ($hasElectron) {
  Write-Host '    Electron binary already present — skipping npm install'
}

Write-Host "    pip-shell staged at $dst"
