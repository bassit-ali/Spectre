<#
.SYNOPSIS
  Generate SPECTRE-Linux-Install-Guide.pdf under release/
  Uses Edge/Chrome headless (via a temp path without spaces); falls back to plain PDF.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$release = Join-Path $RepoRoot 'release'
$md = Join-Path $release 'SPECTRE-Linux-Install-Guide.md'
$html = Join-Path $release 'SPECTRE-Linux-Install-Guide.html'
$pdf = Join-Path $release 'SPECTRE-Linux-Install-Guide.pdf'

if (-not (Test-Path $md)) { throw "Missing $md" }
if (-not (Test-Path $html)) { throw "Missing $html" }

$made = $false
if (Test-Path $pdf) { Remove-Item $pdf -Force -ErrorAction SilentlyContinue }

$browsers = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ }

# Copy HTML to a temp path without spaces (Edge fails on "Pelco D")
$tmpDir = Join-Path $env:TEMP 'spectre-guide'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$htmlTmp = Join-Path $tmpDir 'guide.html'
$pdfTmp = Join-Path $tmpDir 'guide.pdf'
Copy-Item -LiteralPath $html -Destination $htmlTmp -Force
if (Test-Path $pdfTmp) { Remove-Item $pdfTmp -Force }

foreach ($browser in $browsers) {
  try {
    Write-Host "==> Trying headless PDF via $browser"
    $uri = ([System.Uri]::new((Resolve-Path -LiteralPath $htmlTmp).Path)).AbsoluteUri
    $p = Start-Process -FilePath $browser -ArgumentList @(
      '--headless',
      '--disable-gpu',
      '--no-pdf-header-footer',
      "--print-to-pdf=$pdfTmp",
      $uri
    ) -PassThru -WindowStyle Hidden -Wait
    if ((Test-Path $pdfTmp) -and ((Get-Item $pdfTmp).Length -gt 1000)) {
      Copy-Item -LiteralPath $pdfTmp -Destination $pdf -Force
      $made = $true
      Write-Host "    PDF OK ($((Get-Item $pdf).Length) bytes)"
      break
    }
    Write-Host "    headless exit=$($p.ExitCode); pdf missing or too small"
  } catch {
    Write-Host "    browser PDF failed: $($_.Exception.Message)"
  }
}

if (-not $made) {
  Write-Host '==> Writing plain-text compatible PDF fallback'
  $text = Get-Content $md -Raw
  $safe = $text -replace '\\', '\\' -replace '\(', '\(' -replace '\)', '\)'
  $lines = $safe -split "`r?`n"
  $content = New-Object System.Text.StringBuilder
  [void]$content.AppendLine('BT /F1 10 Tf 50 820 Td 14 TL (SPECTRE Linux Install Guide) Tj T*')
  [void]$content.AppendLine('0 -6 Td 10 TL (Developed by 26 Sig Bn R&D Wing) Tj T* 0 -10 Td')
  $count = 0
  foreach ($line in $lines) {
    if ($count -gt 90) { break }
    $clip = if ($line.Length -gt 95) { $line.Substring(0, 95) } else { $line }
    if ([string]::IsNullOrWhiteSpace($clip)) {
      [void]$content.AppendLine('T*')
    } else {
      [void]$content.AppendLine("($clip) Tj T*")
    }
    $count++
  }
  [void]$content.AppendLine('ET')
  $stream = $content.ToString()
  $streamBytes = [System.Text.Encoding]::ASCII.GetBytes($stream)

  $objs = @()
  $objs += '<< /Type /Catalog /Pages 2 0 R >>'
  $objs += '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  $objs += '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'
  $objs += "<< /Length $($streamBytes.Length) >>`nstream`n$stream`nendstream"
  $objs += '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'

  $ms = New-Object System.IO.MemoryStream
  $sw = New-Object System.IO.StreamWriter($ms, [System.Text.Encoding]::ASCII)
  $sw.NewLine = "`n"
  $sw.WriteLine('%PDF-1.4')
  $offsets = @{}
  for ($i = 0; $i -lt $objs.Count; $i++) {
    $offsets[$i + 1] = $ms.Position
    $sw.WriteLine("$($i+1) 0 obj")
    $sw.WriteLine($objs[$i])
    $sw.WriteLine('endobj')
    $sw.Flush()
  }
  $xref = $ms.Position
  $sw.WriteLine('xref')
  $sw.WriteLine("0 $($objs.Count + 1)")
  $sw.WriteLine('0000000000 65535 f ')
  for ($i = 1; $i -le $objs.Count; $i++) {
    $sw.WriteLine(('{0:0000000000} 00000 n ' -f $offsets[$i]))
  }
  $sw.WriteLine('trailer')
  $sw.WriteLine("<< /Size $($objs.Count + 1) /Root 1 0 R >>")
  $sw.WriteLine('startxref')
  $sw.WriteLine("$xref")
  $sw.WriteLine('%%EOF')
  $sw.Flush()
  [System.IO.File]::WriteAllBytes($pdf, $ms.ToArray())
  $sw.Dispose(); $ms.Dispose()
  $made = Test-Path $pdf
}

if ($made) {
  Write-Host "PDF ready: $pdf ($((Get-Item $pdf).Length) bytes)"
} else {
  throw 'Failed to create PDF guide'
}
