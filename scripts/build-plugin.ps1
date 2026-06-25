#requires -Version 5.1
# Build the .plugin distributable for BetterNCM.
#
# Flattens src/*.js -> root, copies the other runtime files, and zips
# everything into <Name>-<Version>.plugin (no .zip suffix). Reads file list
# from manifest.json's injects.Main, so adding a new module is just an
# extra entry in the manifest.
#
# Usage:
#   pwsh scripts/build-plugin.ps1
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
  $OutputName = "$($manifest.name)-$($manifest.version).plugin"
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
