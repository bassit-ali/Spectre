<#
.SYNOPSIS
  Stage SPECTRE Linux payloads and create tar.gz archives under release/
  (Windows-friendly companion to package.sh)
  Developed by 26 Sig Bn R&D Wing
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$Version = '1.1.0',
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
Write-Host '    Developed by 26 Sig Bn R&D Wing'

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

    # Stage pip-shell sources; Electron native binary is installed on-target by install.sh
    & (Join-Path $RepoRoot 'installers\common\stage-pip-shell.ps1') -RepoRoot $RepoRoot -PayloadDir $payload -SkipElectronInstall

    $pkg = @{
      name = 'spectre'
      version = $Version
      private = $true
      description = 'SPECTRE local web service — Developed by 26 Sig Bn R&D Wing'
      main = 'server/dist/src/index.js'
      dependencies = @{
        '@fastify/static' = '^10.1.10'
        'fastify' = '^5.12.8'
        'serialport' = '^12.0.0'
        'ws' = '^8.22.2'
      }
    } | ConvertTo-Json -Depth 5
    Set-Content -Path (Join-Path $payload 'package.json') -Value $pkg -Encoding UTF8

    Write-Host "==> npm install --omit=dev ($a)"
    Push-Location $payload
    try { npm install --omit=dev --no-audit --no-fund } finally { Pop-Location }

    $hostArch = $env:PROCESSOR_ARCHITECTURE
    $note = @"
SPECTRE Linux payload arch label: $a
Build host: $hostArch (windows)
Developed by 26 Sig Bn R&D Wing

If this archive was produced on Windows or a different CPU than the target,
re-run on the Linux target after extract/install:

  cd /opt/spectre
  npm rebuild serialport
  sudo systemctl restart spectre.service

Cross-build note: arm64 and x64 archives from this Windows packager share the
same JS payload; native serialport bindings must be rebuilt on-device.
"@
    Set-Content -Path (Join-Path $payload 'ARCH.txt') -Value $note -Encoding UTF8

    $readme = @"
SPECTRE — Linux ($a)
Developed by 26 Sig Bn R&D Wing

One-command install:
  sudo ./install.sh

Installs to /opt/spectre, enables systemd unit spectre.service, starts service.
Open: http://127.0.0.1:9000/

Prerequisite: Node.js LTS on PATH.
Desktop overlay: install.sh also runs npm install in pip-shell/ when a display is available.
Browser widget always works at http://127.0.0.1:9000/widget.html
"@
    Set-Content -Path (Join-Path $payload 'README.txt') -Value $readme -Encoding UTF8

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
