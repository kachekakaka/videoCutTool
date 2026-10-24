# 只清理本模块登记的自产资产；不按目录名猜测归属。
$script:ArtifactUtf8 = [Text.UTF8Encoding]::new($false)
if (-not ('VctArtifactFile' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class VctArtifactFile {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out Info info);
  public static string Identity(string path) {
    using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
      Info info; if(!GetFileInformationByHandle(file.SafeFileHandle,out info)) throw new System.ComponentModel.Win32Exception();
      return info.Volume.ToString("x8")+":"+info.IndexHigh.ToString("x8")+info.IndexLow.ToString("x8");
    }
  }
}
'@
}

function Get-ArtifactContext([string]$Repository) {
  $repo = [IO.Path]::GetFullPath($Repository)
  $temporary = [IO.Path]::GetFullPath((Join-Path $repo '../videoCutTool_tmp'))
  @{ Repository=$repo; Temporary=$temporary; Release=(Join-Path $repo 'release'); Registry=(Join-Path $temporary '.artifact-maintenance') }
}
function Assert-ArtifactPath([string]$Path, [string]$Root) {
  $target = [IO.Path]::GetFullPath($Path)
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
  if (-not $target.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) { throw "产物路径越界：$target" }
  $current = $target
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "产物路径含链接：$current" }
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if ($parent -eq $current) { break }; $current = $parent
  }
  $target
}
function Test-ArtifactProtected([string]$Relative,[switch]$AllowMedia) {
  $parts = $Relative -split '[\\/]'
  foreach ($part in $parts) {
    if ($part -match '^(config\.json|workspace\.json|plans|datas|acceptance|screenshots|.*(?:result|report|walkthrough|验收|报告).*)$') { return $true }
  }
  return ($Relative -match '\.(md|html|png|jpg)$' -or (-not $AllowMedia -and $Relative -match '\.(mp4|mkv|flv|mov)$')) -and $Relative -notmatch '^(app|win-unpacked)[\\/]'
}
function Write-ArtifactJson([string]$Path, $Value) {
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try { [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), $script:ArtifactUtf8); [IO.File]::Move($temporary,$Path,$true) }
  finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
function Use-ArtifactLock($Context, [scriptblock]$Work) {
  New-Item -ItemType Directory -Path $Context.Registry -Force | Out-Null
  $lock = Assert-ArtifactPath (Join-Path $Context.Registry 'maintenance.lock') $Context.Temporary
  $token = [guid]::NewGuid().ToString('N')
  if (Test-Path -LiteralPath $lock) {
    $old = [IO.File]::ReadAllText($lock) | ConvertFrom-Json
    if (-not $old.token -or -not $old.pid -or (Get-Process -Id $old.pid -ErrorAction SilentlyContinue)) { throw '产物维护正在运行，或锁归属不明' }
    $again = [IO.File]::ReadAllText($lock) | ConvertFrom-Json
    if ($again.token -ne $old.token) { throw '产物维护锁已变化' }
    Remove-Item -LiteralPath $lock -Force
  }
  $handle = [IO.File]::Open($lock,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try { $bytes=$script:ArtifactUtf8.GetBytes((@{pid=$PID;token=$token}|ConvertTo-Json -Compress));$handle.Write($bytes);$handle.Flush() } finally { $handle.Dispose() }
  try { & $Work } finally {
    if (Test-Path -LiteralPath $lock) { $owner=[IO.File]::ReadAllText($lock)|ConvertFrom-Json; if ($owner.token -eq $token) { Remove-Item -LiteralPath $lock -Force } }
  }
}
function Get-ArtifactFiles([string]$Root, [string[]]$Members=@(),[switch]$AllowMedia) {
  $files = @{}
  $targets = if ($Members.Count) { @($Members | ForEach-Object { Join-Path $Root $_ }) } else { @($Root) }
  foreach ($target in $targets) {
    $items = @(Get-Item -LiteralPath $target -Force -ErrorAction Stop)
    if ($items[0].PSIsContainer) { $items = @(Get-ChildItem -LiteralPath $target -Recurse -Force -ErrorAction Stop) }
    foreach ($item in $items) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "产物含链接：$($item.FullName)" }
      if ($item.PSIsContainer) { continue }
      $relative = [IO.Path]::GetRelativePath($Root,$item.FullName)
      if (Test-ArtifactProtected $relative -AllowMedia:$AllowMedia) { throw "产物含受保护资料：$relative" }
      $item.Refresh()
      $files[$relative]=@{bytes=$item.Length;ticks=$item.LastWriteTimeUtc.Ticks;identity=[VctArtifactFile]::Identity($item.FullName)}
    }
  }
  $files
}
function Save-ArtifactRecord($Context,$Record) { Write-ArtifactJson (Join-Path $Context.Registry "$($Record.id).json") $Record }
function Read-ArtifactRecords($Context) {
  @(Get-ChildItem -LiteralPath $Context.Registry -File -Filter '*.json' | ForEach-Object {
    try { $record=[IO.File]::ReadAllText($_.FullName)|ConvertFrom-Json -AsHashtable; if ($record.version -ne 1 -or $_.BaseName -ne $record.id -or $record.id -notmatch '^[a-f0-9-]{36}$' -or $record.kind -notin @('candidate','release','current','verification')) { throw '登记不合法' }; $record }
    catch { Write-Warning "跳过损坏产物登记：$($_.Exception.Message)" }
  })
}
function Assert-ArtifactOutsideEvidence([string]$Path,[string[]]$EvidenceDirectories) {
  $target=[IO.Path]::GetFullPath($Path).TrimEnd('\','/')
  foreach($directory in $EvidenceDirectories){
    $evidence=[IO.Path]::GetFullPath($directory).TrimEnd('\','/')
    if($target.Equals($evidence,[StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($evidence+'\',[StringComparison]::OrdinalIgnoreCase) -or $evidence.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase)){throw '回收范围与受保护验收目录重叠'}
  }
}
function Get-ArtifactEvidenceDirectories($Context,$Records) {
  # 已回收素材的登记也继续保护其验收目录；无法核对时停止清理。
  @($Records|Where-Object {$_.evidence}|ForEach-Object {Assert-ArtifactPath $_.evidence $Context.Temporary})
}
function Assert-PortableSnapshot($Context,$Record,[string[]]$EvidenceDirectories) {
  $allowed=if($Record.kind -eq 'release'){$Context.Release}else{$Context.Temporary}
  $root=Assert-ArtifactPath $Record.root $allowed
  if($Record.kind -eq 'candidate' -and [IO.Path]::GetRelativePath($Context.Temporary,$root) -notmatch '^portable-[a-f0-9]{32}([\\/]previous)?$'){throw '候选根不合法'}
  if($Record.kind -eq 'release' -and [IO.Path]::GetDirectoryName($root) -ne $Context.Release){throw '发布根不合法'}
  Assert-ArtifactOutsideEvidence $root $EvidenceDirectories
  $actual=Get-ArtifactFiles $root
  foreach($required in @('VideoCutTool.exe','app/VideoCutTool.exe','app/resources/app.asar','app/resources/bin/ffmpeg.exe','app/resources/bin/ffprobe.exe')){
    $name=$required.Replace('/',[IO.Path]::DirectorySeparatorChar)
    if(-not $actual.ContainsKey($name) -or $actual[$name].bytes -le 0){throw "保留副本缺少有效文件：$name"}
  }
  if(-not $Record.files -or $actual.Count -ne $Record.files.Count){throw '保留副本条目有增减'}
  foreach($name in $actual.Keys){if(-not $Record.files.ContainsKey($name) -or $actual[$name].bytes -ne $Record.files[$name].bytes -or $actual[$name].ticks -ne $Record.files[$name].ticks -or $actual[$name].identity -ne $Record.files[$name].identity){throw "保留副本已变化：$name"}}
  if($Record.kind -eq 'release'){
    if(-not $Record.zip -or -not $Record.zipStamp){throw '保留发布副本缺少 ZIP 登记'}
    $zip=Assert-ArtifactPath $Record.zip $Context.Release
    Assert-ArtifactOutsideEvidence $zip $EvidenceDirectories
    $item=Get-Item -LiteralPath $zip -ErrorAction Stop
    if($item.Length -ne $Record.zipStamp.bytes -or $item.LastWriteTimeUtc.Ticks -ne $Record.zipStamp.ticks -or [VctArtifactFile]::Identity($zip) -ne $Record.zipStamp.identity){throw '保留 ZIP 已变化'}
  }
}
function Get-PortableRetention($Context,$Records,[string]$Kind,[string[]]$EvidenceDirectories) {
  $count=0
  foreach($record in @($Records|Where-Object {$_.kind -eq $Kind -and $_.state -eq 'ready' -and -not $_.pinned}|Sort-Object created -Descending)){
    try{Assert-PortableSnapshot $Context $record $EvidenceDirectories}
    catch{Write-Warning "副本不计入可靠保留数量：$($record.root)：$($_.Exception.Message)";continue}
    $record
    if(++$count -eq 2){break}
  }
}
function Start-PortableArtifact([string]$Repository,[string]$Path) {
  $ctx=Get-ArtifactContext $Repository
  Use-ArtifactLock $ctx {
    $target=Assert-ArtifactPath $Path $ctx.Temporary
    Assert-ArtifactOutsideEvidence $target @(Get-ArtifactEvidenceDirectories $ctx @(Read-ArtifactRecords $ctx))
    if ([IO.Path]::GetFileName($target) -notmatch '^portable-[a-f0-9]{32}$') { throw '候选目录名称不合法' }
    if (Test-Path -LiteralPath $target) { throw '候选目录已存在，不得认领旧目录' }
    $expected=@{'VideoCutTool.exe'=$true;'candidate.json'=$true;'builder-debug.yml'=$true;'builder-effective-config.yaml'=$true}
    $electron=Join-Path $ctx.Repository 'node_modules/electron/dist'
    foreach($prefix in @('app','win-unpacked')){
      if(Test-Path -LiteralPath $electron){foreach($file in @(Get-ChildItem -LiteralPath $electron -Recurse -File)){$expected[(Join-Path $prefix ([IO.Path]::GetRelativePath($electron,$file.FullName)))]=$true}}
      # electron-builder 将 Electron 原始 LICENSE 重命名后随包分发。
      foreach($name in @('LICENSE.electron.txt','resources/app.asar','resources/bin/ffmpeg.exe','resources/bin/ffprobe.exe','VideoCutTool.exe')){$expected[(Join-Path $prefix $name)]=$true}
    }
    $record=@{version=1;id=[guid]::NewGuid().ToString();root=$target;kind='candidate';state='building';owner=$PID;created=[DateTime]::UtcNow.Ticks;files=@{};expected=$expected;pinned=$false}
    Save-ArtifactRecord $ctx $record
    New-Item -ItemType Directory -Path $target | Out-Null
    $record.id
  }
}
function Complete-PortableArtifact([string]$Repository,[string]$Id,[bool]$Succeeded) {
  $ctx=Get-ArtifactContext $Repository
  Use-ArtifactLock $ctx {
    $record=@(Read-ArtifactRecords $ctx | Where-Object id -EQ $Id)[0]
    if (-not $record -or $record.owner -ne $PID -or $record.state -ne 'building') { throw '候选归属或状态不匹配' }
    Assert-ArtifactPath $record.root $ctx.Temporary | Out-Null
    if ($Succeeded) {
      foreach ($name in @('VideoCutTool.exe','app/VideoCutTool.exe','app/resources/app.asar','app/resources/bin/ffmpeg.exe','app/resources/bin/ffprobe.exe')) { if (-not (Test-Path -LiteralPath (Join-Path $record.root $name) -PathType Leaf)) { throw "候选必要文件缺失：$name" } }
    }
    $record.files=Get-ArtifactFiles $record.root
    foreach($name in $record.files.Keys){if(-not $record.expected.ContainsKey($name)){throw "构建含事前未登记文件：$name"}}
    $record.state=if($Succeeded){'ready'}else{'failed'}; $record.verified=$Succeeded; $record.completed=[DateTime]::UtcNow.Ticks; $record.owner=0
    Save-ArtifactRecord $ctx $record
  }
}
function Register-CurrentPortable([string]$Repository,[string]$CandidateId,[string]$PreviousPath) {
  $ctx=Get-ArtifactContext $Repository
  Use-ArtifactLock $ctx {
    $records=@(Read-ArtifactRecords $ctx)
    $candidate=@($records | Where-Object id -EQ $CandidateId)[0]
    if (-not $candidate -or $candidate.state -ne 'ready') { throw '候选尚未验证' }
    $current=@($records | Where-Object {$_.kind -eq 'current' -and $_.pinned -and $_.root -eq $ctx.Release})
    foreach ($old in $current) {
      $old.root=Assert-ArtifactPath $PreviousPath $ctx.Temporary; $old.kind='candidate';$old.pinned=$false
      # 只迁移已有登记；没有登记的历史 previous 不自动认领。
      Save-ArtifactRecord $ctx $old
    }
    $candidate.state='transferred'; Save-ArtifactRecord $ctx $candidate
    $new=@{version=1;id=[guid]::NewGuid().ToString();root=$ctx.Release;kind='current';state='ready';owner=0;created=$candidate.created;completed=[DateTime]::UtcNow.Ticks;files=(Get-ArtifactFiles $ctx.Release @('app','VideoCutTool.exe'));pinned=$true;sourceId=$CandidateId}
    Save-ArtifactRecord $ctx $new
  }
}
function Register-PortableRelease([string]$Repository,[string]$CandidateId,[string]$Directory,[string]$Zip,[switch]$Verified,[switch]$Keep) {
  if (-not $Verified) { throw '仅允许登记已经完成实际验收的发布副本，需显式指定 -Verified' }
  $ctx=Get-ArtifactContext $Repository
  Use-ArtifactLock $ctx {
    $source=@(Read-ArtifactRecords $ctx | Where-Object {$_.id -eq $CandidateId -and $_.verified -eq $true -and $_.state -in @('ready','transferred','deleted') -and $_.kind -eq 'candidate'})[0]
    if (-not $source) { throw '关联的合格候选不存在' }
    $dir=Assert-ArtifactPath $Directory $ctx.Release; $zipPath=Assert-ArtifactPath $Zip $ctx.Release
    if ([IO.Path]::GetDirectoryName($dir) -ne $ctx.Release -or [IO.Path]::GetDirectoryName($zipPath) -ne $ctx.Release -or [IO.Path]::GetExtension($zipPath) -ne '.zip') { throw '发布副本必须直接位于 release 内' }
    $files=Get-ArtifactFiles $dir
    $expected=@{}; foreach($name in $source.files.Keys){if($name -eq 'VideoCutTool.exe' -or $name -match '^app[\\/]'){$expected[$name]=$source.files[$name]}}
    if ($files.Count -ne $expected.Count) { throw '发布目录条目与候选不一致' }
    foreach($name in $files.Keys){ if(-not $expected.ContainsKey($name) -or $files[$name].bytes -ne $expected[$name].bytes){throw "发布文件与候选不一致：$name"} }
    $archive=[IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
      $entries=@($archive.Entries|Where-Object {$_.Name})
      if($entries.Count -ne $expected.Count){throw 'ZIP 条目与候选不一致'}
      $seen=@{}
      foreach($entry in $entries){$name=$entry.FullName.Replace('/',[IO.Path]::DirectorySeparatorChar);if($seen.ContainsKey($name) -or (Test-ArtifactProtected $name) -or -not $expected.ContainsKey($name) -or $entry.Length -ne $expected[$name].bytes){throw "ZIP 含未知、重复或不匹配条目：$name"};$seen[$name]=$true}
    } finally {$archive.Dispose()}
    if(@(Read-ArtifactRecords $ctx|Where-Object {$_.state -ne 'deleted' -and ($_.root -eq $dir -or $_.zip -eq $zipPath)}).Count){throw '该发布副本已经登记'}
    $record=@{version=1;id=[guid]::NewGuid().ToString();root=$dir;zip=$zipPath;zipStamp=@{bytes=(Get-Item -LiteralPath $zipPath).Length;ticks=(Get-Item -LiteralPath $zipPath).LastWriteTimeUtc.Ticks;identity=[VctArtifactFile]::Identity($zipPath)};kind='release';state='ready';owner=0;created=[DateTime]::UtcNow.Ticks;files=$files;pinned=[bool]$Keep;sourceId=$CandidateId}
    Save-ArtifactRecord $ctx $record
  }
}
function Register-VerificationArtifact([string]$Repository,[string]$Path,[string[]]$Files,[string]$EvidenceDirectory) {
  $ctx=Get-ArtifactContext $Repository
  Use-ArtifactLock $ctx {
    $target=Assert-ArtifactPath $Path $ctx.Temporary
    $evidence=Assert-ArtifactPath $EvidenceDirectory $ctx.Temporary
    if(-not (Test-Path -LiteralPath $evidence -PathType Container)){throw '验收证据必须先落盘到回收目录之外'}
    $evidenceDirectories=@(Get-ArtifactEvidenceDirectories $ctx @(Read-ArtifactRecords $ctx)) + @($evidence)
    Assert-ArtifactOutsideEvidence $target $evidenceDirectories
    if(Test-ArtifactProtected ([IO.Path]::GetRelativePath($ctx.Temporary,$target)) -AllowMedia){throw '验证回收目录位于受保护资料范围'}
    $snapshot=@{}
    foreach($relative in $Files){$file=Assert-ArtifactPath (Join-Path $target $relative) $target;if(Test-ArtifactProtected $relative -AllowMedia){throw "验证资料不可回收：$relative"};$item=Get-Item -LiteralPath $file;if($item.PSIsContainer){throw '验证素材必须逐文件登记'};$snapshot[$relative]=@{bytes=$item.Length;ticks=$item.LastWriteTimeUtc.Ticks;identity=[VctArtifactFile]::Identity($file)}}
    $record=@{version=1;id=[guid]::NewGuid().ToString();root=$target;kind='verification';state='ready';owner=0;created=[DateTime]::UtcNow.Ticks;files=$snapshot;pinned=$false;evidence=$evidence}
    Save-ArtifactRecord $ctx $record
  }
}
function Invoke-PortableArtifactCleanup([string]$Repository,[switch]$Apply,[DateTime]$Now=[DateTime]::UtcNow) {
  $ctx=Get-ArtifactContext $Repository
  Use-ArtifactLock $ctx {
    $records=@(Read-ArtifactRecords $ctx)
    $evidenceDirectories=@(Get-ArtifactEvidenceDirectories $ctx $records)
    $keepCandidates=@(Get-PortableRetention $ctx $records 'candidate' $evidenceDirectories)
    $keepReleases=@(Get-PortableRetention $ctx $records 'release' $evidenceDirectories)
    # 查询失败时整个执行停止，不能把未知占用解释为无人使用。
    $processes=@(Get-CimInstance Win32_Process -ErrorAction Stop)
    foreach($record in $records){
      if($record.pinned -or $record.kind -eq 'current' -or $record.state -eq 'deleted' -or $record.id -in $keepCandidates.id -or $record.id -in $keepReleases.id){continue}
      if($record.state -eq 'transferred'){continue}
      if($record.state -eq 'failed' -and $Now.Ticks - $record.completed -lt [TimeSpan]::FromHours(24).Ticks){continue}
      try{
        $allowed=if($record.kind -eq 'release'){$ctx.Release}else{$ctx.Temporary}
        $root=Assert-ArtifactPath $record.root $allowed
        if($record.kind -eq 'candidate' -and [IO.Path]::GetRelativePath($ctx.Temporary,$root) -notmatch '^portable-[a-f0-9]{32}([\\/]previous)?$'){throw '候选根不合法'}
        if($record.kind -eq 'release' -and [IO.Path]::GetDirectoryName($root) -ne $ctx.Release){throw '发布根不合法'}
        Assert-ArtifactOutsideEvidence $root $evidenceDirectories
        if($record.kind -eq 'verification' -and (Test-ArtifactProtected ([IO.Path]::GetRelativePath($ctx.Temporary,$root)) -AllowMedia)){throw '验证回收目录位于受保护资料范围'}
        if($record.zip){Assert-ArtifactOutsideEvidence $record.zip $evidenceDirectories}
        if($record.owner -and (Get-Process -Id $record.owner -ErrorAction SilentlyContinue)){throw '所属构建仍在运行'}
        foreach($proc in $processes){if(($proc.ExecutablePath -and $proc.ExecutablePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) -or ($proc.CommandLine -and $proc.CommandLine.Contains($root))){throw '产物仍被运行进程使用'}}
        $actual=if($record.state -eq 'deleting' -and -not (Test-Path -LiteralPath $root)){@{}}else{Get-ArtifactFiles $root -AllowMedia:($record.kind -eq 'verification')}
        if($record.state -eq 'building'){
          if($Now.Ticks-$record.created -lt [TimeSpan]::FromHours(24).Ticks){throw '异常候选尚在诊断保留期'}
          foreach($name in $actual.Keys){if(-not $record.expected -or -not $record.expected.ContainsKey($name)){throw '异常构建含未预先登记文件'}}
          $record.files=$actual;$record.state='failed';$record.completed=$record.created
          if($Apply){Save-ArtifactRecord $ctx $record}
        }
        if($record.state -ne 'deleting' -and $actual.Count -ne $record.files.Count){throw '产物条目有增减，跳过未知内容'}
        foreach($name in $actual.Keys){if(-not $record.files.ContainsKey($name) -or $actual[$name].bytes -ne $record.files[$name].bytes -or $actual[$name].ticks -ne $record.files[$name].ticks -or $actual[$name].identity -ne $record.files[$name].identity){throw "产物已变化：$name"}}
        if($record.zip){$zip=Assert-ArtifactPath $record.zip $ctx.Release;$item=Get-Item -LiteralPath $zip;if($item.Length -ne $record.zipStamp.bytes -or $item.LastWriteTimeUtc.Ticks -ne $record.zipStamp.ticks -or [VctArtifactFile]::Identity($zip) -ne $record.zipStamp.identity){throw 'ZIP 已变化'}}
        if($record.kind -in @('candidate','release') -and ($record.state -eq 'ready' -or ($record.state -eq 'deleting' -and $record.requiresRetainedCopies -ne $false))){
          $retained=if($record.kind -eq 'candidate'){@($keepCandidates)}else{@($keepReleases)}
          if(@($retained).Count -lt 2){throw '完整保留副本不足，暂缓淘汰旧包'}
          # 删除前再次核对保留副本，防止本轮核对后被外部移动或改写。
          foreach($copy in $retained){Assert-PortableSnapshot $ctx $copy $evidenceDirectories}
        }
        if(-not $Apply){[pscustomobject]@{Path=$root;Action='would-delete';Files=$actual.Count};continue}
        if($record.state -ne 'deleting'){$record.requiresRetainedCopies=($record.state -eq 'ready')}
        $record.state='deleting';Save-ArtifactRecord $ctx $record
        # 不递归删除目录：只删除逐项核对过的文件，新增文件会阻止目录移除。
        foreach($name in @($actual.Keys)){$file=Assert-ArtifactPath (Join-Path $root $name) $root;$item=Get-Item -LiteralPath $file;$item.Refresh();if($item.Length -ne $actual[$name].bytes -or $item.LastWriteTimeUtc.Ticks -ne $actual[$name].ticks -or [VctArtifactFile]::Identity($file) -ne $actual[$name].identity){throw '删除前文件发生变化'};Remove-Item -LiteralPath $file -Force -ErrorAction Stop}
        if(Test-Path -LiteralPath $root){
          foreach($dir in @(Get-ChildItem -LiteralPath $root -Directory -Recurse -Force|Sort-Object {$_.FullName.Length} -Descending)){Assert-ArtifactPath $dir.FullName $root|Out-Null;if(@(Get-ChildItem -LiteralPath $dir.FullName -Force).Count -eq 0){[IO.Directory]::Delete($dir.FullName,$false)}}
          if(@(Get-ChildItem -LiteralPath $root -Force).Count -ne 0){throw '仍有未知内容，保留目录'}
          [IO.Directory]::Delete($root,$false)
        }
        if($record.zip){$item=Get-Item -LiteralPath $zip;$item.Refresh();if($item.Length -ne $record.zipStamp.bytes -or $item.LastWriteTimeUtc.Ticks -ne $record.zipStamp.ticks -or [VctArtifactFile]::Identity($zip) -ne $record.zipStamp.identity){throw '删除前 ZIP 已变化'};Remove-Item -LiteralPath $zip -Force -ErrorAction Stop}
        $record.state='deleted';Save-ArtifactRecord $ctx $record
        [pscustomobject]@{Path=$root;Action='deleted';Files=$actual.Count}
      }catch{ $reason=$_.Exception.Message;if($Apply){$record.lastCleanupError=$reason;try{Save-ArtifactRecord $ctx $record}catch{Write-Warning '清理原因无法写回登记'}};[pscustomobject]@{Path=$record.root;Action='skip';Reason=$reason}}
    }
    # 程序和 previous 均已转移/淘汰后，收掉仍属本次构建的少量根元数据。
    foreach($record in @($records|Where-Object state -EQ 'transferred')){
      try{
        $root=Assert-ArtifactPath $record.root $ctx.Temporary
        Assert-ArtifactOutsideEvidence $root $evidenceDirectories
        if(-not (Test-Path -LiteralPath $root)){continue}
        $previous=Join-Path $root 'previous'
        if(Test-Path -LiteralPath $previous){Assert-ArtifactPath $previous $root|Out-Null;if(@(Get-ChildItem -LiteralPath $previous -Force).Count){continue}}
        $actual=Get-ArtifactFiles $root
        foreach($name in $actual.Keys){if($name -notin @('candidate.json','builder-debug.yml','builder-effective-config.yaml') -or -not $record.files.ContainsKey($name) -or $actual[$name].identity -ne $record.files[$name].identity -or $actual[$name].bytes -ne $record.files[$name].bytes -or $actual[$name].ticks -ne $record.files[$name].ticks){throw '已转移候选含新增或变化的内容'}}
        if(-not $Apply){[pscustomobject]@{Path=$root;Action='would-delete-metadata';Files=$actual.Count};continue}
        foreach($name in $actual.Keys){$file=Assert-ArtifactPath (Join-Path $root $name) $root;$item=Get-Item -LiteralPath $file;$item.Refresh();if([VctArtifactFile]::Identity($file) -ne $actual[$name].identity -or $item.Length -ne $actual[$name].bytes -or $item.LastWriteTimeUtc.Ticks -ne $actual[$name].ticks){throw '构建元数据身份已变化'};Remove-Item -LiteralPath $file -Force}
        if(Test-Path -LiteralPath $previous){[IO.Directory]::Delete($previous,$false)}
        if(@(Get-ChildItem -LiteralPath $root -Force).Count){throw '仍有未知目录，保留容器'}
        [IO.Directory]::Delete($root,$false);$record.state='deleted';Save-ArtifactRecord $ctx $record
      }catch{[pscustomobject]@{Path=$record.root;Action='skip';Reason=$_.Exception.Message}}
    }
  }
}
