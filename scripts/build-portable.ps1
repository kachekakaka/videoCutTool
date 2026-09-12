param([switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tempRoot = [IO.Path]::GetFullPath((Join-Path $repoPath '../videoCutTool_tmp'))
$candidatePath = Join-Path $tempRoot ('portable-' + [guid]::NewGuid().ToString('N'))
$releasePath = Join-Path $repoPath 'release'

function Assert-Within([string]$Target, [string]$Root) {
  $absolute = [IO.Path]::GetFullPath($Target)
  $parent = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $absolute.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) { throw "路径不在本次构建范围：$absolute" }
}
function Move-Owned([string]$Source, [string]$Destination) {
  foreach ($target in @($Source, $Destination)) {
    $absolute = [IO.Path]::GetFullPath($target)
    if ($absolute.StartsWith($releasePath + '\', [StringComparison]::OrdinalIgnoreCase)) { Assert-Within $absolute $releasePath }
    else { Assert-Within $absolute $candidatePath }
  }
  Move-Item -LiteralPath $Source -Destination $Destination -ErrorAction Stop
}
function Require-File([string]$File) { if (-not (Test-Path -LiteralPath $File -PathType Leaf) -or (Get-Item -LiteralPath $File).Length -eq 0) { throw "候选包缺少有效文件：$File" } }

Push-Location $repoPath
try {
  Assert-Within $candidatePath $tempRoot
  New-Item -ItemType Directory -Path $candidatePath -Force | Out-Null
  Write-Host '检查媒体工具和构建环境...'
  & node -e "require('./scripts/electron-builder.cjs')"
  if ($LASTEXITCODE -ne 0) { throw '媒体工具验证失败，旧便携版本保持原状' }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw '编译失败，旧便携版本保持原状' }
  & npx.cmd electron-builder --win dir --config scripts/electron-builder.cjs "--config.directories.output=$candidatePath"
  if ($LASTEXITCODE -ne 0) { throw '应用打包失败，旧便携版本保持原状' }
  $candidateApp = Join-Path $candidatePath 'app'
  Move-Owned (Join-Path $candidatePath 'win-unpacked') $candidateApp
  $compiler = @((Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), (Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $compiler) { $compiler = (Get-Command csc.exe -ErrorAction Stop).Source }
  $candidateLauncher = Join-Path $candidatePath 'VideoCutTool.exe'
  & $compiler /target:winexe /optimize+ "/out:$candidateLauncher" (Join-Path $PSScriptRoot 'launcher.cs')
  if ($LASTEXITCODE -ne 0) { throw '启动器编译失败，旧便携版本保持原状' }
  foreach ($file in @($candidateLauncher, (Join-Path $candidateApp 'VideoCutTool.exe'), (Join-Path $candidateApp 'resources/app.asar'), (Join-Path $candidateApp 'resources/bin/ffmpeg.exe'), (Join-Path $candidateApp 'resources/bin/ffprobe.exe'))) { Require-File $file }
  & node -e "const a=require('@electron/asar');const p=require('path');const f=a.listPackage(p.join(process.argv[1],'resources/app.asar'));for(const x of ['/dist/index.html','/dist-electron/main.js','/dist-electron/preload.cjs'])if(!f.some(y=>y.replaceAll(String.fromCharCode(92),'/')===x))throw Error('Missing '+x)" $candidateApp
  if ($LASTEXITCODE -ne 0) { throw '应用内容验证失败，旧便携版本保持原状' }
  foreach ($tool in @('ffmpeg', 'ffprobe')) {
    & (Join-Path $candidateApp "resources/bin/$tool.exe") -version | Select-Object -First 1
    if ($LASTEXITCODE -ne 0) { throw "包内 $tool 不可运行" }
  }
  [IO.File]::WriteAllText((Join-Path $candidatePath 'candidate.json'), (@{ path = $candidatePath; builtAt = [DateTime]::UtcNow.ToString('o'); buildOnly = [bool]$BuildOnly } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  if ($BuildOnly) { Write-Host "候选包验证通过，尚未替换发布目录：$candidatePath"; exit 0 }

  $targetApp = Join-Path $releasePath 'app'
  $targetLauncher = Join-Path $releasePath 'VideoCutTool.exe'
  foreach ($pointer in @((Join-Path $releasePath 'workspace.json'), (Join-Path $releasePath 'config.json'))) {
    if (Test-Path -LiteralPath $pointer) {
      $data = [IO.File]::ReadAllText($pointer) | ConvertFrom-Json
      if ($data.dataDirectory) {
        $dataPath = [IO.Path]::GetFullPath($data.dataDirectory)
        if ($dataPath -eq $targetApp -or $dataPath.StartsWith($targetApp + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "工作数据位于 app 内，替换前需将其迁出。候选包保留：$candidatePath" }
      }
    }
  }
  $occupied = Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and ($_.Path -eq $targetLauncher -or $_.Path.StartsWith($targetApp + '\', [StringComparison]::OrdinalIgnoreCase)) } catch { $false } }
  if ($occupied) { throw "旧版本正在运行，请关闭相关实例后重新打包。候选包保留：$candidatePath" }
  New-Item -ItemType Directory -Path $releasePath -Force | Out-Null
  $backup = Join-Path $candidatePath 'previous'; New-Item -ItemType Directory -Path $backup | Out-Null
  $movedApp = $false; $movedLauncher = $false; $installedApp = $false; $installedLauncher = $false
  try {
    if (Test-Path -LiteralPath $targetApp) { Move-Owned $targetApp (Join-Path $backup 'app'); $movedApp = $true }
    if (Test-Path -LiteralPath $targetLauncher) { Move-Owned $targetLauncher (Join-Path $backup 'VideoCutTool.exe'); $movedLauncher = $true }
    Move-Owned $candidateApp $targetApp; $installedApp = $true
    Move-Owned $candidateLauncher $targetLauncher; $installedLauncher = $true
  } catch {
    $publishError = $_
    if ($installedLauncher) { Move-Owned $targetLauncher $candidateLauncher }
    if ($installedApp) { Move-Owned $targetApp $candidateApp }
    if ($movedApp) { Move-Owned (Join-Path $backup 'app') $targetApp }
    if ($movedLauncher) { Move-Owned (Join-Path $backup 'VideoCutTool.exe') $targetLauncher }
    throw $publishError
  }
  Write-Host "便携包已更新：$targetLauncher。原工作区指针保持原状，上一版保留在 $backup"
} catch { Write-Error $_ -ErrorAction Continue; exit 1 }
finally { Pop-Location }
