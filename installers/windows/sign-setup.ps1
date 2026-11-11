#Requires -Version 5.1
<#
.SYNOPSIS
  Authenticode-sign SPECTRE-Setup.exe (or another EXE) with SignTool.

.DESCRIPTION
  Requires Windows SDK SignTool. Prefer a real OV/EV or Azure-issued public trust
  cert — self-signed will not clear SmartScreen for public users.

  Auth (one of):
    -PfxPath / SPECTRE_SIGN_PFX (+ password)
    -CertThumbprint / SPECTRE_SIGN_THUMBPRINT (cert already in CurrentUser/LocalMachine My store)
#>
[CmdletBinding()]
param(
  [string]$ExePath = '',
  [string]$PfxPath = $env:SPECTRE_SIGN_PFX,
  [string]$PfxPassword = $env:SPECTRE_SIGN_PFX_PASSWORD,
  [string]$CertThumbprint = $env:SPECTRE_SIGN_THUMBPRINT,
  [string]$TimestampUrl = $(if ($env:SPECTRE_SIGN_TIMESTAMP_URL) { $env:SPECTRE_SIGN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }),
  [string]$Description = 'SPECTRE pan/tilt pedestal controller'
)

$ErrorActionPreference = 'Stop'

if (-not $ExePath) {
  $root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
  $ExePath = Join-Path $root 'release\SPECTRE-Setup.exe'
}
if (-not (Test-Path -LiteralPath $ExePath)) {
  throw "EXE not found: $ExePath"
}

function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $roots = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
    "${env:ProgramFiles}\Windows Kits\10\bin"
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    $hit = Get-ChildItem -Path $root -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$signtool = Find-SignTool
if (-not $signtool) {
  throw 'signtool.exe not found. Install the Windows SDK (Signing Tools) or add signtool to PATH.'
}

$args = @(
  'sign',
  '/fd', 'SHA256',
  '/td', 'SHA256',
  '/tr', $TimestampUrl,
  '/d', $Description
)

if ($CertThumbprint) {
  $thumb = ($CertThumbprint -replace '\s', '').ToUpperInvariant()
  Write-Host "==> Signing with store certificate $thumb"
  $args += @('/sha1', $thumb, '/sm')
} elseif ($PfxPath) {
  if (-not (Test-Path -LiteralPath $PfxPath)) {
    throw "PFX not found: $PfxPath"
  }
  Write-Host "==> Signing with PFX $PfxPath"
  $args += @('/f', $PfxPath)
  if ($PfxPassword) {
    $args += @('/p', $PfxPassword)
  }
} else {
  throw 'No signing material. Set SPECTRE_SIGN_PFX (+ SPECTRE_SIGN_PFX_PASSWORD) or SPECTRE_SIGN_THUMBPRINT, or pass -PfxPath / -CertThumbprint.'
}

$args += $ExePath
$safe = ($args | ForEach-Object {
  if ($PfxPassword -and $_ -eq $PfxPassword) { '***' } else { $_ }
}) -join ' '
Write-Host "    $signtool $safe"

& $signtool @args
if ($LASTEXITCODE -ne 0) {
  throw "signtool failed with exit $LASTEXITCODE"
}

$sig = Get-AuthenticodeSignature -FilePath $ExePath
Write-Host "    Status: $($sig.Status)  Signer: $($sig.SignerCertificate.Subject)"
if ($sig.Status -ne 'Valid') {
  throw "Signature status is $($sig.Status) (expected Valid). Check cert chain / timestamp."
}

Write-Host "Signed OK: $ExePath"
