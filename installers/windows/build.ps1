#Requires -Version 5.1
<#
.SYNOPSIS
  Build SPECTRE web+server, stage Windows payload, optionally build Setup.exe.
#>
[CmdletBinding()]
param(
  [switch]$SkipNpmInstall,
  [string]$Version = '1.1.6',
  # Authenticode-sign SPECTRE-Setup.exe when cert env vars are set (see docs/CODE-SIGNING.md)
  [switch]$Sign,
  [switch]$SkipSign
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
# Stage into payload-clean so a locked previous payload\ (Electron in use) cannot poison the build.
$Payload = Join-Path $Root 'release\windows\payload-clean'
$Release = Join-Path $Root 'release'

Write-Host "==> SPECTRE Windows build (v$Version)"
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

  # Official Node LTS binary so Setup.exe needs no system Node install
  & (Join-Path $Root 'installers\common\bundle-node-runtime.ps1') -Platform 'win-x64' -PayloadDir $Payload

  # Desktop overlay (Electron) — required for always-on-top widget
  & (Join-Path $Root 'installers\common\stage-pip-shell.ps1') `
    -RepoRoot $Root -PayloadDir $Payload -TargetPlatform win32 -TargetArch x64

  # Runtime package.json (server entry only)
  $pkg = @{
    name = 'spectre'
    version = $Version
    private = $true
    description = 'SPECTRE local pan/tilt web service'
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
  Copy-Item (Join-Path $Root 'installers\common\OS-PREREQS.txt') (Join-Path $Payload 'OS-PREREQS.txt') -Force
  Set-Content -Path (Join-Path $Payload 'BRANDING.txt') -Encoding UTF8 -Value @(
    'SPECTRE'
    'Local web service: available on port 9000 (or saved httpPort)'
    'Desktop overlay: pip-shell\ (Electron)'
    'Bundled Node runtime: runtime\node.exe (no system Node required)'
  )
  Set-Content -Path (Join-Path $Payload 'README.txt') -Encoding UTF8 -Value @"
SPECTRE — Windows portable payload v$Version

All-users install (Administrator PowerShell):
  .\install.ps1

Installs to C:\Program Files\SPECTRE\, registers logon autostart, opens the
local console on the configured listen port (default 9000).
Fully offline: bundled Node (runtime\), npm deps + serialport, and Electron overlay.
No separate Node.js / npm install.

NOT in this archive (OS / hardware — set up once):
  - USB-serial driver so a healthy COMx appears in Device Manager
  - Administrator elevation for Program Files + autostart
  - Logged-on desktop session for the Electron overlay (browser widget always works)
  - Pelco-D head + RS-485 (or optional UDP) cabling

See docs/INSTALL.md "OS / hardware setup" or SPECTRE-Install-Guide.pdf.

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

  & (Join-Path $Root 'installers\common\verify-payload.ps1') -PayloadDir $Payload -Kind 'win-x64'

  # Latest-only: one versioned portable ZIP (no unversioned duplicate)
  $zip = Join-Path $Release "SPECTRE-windows-x64-v$Version.zip"
  $legacyPortable = Join-Path $Release 'SPECTRE-windows-x64-portable.zip'
  foreach ($z in @($zip, $legacyPortable)) {
    if (Test-Path $z) { Remove-Item $z -Force }
  }
  # Prefer tar (handles long paths); fall back to Compress-Archive
  $tar = Get-Command tar -ErrorAction SilentlyContinue
  if ($tar) {
    Push-Location $Payload
    & tar -a -cf $zip *
    Pop-Location
  } else {
    Compress-Archive -Path (Join-Path $Payload '*') -DestinationPath $zip -Force
  }
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
    # NSIS File /r breaks on paths with spaces (e.g. "Pelco D"). Stage via SUBST.
    $nsiStage = 'C:\spectre-nsi-payload'
    if (Test-Path $nsiStage) { Remove-Item $nsiStage -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $nsiStage | Out-Null
    cmd /c "robocopy `"$Payload`" `"$nsiStage`" /E /NFL /NDL /NJH /NJS /nc /ns /np" | Out-Null
    subst S: $nsiStage 2>$null
    try {
      $nsiText = Get-Content (Join-Path $PSScriptRoot 'Spectre.nsi') -Raw
      $outShort = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($Release).ShortPath
      $nsiText = $nsiText -replace 'OutFile "[^"]+"', ("OutFile `"$($outShort -replace '\\','/')/SPECTRE-Setup.exe`"")
      $nsiText = $nsiText -replace 'File /r "[^"]+"', 'File /r ".\*.*"'
      $packNsi = 'S:\SpectrePack.nsi'
      Set-Content -Path $packNsi -Value $nsiText -Encoding ASCII
      & $makensisCmd "/DPRODUCT_VERSION=$Version" $packNsi
      if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit $LASTEXITCODE" }
    } finally {
      subst S: /d 2>$null
      Remove-Item $nsiStage -Recurse -Force -ErrorAction SilentlyContinue
    }
    $setupExe = Join-Path $Release 'SPECTRE-Setup.exe'
    Write-Host "    EXE: $setupExe"

    $wantSign = $Sign -or (
      -not $SkipSign -and (
        $env:SPECTRE_SIGN_PFX -or $env:SPECTRE_SIGN_THUMBPRINT
      )
    )
    if ($wantSign) {
      & (Join-Path $PSScriptRoot 'sign-setup.ps1') -ExePath $setupExe
    } else {
      Write-Host '    Unsigned Setup (set SPECTRE_SIGN_PFX or SPECTRE_SIGN_THUMBPRINT, or pass -Sign). See docs/CODE-SIGNING.md'
    }
  } else {
    Write-Host ''
    Write-Host 'NOTE: makensis not found — Setup.exe was NOT built.'
    Write-Host '  Install NSIS (https://nsis.sourceforge.io/) and re-run, or use:'
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$Payload\install.ps1`""
    Write-Host '  (elevated / Run as Administrator)'
  }

  Write-Host ''
  Write-Host 'Done. Open the SPECTRE console on the configured listen port (default 9000) after install.'
}
finally {
  Pop-Location
}
