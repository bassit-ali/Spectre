#Requires -Version 5.1
<#
.SYNOPSIS
  Build SPECTRE web+server, stage Windows payload, optionally build Setup.exe.
  Developed by 26 Sig Bn R&D Wing
#>
[CmdletBinding()]
param(
  [switch]$SkipNpmInstall,
  [string]$Version = '1.1.1'
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
# Stage into payload-clean so a locked previous payload\ (Electron in use) cannot poison the build.
$Payload = Join-Path $Root 'release\windows\payload-clean'
$Release = Join-Path $Root 'release'

Write-Host "==> SPECTRE Windows build (v$Version)"
Write-Host "    Developed by 26 Sig Bn R&D Wing"
Write-Host "    Root: $Root"

Push-Location $Root
try {
  if (-not $SkipNpmInstall) {
    if (-not (Test-Path (Join-Path $Root 'node_modules'))) { npm install }
    if (-not (Test-Path (Join-Path $Root 'web\node_modules'))) {
      Push-Location (Join-Path $Root 'web'); npm install; Pop-Location
    }
  }

  Write-Host '==> Building web UI'
  Push-Location (Join-Path $Root 'web')
  npm run build
  Pop-Location

  Write-Host '==> Building server'
  npm run server:build

  Write-Host "==> Staging payload -> $Payload"
  if (Test-Path $Payload) {
    $bak = "$Payload.bak_$([guid]::NewGuid().ToString('N').Substring(0,8))"
    try {
      Rename-Item -LiteralPath $Payload -NewName (Split-Path $bak -Leaf) -ErrorAction Stop
      cmd /c "rmdir /s /q `"$bak`"" | Out-Null
    } catch {
      $empty = Join-Path $env:TEMP "spectre_empty_$PID"
      New-Item -ItemType Directory -Force -Path $empty | Out-Null
      robocopy $empty $Payload /MIR /NFL /NDL /NJH /NJS /nc /ns /np /R:1 /W:1 | Out-Null
      Remove-Item -LiteralPath $Payload -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $empty -Force -ErrorAction SilentlyContinue
    }
  }
  New-Item -ItemType Directory -Force -Path $Payload | Out-Null

  Copy-Item (Join-Path $Root 'server\dist') (Join-Path $Payload 'server\dist') -Recurse -Force
  Copy-Item (Join-Path $Root 'server\shared') (Join-Path $Payload 'server\shared') -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $Root 'web\dist') (Join-Path $Payload 'web\dist') -Recurse -Force

  # Desktop overlay (Electron) — required for always-on-top widget
  & (Join-Path $Root 'installers\common\stage-pip-shell.ps1') -RepoRoot $Root -PayloadDir $Payload

  # Runtime package.json (server entry only)
  $pkg = @{
    name = 'spectre'
    version = $Version
    private = $true
    description = 'SPECTRE local pan/tilt web service — Developed by 26 Sig Bn R&D Wing'
    main = 'server/dist/src/index.js'
    dependencies = @{
      '@fastify/static' = '^10.1.10'
      fastify = '^5.12.8'
      serialport = '^12.0.0'
      ws = '^8.22.2'
    }
  } | ConvertTo-Json -Depth 5
  Set-Content -Path (Join-Path $Payload 'package.json') -Value $pkg -Encoding UTF8

  Copy-Item (Join-Path $PSScriptRoot 'spectre.cmd') (Join-Path $Payload 'spectre.cmd') -Force
  Copy-Item (Join-Path $PSScriptRoot 'install.ps1') (Join-Path $Payload 'install.ps1') -Force
  Copy-Item (Join-Path $PSScriptRoot 'install.ps1') (Join-Path $Release 'SPECTRE-install.ps1') -Force
  Set-Content -Path (Join-Path $Payload 'BRANDING.txt') -Encoding UTF8 -Value @(
    'SPECTRE'
    'Developed by 26 Sig Bn R&D Wing'
    'Local web service: http://127.0.0.1:9000/'
    'Desktop overlay: pip-shell\ (Electron)'
    'Requires Node.js LTS on PATH (or place node.exe in runtime\).'
  )
  Set-Content -Path (Join-Path $Payload 'README.txt') -Encoding UTF8 -Value @"
SPECTRE — Windows portable payload v$Version
Developed by 26 Sig Bn R&D Wing

All-users install (Administrator PowerShell):
  .\install.ps1

Installs to C:\Program Files\SPECTRE\, registers logon autostart, opens:
  http://127.0.0.1:9000/
  Desktop widget overlay (pip-shell) when a user session is active.

Manual start: .\spectre.cmd
"@

  Write-Host '==> Installing production node_modules into payload'
  Push-Location $Payload
  npm install --omit=dev --no-audit --no-fund
  # Drop test/docs fluff that breaks Compress-Archive on long/odd paths
  Get-ChildItem -Path (Join-Path $Payload 'node_modules') -Recurse -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @('test','tests','docs','example','examples','.github') } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  Pop-Location

  $zip = Join-Path $Release 'SPECTRE-windows-x64-portable.zip'
  $zipVer = Join-Path $Release "SPECTRE-windows-x64-v$Version.zip"
  foreach ($z in @($zip, $zipVer)) { if (Test-Path $z) { Remove-Item $z -Force } }
  # Prefer tar (handles long paths); fall back to Compress-Archive
  $tar = Get-Command tar -ErrorAction SilentlyContinue
  if ($tar) {
    Push-Location $Payload
    & tar -a -cf $zip *
    Pop-Location
  } else {
    Compress-Archive -Path (Join-Path $Payload '*') -DestinationPath $zip -Force
  }
  Copy-Item $zip $zipVer -Force
  Write-Host "    ZIP: $zip"

  $makensisCmd = $null
  $makensisPath = Get-Command makensis -ErrorAction SilentlyContinue
  if ($makensisPath) {
    $makensisCmd = $makensisPath.Source
  } else {
    foreach ($candidate in @(
      "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
      "${env:ProgramFiles}\NSIS\makensis.exe"
    )) {
      if (Test-Path $candidate) { $makensisCmd = $candidate; break }
    }
  }
  if ($makensisCmd) {
    Write-Host '==> Building SPECTRE-Setup.exe with NSIS'
    & $makensisCmd "/DPRODUCT_VERSION=$Version" (Join-Path $PSScriptRoot 'Spectre.nsi')
    if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit $LASTEXITCODE" }
    Write-Host "    EXE: $(Join-Path $Release 'SPECTRE-Setup.exe')"
  } else {
    Write-Host ''
    Write-Host 'NOTE: makensis not found — Setup.exe was NOT built.'
    Write-Host '  Install NSIS (https://nsis.sourceforge.io/) and re-run, or use:'
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$Payload\install.ps1`""
    Write-Host '  (elevated / Run as Administrator)'
  }

  Write-Host ''
  Write-Host 'Done. Open http://127.0.0.1:9000/ after install.'
}
finally {
  Pop-Location
}
