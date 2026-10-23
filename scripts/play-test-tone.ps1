param([Parameter(Mandatory = $true)][string]$WaveFile)
# Explicit acceptance fixture only; never called by the MCP service. No device or volume changes.
$ErrorActionPreference = 'Stop'
$tonePlayer = [System.Media.SoundPlayer]::new($WaveFile)
try { $tonePlayer.Load(); Write-Output 'tone-loaded'; $tonePlayer.PlaySync() }
finally { $tonePlayer.Stop(); $tonePlayer.Dispose() }
