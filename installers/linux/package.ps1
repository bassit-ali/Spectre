<#
.SYNOPSIS
  Stage SPECTRE Linux payloads and create tar.gz archives under release/
  (Windows-friendly companion to package.sh)
  
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$Version = '1.1.4',
  [switch]$SkipBuild,
  [ValidateSet('x64', 'arm64', 'both')]
  [string]$Arch = 'both'
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$release = Join-Path $RepoRoot 'release'
$scriptDir = $PSScriptRoot

Write-Host '==> SPECTRE Linux package'

Push-Location $RepoRoot
try {
  if (-not $SkipBuild) {
    Write-Host '==> Building web'
    Push-Location (Join-Path $RepoRoot 'web')
    try {
      if (-not (Test-Path 'node_modules')) { npm install }
      npm run build
    } finally { Pop-Location }
    Write-Host '==> Building server'
    npm run server:build
  }

  $arches = if ($Arch -eq 'both') { @('x64', 'arm64') } else { @($Arch) }

  foreach ($a in $arches) {
    $payload = Join-Path $release "linux\payload-$a"
    Write-Host "==> Staging $payload"
    if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Join-Path $payload 'server'), (Join-Path $payload 'web') | Out-Null

    Copy-Item (Join-Path $RepoRoot 'server\dist') (Join-Path $payload 'server\dist') -Recurse -Force
    Copy-Item (Join-Path $RepoRoot 'web\dist') (Join-Path $payload 'web\dist') -Recurse -Force
    Copy-Item (Join-Path $scriptDir 'spectre.sh') (Join-Path $payload 'spectre.sh') -Force
    Copy-Item (Join-Path $scriptDir 'spectre.service') (Join-Path $payload 'spectre.service') -Force
    Copy-Item (Join-Path $scriptDir 'install.sh') (Join-Path $payload 'install.sh') -Force

    # Official Node binary for this arch (offline — no system Node required)
    $nodePlat = if ($a -eq 'arm64') { 'linux-arm64' } else { 'linux-x64' }
    & (Join-Path $RepoRoot 'installers\common\bundle-node-runtime.ps1') -Platform $nodePlat -PayloadDir $payload

    # Stage pip-shell + Electron binary for this Linux arch (offline — no npm at install time)
    & (Join-Path $RepoRoot 'installers\common\stage-pip-shell.ps1') `
      -RepoRoot $RepoRoot -PayloadDir $payload -TargetPlatform linux -TargetArch $a

    $pkg = @{
      name = 'spectre'
      version = $Version
      private = $true
      description = 'SPECTRE local web service'
      main = 'server/dist/src/index.js'
      dependencies = @{
        '@fastify/static' = '^10.1.10'
        'fastify' = '^5.12.8'
        'serialport' = '^12.0.0'
        'ws' = '^8.22.2'
      }
    } | ConvertTo-Json -Depth 5
    Set-Content -Path (Join-Path $payload 'package.json') -Value $pkg -Encoding UTF8

    Write-Host "==> npm install --omit=dev ($a) [linux prebuilds]"
    Push-Location $payload
    try {
      # Fetch Linux native bindings even when packaging on Windows
      $env:npm_config_platform = 'linux'
      $env:npm_config_arch = $(if ($a -eq 'arm64') { 'arm64' } else { 'x64' })
      $env:npm_config_target_arch = $env:npm_config_arch
      # --ignore-scripts: avoid node-gyp-build spawn EINVAL when cross-packing on Windows.
      # Prebuilds still download via npm_config_platform/arch; rebuild on-device if needed.
      npm install --omit=dev --no-audit --no-fund --ignore-scripts
    } finally {
      Remove-Item Env:npm_config_platform -ErrorAction SilentlyContinue
      Remove-Item Env:npm_config_arch -ErrorAction SilentlyContinue
      Remove-Item Env:npm_config_target_arch -ErrorAction SilentlyContinue
      Pop-Location
    }

    $hostArch = $env:PROCESSOR_ARCHITECTURE
    $note = @"
SPECTRE Linux payload arch label: $a
Build host: $hostArch
Bundled offline runtime:
  - Node: runtime/bin/node
  - npm deps + serialport Linux prebuild
  - Electron overlay: pip-shell/node_modules/electron

No system Node/npm required. USB-serial kernel driver is still an OS concern.

If serialport fails to load after a rare ABI mismatch:

  cd /opt/spectre
  PATH="`$PWD/runtime/bin:`$PATH" npm rebuild serialport
  sudo systemctl restart spectre.service
"@
    Set-Content -Path (Join-Path $payload 'ARCH.txt') -Value $note -Encoding UTF8

    $readme = @"
SPECTRE — Linux ($a)

Fully offline install (Node + npm deps + Electron bundled):
  sudo ./install.sh

Installs to /opt/spectre, enables systemd unit spectre.service, starts service.
Open: http://127.0.0.1:9000/
Desktop overlay uses the packaged Electron binary when a display session is available.
Browser widget always works on the listen port.
"@
    Set-Content -Path (Join-Path $payload 'README.txt') -Value $readme -Encoding UTF8

    $verifyKind = if ($a -eq 'arm64') { 'linux-arm64' } else { 'linux-x64' }
    & (Join-Path $RepoRoot 'installers\common\verify-payload.ps1') -PayloadDir $payload -Kind $verifyKind

    $outTgz = Join-Path $release "spectre-linux-$a.tar.gz"
    $stage = Join-Path $release "linux\_stage_$a"
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Copy-Item $payload (Join-Path $stage 'spectre') -Recurse -Force
    if (Test-Path $outTgz) { Remove-Item $outTgz -Force }
    Push-Location $stage
    try {
      tar -czf $outTgz spectre
    } finally { Pop-Location }
    Remove-Item $stage -Recurse -Force
    Write-Host "    Created $outTgz"
  }

  # Generic payload alias (last arch wins visually; copy x64 preferably)
  $generic = Join-Path $release 'linux\payload'
  $prefer = Join-Path $release 'linux\payload-x64'
  if (-not (Test-Path $prefer)) { $prefer = Join-Path $release "linux\payload-$($arches[0])" }
  if (Test-Path $generic) { Remove-Item $generic -Recurse -Force }
  Copy-Item $prefer $generic -Recurse -Force

  Write-Host 'Done.'
} finally {
  Pop-Location
}
