#requires -Version 5.1
# Build the .plugin distributable for BetterNCM.
#
# Flattens src/*.js -> root, copies the other runtime files, and zips
# everything into <Name>.plugin (no version suffix, no .zip suffix). Fixed
# filename so GitHub Release `latest/download/<Name>.plugin` URLs and the
# subdomain redirect at lyriclens.yoru-and-akari.dev/download keep working
# across versions — GitHub does NOT substitute the version into asset
# names. Version still lives in manifest.json + git tag + latest.json.
# Reads file list from manifest.json's injects.Main, so adding a new
# module is just an extra entry in the manifest.
#
# Usage:
#   pwsh scripts/build-plugin.ps1
#   pwsh scripts/build-plugin.ps1 -OutputName CustomName.plugin
#   npm run build

[CmdletBinding()]
param(
  [string]$OutputName
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "manifest.json not found at $manifestPath" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

$injectFiles = $manifest.injects.Main | ForEach-Object { $_.file }
if (-not $OutputName) {
  $OutputName = "$($manifest.name).plugin"
}
$outPath = Join-Path $root $OutputName

$stage = Join-Path $env:TEMP "lyriclens-stage-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $stage | Out-Null
Write-Host "Staging at $stage"

try {
  foreach ($file in $injectFiles) {
    if ($file -match '[/\\]') { throw "inject path must be flat (no directory): $file" }
    $candidates = @((Join-Path $root "src\$file"), (Join-Path $root $file))
    $source = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $source) { throw "missing inject source: $file (looked in src/ and root)" }
    Copy-Item $source -Destination (Join-Path $stage $file)
    $sizeKB = [math]::Round((Get-Item $source).Length / 1024, 1)
    Write-Host ("  inject  {0,-22} {1,6} KB" -f $file, $sizeKB)
  }

  foreach ($extra in @('manifest.json', 'package.json', 'README.md', 'preview.png')) {
    $src = Join-Path $root $extra
    if (Test-Path $src) {
      Copy-Item $src -Destination $stage
      Write-Host ("  extra   {0,-22}" -f $extra)
    }
  }

  $css = Join-Path $root 'styles\panel.css'
  if (Test-Path $css) {
    Copy-Item $css -Destination $stage
    Write-Host ("  extra   {0,-22}" -f 'panel.css')

    # Inline panel.css into styles.js inside the staged copy. BetterNCM
    # loads our styles via injectInlineStyle(Styles.PANEL_CSS), so the
    # JS-side string is what actually reaches the runtime. styles/
    # panel.css is the single source of truth; the marker block in
    # src/styles.js is replaced here at build time. This eliminates the
    # silent-drift class of bugs where developers edit panel.css and
    # nothing visibly changes.
    $stagedStylesJs = Join-Path $stage 'styles.js'
    if (Test-Path $stagedStylesJs) {
      # Read both files with .NET directly. Get-Content -Raw sometimes
      # returns a PSObject wrapper instead of a bare string, which makes
      # ConvertTo-Json wrap the value as {"value":"..."} — disastrous here.
      $cssText = [System.IO.File]::ReadAllText($css, [System.Text.UTF8Encoding]::new($false))
      $stylesJsText = [System.IO.File]::ReadAllText($stagedStylesJs, [System.Text.UTF8Encoding]::new($false))
      # Hand-roll a JS string literal: escape \ then " then \n / \r / \t.
      # Avoids JSON's extra escaping of forward slashes and gives a clean
      # diff-able output.
      $escaped = $cssText `
        -replace '\\', '\\' `
        -replace '"', '\"' `
        -replace "`r", '\r' `
        -replace "`n", '\n' `
        -replace "`t", '\t'
      $jsLiteral = '"' + $escaped + '"'
      $pattern = '/\*__INLINE_PANEL_CSS_START__\*/[\s\S]*?/\*__INLINE_PANEL_CSS_END__\*/'
      if ($stylesJsText -notmatch $pattern) {
        throw "styles.js is missing the INLINE_PANEL_CSS marker block — refusing to build with broken CSS"
      }
      $replacement = "/*__INLINE_PANEL_CSS_START__*/$jsLiteral/*__INLINE_PANEL_CSS_END__*/"
      # MatchEvaluator with closure-captured $replacement avoids $1-style
      # backreference substitution in the replacement string.
      $evaluator = [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $replacement }
      $stylesJsText = [System.Text.RegularExpressions.Regex]::Replace($stylesJsText, $pattern, $evaluator)
      [System.IO.File]::WriteAllText($stagedStylesJs, $stylesJsText, [System.Text.UTF8Encoding]::new($false))
      $kb = [math]::Round(($cssText.Length / 1024), 1)
      Write-Host ("  inline  {0,-22} {1,6} KB into styles.js" -f 'panel.css', $kb)
    }
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path $outPath) { Remove-Item $outPath -Force }
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage,
    $outPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  $sizeKB = [math]::Round((Get-Item $outPath).Length / 1024, 1)
  Write-Host ""
  Write-Host "Built $OutputName ($sizeKB KB)" -ForegroundColor Green
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
