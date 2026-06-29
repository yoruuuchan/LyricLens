#requires -Version 5.1
# Build LyricLensUpdaterProbe.plugin from this folder. One-shot
# throwaway, follows the same flat-zip layout as the main plugin.
#
# Usage: pwsh probes/updater-probe/build.ps1

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$out = Join-Path $here 'LyricLensUpdaterProbe.plugin'

$stage = Join-Path $env:TEMP "lyriclens-probe-a-stage-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $stage | Out-Null

try {
  Copy-Item (Join-Path $here 'manifest.json') -Destination $stage
  Copy-Item (Join-Path $here 'probe.js')       -Destination $stage

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path $out) { Remove-Item $out -Force }
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage,
    $out,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
  $sizeKB = [math]::Round((Get-Item $out).Length / 1024, 2)
  Write-Host "Built $($out) ($sizeKB KB)" -ForegroundColor Green
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
