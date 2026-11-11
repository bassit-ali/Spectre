#Requires -Version 5.1
<#
.SYNOPSIS
  Download an official Node.js binary distribution into payload/runtime/
  so SPECTRE runs offline without a system Node install.
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('win-x64', 'linux-x64', 'linux-arm64')]
  [string]$Platform,

  [Parameter(Mandatory = $true)]
  [string]$PayloadDir,

  # Pin a known LTS; bump intentionally when packaging.
  [string]$NodeVersion = '20.18.2'
)

$ErrorActionPreference = 'Stop'

$runtime = Join-Path $PayloadDir 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

$cacheRoot = Join-Path $env:LOCALAPPDATA 'SpectrePT\node-dist-cache'
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null

switch ($Platform) {
  'win-x64' {
    $name = "node-v$NodeVersion-win-x64"
    $url = "https://nodejs.org/dist/v$NodeVersion/$name.zip"
    $archive = Join-Path $cacheRoot "$name.zip"
    $marker = Join-Path $runtime 'node.exe'
  }
  'linux-x64' {
    $name = "node-v$NodeVersion-linux-x64"
    $url = "https://nodejs.org/dist/v$NodeVersion/$name.tar.gz"
    $archive = Join-Path $cacheRoot "$name.tar.gz"
    $marker = Join-Path $runtime 'bin\node'
  }
  'linux-arm64' {
    $name = "node-v$NodeVersion-linux-arm64"
    $url = "https://nodejs.org/dist/v$NodeVersion/$name.tar.gz"
    $archive = Join-Path $cacheRoot "$name.tar.gz"
    $marker = Join-Path $runtime 'bin\node'
  }
}

if ((Test-Path $marker) -and ((Get-Item $marker).Length -gt 1MB)) {
  Write-Host "    Node runtime already present: $marker"
  return
}

if (-not (Test-Path $archive) -or (Get-Item $archive).Length -lt 1MB) {
  Write-Host "==> Downloading Node $NodeVersion ($Platform)"
  Write-Host "    $url"
  Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
}

$extract = Join-Path $cacheRoot "extract-$name"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
New-Item -ItemType Directory -Force -Path $extract | Out-Null

Write-Host "==> Extracting Node into payload/runtime ($Platform)"
if ($Platform -eq 'win-x64') {
  Expand-Archive -Path $archive -DestinationPath $extract -Force
  $src = Join-Path $extract $name
  if (-not (Test-Path (Join-Path $src 'node.exe'))) {
    # Some zips nest differently
    $src = Get-ChildItem $extract -Directory | Select-Object -First 1 -ExpandProperty FullName
  }
  Copy-Item (Join-Path $src 'node.exe') (Join-Path $runtime 'node.exe') -Force
  # Keep license / readme for compliance
  foreach ($f in @('LICENSE', 'LICENSE.MD', 'README.md', 'CHANGELOG.md')) {
    $p = Join-Path $src $f
    if (Test-Path $p) { Copy-Item $p (Join-Path $runtime $f) -Force }
  }
} else {
  tar -xzf $archive -C $extract
  $src = Join-Path $extract $name
  if (-not (Test-Path (Join-Path $src 'bin\node'))) {
    $src = Get-ChildItem $extract -Directory | Select-Object -First 1 -ExpandProperty FullName
  }
  # Full official layout under runtime/ (bin/node, lib/, share/, ...)
  Get-ChildItem $src | ForEach-Object {
    Copy-Item $_.FullName $runtime -Recurse -Force
  }
}

if (-not (Test-Path $marker)) {
  throw "Node runtime missing after extract: expected $marker"
}

$ver = & $marker --version 2>$null
Write-Host "    Bundled Node OK: $marker ($ver)"
