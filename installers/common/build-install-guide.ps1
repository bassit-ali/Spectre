#Requires -Version 5.1
<#
.SYNOPSIS
  Build SPECTRE-Install-Guide.{md,html,pdf} under release/ from docs/INSTALL.md.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = '',
  [string]$Version = '1.1.3'
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

$docs = Join-Path $RepoRoot 'docs'
$srcMd = Join-Path $docs 'INSTALL.md'
$release = Join-Path $RepoRoot 'release'
$assets = Join-Path $release 'guide-assets'
$outMd = Join-Path $release 'SPECTRE-Install-Guide.md'
$outHtml = Join-Path $release 'SPECTRE-Install-Guide.html'
$outPdf = Join-Path $release 'SPECTRE-Install-Guide.pdf'

if (-not (Test-Path $srcMd)) { throw "Missing $srcMd" }
New-Item -ItemType Directory -Force -Path $release, $assets | Out-Null

Write-Host "==> SPECTRE install guide v$Version"

# Copy screenshots next to the guide for self-contained HTML/PDF
$shotDir = Join-Path $docs 'screenshots'
foreach ($name in @('console.png', 'widget.png', 'console-full.png')) {
  $src = Join-Path $shotDir $name
  if (Test-Path $src) {
    Copy-Item -LiteralPath $src -Destination (Join-Path $assets $name) -Force
  }
}

# Guide markdown with release-relative image paths
$md = Get-Content -LiteralPath $srcMd -Raw
$md = $md -replace '\(screenshots/', '(guide-assets/'
Set-Content -LiteralPath $outMd -Value $md -Encoding UTF8
Write-Host "    MD: $outMd"

function Convert-SimpleMarkdownToHtml([string]$text) {
  $lines = $text -split "`r?`n"
  $sb = New-Object System.Text.StringBuilder
  $inCode = $false
  $inUl = $false
  $inOl = $false
  $inTable = $false

  function Close-Lists {
    if ($script:inUl) { [void]$sb.AppendLine('</ul>'); $script:inUl = $false }
    if ($script:inOl) { [void]$sb.AppendLine('</ol>'); $script:inOl = $false }
  }
  function Close-Table {
    if ($script:inTable) { [void]$sb.AppendLine('</tbody></table>'); $script:inTable = $false }
  }
  function Inline([string]$s) {
    $s = [System.Net.WebUtility]::HtmlEncode($s)
    $s = [regex]::Replace($s, '\[([^\]]+)\]\(([^)]+)\)', '<a href="$2">$1</a>')
    $s = [regex]::Replace($s, '!&lt;a href="([^"]+)"&gt;([^&]*)&lt;/a&gt;', '') # noop safety
    # restore images written as ![alt](path) before encode — re-process from raw differently
    return $s
  }

  # Re-parse with raw lines for images/links before encode
  function Format-Inline([string]$raw) {
    $parts = New-Object System.Collections.Generic.List[string]
    $pattern = '(!?\[[^\]]*\]\([^)]+\])|(\*\*[^*]+\*\*)|(`[^`]+`)'
    $idx = 0
    foreach ($m in [regex]::Matches($raw, $pattern)) {
      if ($m.Index -gt $idx) {
        $parts.Add([System.Net.WebUtility]::HtmlEncode($raw.Substring($idx, $m.Index - $idx)))
      }
      $token = $m.Value
      if ($token.StartsWith('![')) {
        if ($token -match '!\[([^\]]*)\]\(([^)]+)\)') {
          $alt = [System.Net.WebUtility]::HtmlEncode($Matches[1])
          $src = $Matches[2] -replace '^screenshots/', 'guide-assets/'
          $src = $src -replace '^guide-assets/', 'guide-assets/'
          $parts.Add("<figure class=`"shot`"><img src=`"$src`" alt=`"$alt`" /></figure>")
        }
      } elseif ($token.StartsWith('[')) {
        if ($token -match '\[([^\]]+)\]\(([^)]+)\)') {
          $lab = [System.Net.WebUtility]::HtmlEncode($Matches[1])
          $href = [System.Net.WebUtility]::HtmlEncode($Matches[2])
          $parts.Add("<a href=`"$href`">$lab</a>")
        }
      } elseif ($token.StartsWith('**')) {
        $inner = [System.Net.WebUtility]::HtmlEncode($token.Trim('*'))
        $parts.Add("<strong>$inner</strong>")
      } elseif ($token.StartsWith('`')) {
        $inner = [System.Net.WebUtility]::HtmlEncode($token.Trim('`'))
        $parts.Add("<code>$inner</code>")
      }
      $idx = $m.Index + $m.Length
    }
    if ($idx -lt $raw.Length) {
      $parts.Add([System.Net.WebUtility]::HtmlEncode($raw.Substring($idx)))
    }
    return ($parts -join '')
  }

  foreach ($line in $lines) {
    if ($line -match '^```') {
      Close-Lists; Close-Table
      if (-not $inCode) {
        [void]$sb.AppendLine('<pre><code>')
        $inCode = $true
      } else {
        [void]$sb.AppendLine('</code></pre>')
        $inCode = $false
      }
      continue
    }
    if ($inCode) {
      [void]$sb.AppendLine([System.Net.WebUtility]::HtmlEncode($line))
      continue
    }
    if ($line -match '^---\s*$') {
      Close-Lists; Close-Table
      [void]$sb.AppendLine('<hr />')
      continue
    }
    if ($line -match '^\|(.+)\|\s*$') {
      Close-Lists
      $cells = ($line.Trim('|') -split '\|') | ForEach-Object { $_.Trim() }
      if ($cells -match '^[\s:-]+$') { continue } # separator row
      if (-not $inTable) {
        [void]$sb.AppendLine('<table><thead><tr>')
        foreach ($c in $cells) { [void]$sb.AppendLine("<th>$(Format-Inline $c)</th>") }
        [void]$sb.AppendLine('</tr></thead><tbody>')
        $inTable = $true
      } else {
        [void]$sb.AppendLine('<tr>')
        foreach ($c in $cells) { [void]$sb.AppendLine("<td>$(Format-Inline $c)</td>") }
        [void]$sb.AppendLine('</tr>')
      }
      continue
    } else {
      Close-Table
    }

    if ($line -match '^#\s+(.+)$') {
      Close-Lists
      [void]$sb.AppendLine("<h1>$(Format-Inline $Matches[1])</h1>")
      continue
    }
    if ($line -match '^##\s+(.+)$') {
      Close-Lists
      [void]$sb.AppendLine("<h2>$(Format-Inline $Matches[1])</h2>")
      continue
    }
    if ($line -match '^###\s+(.+)$') {
      Close-Lists
      [void]$sb.AppendLine("<h3>$(Format-Inline $Matches[1])</h3>")
      continue
    }
    if ($line -match '^>\s?(.*)$') {
      Close-Lists
      [void]$sb.AppendLine("<blockquote>$(Format-Inline $Matches[1])</blockquote>")
      continue
    }
    if ($line -match '^\s*[-*]\s+(.+)$') {
      if ($inOl) { [void]$sb.AppendLine('</ol>'); $inOl = $false }
      if (-not $inUl) { [void]$sb.AppendLine('<ul>'); $inUl = $true }
      [void]$sb.AppendLine("<li>$(Format-Inline $Matches[1])</li>")
      continue
    }
    if ($line -match '^\s*\d+\.\s+(.+)$') {
      if ($inUl) { [void]$sb.AppendLine('</ul>'); $inUl = $false }
      if (-not $inOl) { [void]$sb.AppendLine('<ol>'); $inOl = $true }
      [void]$sb.AppendLine("<li>$(Format-Inline $Matches[1])</li>")
      continue
    }
    if ([string]::IsNullOrWhiteSpace($line)) {
      Close-Lists
      continue
    }
    Close-Lists
    [void]$sb.AppendLine("<p>$(Format-Inline $line)</p>")
  }
  Close-Lists
  Close-Table
  return $sb.ToString()
}

$body = Convert-SimpleMarkdownToHtml $md

$html = @"
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SPECTRE Install Guide v$Version</title>
  <style>
    :root {
      --bg: #0f1419;
      --panel: #1a2332;
      --text: #e8eef7;
      --muted: #9aa8bc;
      --accent: #3d9bfd;
      --line: #2a3648;
      --ok: #3ecf8e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(160deg, #0f1419 0%, #152033 50%, #0f1419 100%);
      color: var(--text);
      line-height: 1.55;
    }
    .page { max-width: 820px; margin: 0 auto; padding: 48px 28px 64px; }
    h1 { font-size: 2rem; letter-spacing: 0.04em; margin: 0 0 8px; }
    h2 { font-size: 1.2rem; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
    h3 { font-size: 1.05rem; margin: 22px 0 8px; color: var(--accent); }
    p, li { color: var(--text); }
    .muted, blockquote { color: var(--muted); }
    blockquote {
      margin: 12px 0;
      padding: 10px 14px;
      border-left: 3px solid var(--accent);
      background: var(--panel);
      border-radius: 0 8px 8px 0;
    }
    table { width: 100%; border-collapse: collapse; margin: 12px 0 8px; font-size: 0.95rem; }
    th, td { border: 1px solid var(--line); padding: 8px 10px; text-align: left; }
    th { background: var(--panel); }
    code, pre { font-family: Consolas, "Courier New", monospace; font-size: 0.92rem; }
    code { background: var(--panel); padding: 0.1em 0.35em; border-radius: 4px; }
    pre {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
      white-space: pre-wrap;
    }
    pre code { background: transparent; padding: 0; }
    figure.shot { margin: 16px 0; }
    figure.shot img {
      display: block;
      width: 100%;
      max-width: 760px;
      border-radius: 10px;
      border: 1px solid var(--line);
    }
    hr { border: none; border-top: 1px solid var(--line); margin: 28px 0; }
    a { color: var(--accent); }
    @media print {
      body { background: #fff; color: #111; }
      .page { padding: 12mm; }
      h1, h2, h3, p, li, th, td { color: #111; }
      h3, a { color: #0645ad; }
      pre, code, th, blockquote { background: #f4f4f4; border-color: #ccc; color: #111; }
      figure.shot img { border-color: #ccc; max-height: 420px; object-fit: contain; }
    }
  </style>
</head>
<body>
  <main class="page">
$body
  </main>
</body>
</html>
"@

Set-Content -LiteralPath $outHtml -Value $html -Encoding UTF8
Write-Host "    HTML: $outHtml"

# PDF via Edge/Chrome headless (temp path without spaces)
if (Test-Path $outPdf) { Remove-Item $outPdf -Force -ErrorAction SilentlyContinue }
$made = $false
$browsers = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ }

$tmpDir = Join-Path $env:TEMP 'spectre-guide'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$htmlTmp = Join-Path $tmpDir 'guide.html'
$pdfTmp = Join-Path $tmpDir 'guide.pdf'
$assetsTmp = Join-Path $tmpDir 'guide-assets'
if (Test-Path $assetsTmp) { Remove-Item $assetsTmp -Recurse -Force }
Copy-Item -LiteralPath $assets -Destination $assetsTmp -Recurse -Force
Copy-Item -LiteralPath $outHtml -Destination $htmlTmp -Force
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
      Copy-Item -LiteralPath $pdfTmp -Destination $outPdf -Force
      $made = $true
      Write-Host "    PDF OK ($((Get-Item $outPdf).Length) bytes)"
      break
    }
    Write-Host "    headless exit=$($p.ExitCode); pdf missing or too small"
  } catch {
    Write-Host "    browser PDF failed: $($_.Exception.Message)"
  }
}

if (-not $made) {
  throw 'Failed to create PDF guide (install Edge/Chrome or re-run after fixing headless print).'
}

# Remove obsolete Linux-only guide names
foreach ($old in @(
  'SPECTRE-Linux-Install-Guide.md',
  'SPECTRE-Linux-Install-Guide.html',
  'SPECTRE-Linux-Install-Guide.pdf'
)) {
  $p = Join-Path $release $old
  if (Test-Path $p) {
    Remove-Item -LiteralPath $p -Force
    Write-Host "    removed obsolete $old"
  }
}

Write-Host "Guide ready: $outPdf"
