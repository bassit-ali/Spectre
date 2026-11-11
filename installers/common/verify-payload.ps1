#Requires -Version 5.1
<#
.SYNOPSIS
  Fail the pack if offline runtime essentials are missing from a payload.
#>
param(
  [Parameter(Mandatory = $true)][string]$PayloadDir,
  [ValidateSet('win-x64', 'linux-x64', 'linux-arm64')]
  [Parameter(Mandatory = $true)][string]$Kind
)

$ErrorActionPreference = 'Stop'
$missing = @()

function Need([string]$Rel, [string]$Label) {
  $p = Join-Path $PayloadDir $Rel
  if (-not (Test-Path -LiteralPath $p)) { $script:missing += $Label }
}

Need 'server\dist\src\index.js' 'server dist'
Need 'web\dist\index.html' 'web dist'
Need 'package.json' 'package.json'
Need 'node_modules\serialport\package.json' 'serialport'
Need 'node_modules\@fastify\static\package.json' '@fastify/static'
Need 'node_modules\fastify\package.json' 'fastify'
Need 'node_modules\ws\package.json' 'ws'
Need 'pip-shell\main.js' 'pip-shell main'
Need 'pip-shell\package.json' 'pip-shell package.json'

switch ($Kind) {
  'win-x64' {
    Need 'runtime\node.exe' 'bundled Node (runtime\node.exe)'
    Need 'spectre.cmd' 'spectre.cmd'
    Need 'pip-shell\node_modules\electron\dist\electron.exe' 'Electron (Windows)'
    Need 'node_modules\@serialport\bindings-cpp\prebuilds\win32-x64' 'serialport win32-x64 prebuild'
  }
  'linux-x64' {
    Need 'runtime\bin\node' 'bundled Node (runtime/bin/node)'
    Need 'spectre.sh' 'spectre.sh'
    Need 'install.sh' 'install.sh'
    Need 'spectre.service' 'spectre.service'
    Need 'pip-shell\node_modules\electron\dist\electron' 'Electron (Linux x64)'
    Need 'node_modules\@serialport\bindings-cpp\prebuilds\linux-x64' 'serialport linux-x64 prebuild'
  }
  'linux-arm64' {
    Need 'runtime\bin\node' 'bundled Node (runtime/bin/node)'
    Need 'spectre.sh' 'spectre.sh'
    Need 'install.sh' 'install.sh'
    Need 'spectre.service' 'spectre.service'
    Need 'pip-shell\node_modules\electron\dist\electron' 'Electron (Linux arm64)'
    Need 'node_modules\@serialport\bindings-cpp\prebuilds\linux-arm64' 'serialport linux-arm64 prebuild'
  }
}

if ($missing.Count -gt 0) {
  throw "Payload incomplete for $Kind — missing: $($missing -join ', ')"
}

Write-Host "    Payload OK ($Kind): Node + npm deps + serialport prebuild + Electron"
