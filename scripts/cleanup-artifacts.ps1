param([switch]$Apply)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'portable-artifacts.ps1')
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Invoke-PortableArtifactCleanup -Repository $repo -Apply:$Apply | Format-Table -AutoSize
