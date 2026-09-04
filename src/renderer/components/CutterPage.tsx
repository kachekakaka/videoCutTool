import React, { useState, useRef, useEffect, useCallback } from 'react';
import { MediaMetadata, Segment, RetentionDecision, MediaRetentionPlan, PlanRecord } from '../../shared/types';
import { VideoPlayer, VideoPlayerRef, formatTimecode } from './VideoPlayer';
import { Timeline } from './Timeline';
import { SegmentCardsGrid } from './SegmentCardsGrid';
import { planRetention } from '../../shared/RetentionPlanner';
import {
  Film,
  Scissors,
  Save,
  Rocket,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Undo2,
  Redo2,
  FolderOpen,
  ExternalLink,
  UploadCloud,
} from 'lucide-react';

interface CutterPageProps {
  onOpenVideo: () => void;
  initialVideoPath?: string | null;
  loadedPlanRecord?: PlanRecord | null;
  onPlanSaved?: () => void;
}

interface HistoryState {
  cuts: number[];
  decisions: Record<string, RetentionDecision>;
}

export const CutterPage: React.FC<CutterPageProps> = ({
  onOpenVideo,
  initialVideoPath,
  loadedPlanRecord,
  onPlanSaved,
}) => {
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isKeyframeScanning, setIsKeyframeScanning] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // 切点与决策主状态
  const [cuts, setCuts] = useState<number[]>([]);
  const [decisions, setDecisions] = useState<Record<string, RetentionDecision>>({});

  // 历史栈支持撤销/重做 (Undo / Redo)
  const [history, setHistory] = useState<HistoryState[]>([]);
  const [future, setFuture] = useState<HistoryState[]>([]);

  // 试听区间、合并开关与封面策略
  const [auditionRange, setAuditionRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [concatSingleFile, setConcatSingleFile] = useState(true);
  const [stripOriginalCover, setStripOriginalCover] = useState(true);

  // 播放状态与画面比例
  const [isPlaying, setIsPlaying] = useState(false);
  const [aspectRatioMode, setAspectRatioMode] = useState<'auto' | '16:9' | '1:1'>('auto');

  // 安全产物预定路径 (防重名递增预显)
  const [safeOutputPath, setSafeOutputPath] = useState<string>('');

  // 执行与提示状态
  const [executing, setExecuting] = useState(false);
  const [lastExportedPath, setLastExportedPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);

  // 实时推导预定安全产物路径
  useEffect(() => {
    if (!metadata?.filePath) {
      setSafeOutputPath('');
      return;
    }
    let isCancelled = false;
    if (window.electronAPI?.resolveOutputPath) {
      window.electronAPI
        .resolveOutputPath(metadata.filePath, concatSingleFile)
        .then((resolved) => {
          if (!isCancelled) {
            setSafeOutputPath(resolved);
          }
        })
        .catch((err) => {
          console.warn('推导安全输出路径失败:', err);
        });
    }
    return () => {
      isCancelled = true;
    };
  }, [metadata?.filePath, concatSingleFile, lastExportedPath]);

  const playerRef = useRef<VideoPlayerRef | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 双保险文件选择唤起逻辑 (Electron 原生对话框 + HTML5 文件选择器兜底)
  const handleChooseFile = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();

    // 1. 尝试 Electron 原生对话框
    if (window.electronAPI) {
      try {
        const filePath = await window.electronAPI.openVideoDialog();
        if (filePath) {
          loadAndProbeVideo(filePath);
          return;
        }
      } catch (err) {
        console.warn('原生对话框调用异常，回退至标准文件选择器', err);
      }
    }

    if (onOpenVideo) {
      onOpenVideo();
      return;
    }

    // 2. 兜底方案：触发内置的 HTML5 文件选择器
    fileInputRef.current?.click();
  };

  const getFilePathFromFile = (file: File): string => {
    if (window.electronAPI?.getPathForFile) {
      try {
        const p = window.electronAPI.getPathForFile(file);
        if (p) return p;
      } catch (err) {
        console.warn('getPathForFile 解析失败:', err);
      }
    }
    return (file as any).path || '';
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const fullPath = getFilePathFromFile(file);
      if (fullPath) {
        loadAndProbeVideo(fullPath);
      } else {
        setNotice({ type: 'error', message: '无法获取视频文件的物理绝对路径，请拖拽载入或使用原生选择框' });
      }
    }
  };

  // 提交新状态至历史栈
  const commitState = (newCuts: number[], newDecisions: Record<string, RetentionDecision>) => {
    setHistory((prev) => [...prev, { cuts, decisions }]);
    setFuture([]); // 产生新操作时清空未来重做栈
    setCuts(newCuts);
    setDecisions(newDecisions);
  };

  // 撤销操作 (Undo, Ctrl+Z)
  const handleUndo = useCallback(() => {
    if (history.length === 0) return;
    const previous = history[history.length - 1];
    setHistory((prev) => prev.slice(0, prev.length - 1));
    setFuture((prev) => [{ cuts, decisions }, ...prev]);
    setCuts(previous.cuts);
    setDecisions(previous.decisions);
  }, [history, cuts, decisions]);

  // 重做操作 (Redo, Ctrl+Y / Ctrl+Shift+Z)
  const handleRedo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture((prev) => prev.slice(1));
    setHistory((prev) => [...prev, { cuts, decisions }]);
    setCuts(next.cuts);
    setDecisions(next.decisions);
  }, [future, cuts, decisions]);

  // 全局快捷键监听撤销与重做
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo]);

  // 载入视频并探测关键帧 (两阶段秒开机制：300ms 快速出图，后台静默扫描关键帧并落盘缓存)
  const loadAndProbeVideo = async (filePath: string) => {
    setIsLoading(true);
    setIsKeyframeScanning(false);
    setNotice(null);
    setLastExportedPath(null);
    try {
      if (window.electronAPI) {
        // 第一阶段：极速读取基本元数据 (<300ms 秒开)
        const basicMeta = window.electronAPI.probeBasic
          ? await window.electronAPI.probeBasic(filePath)
          : await window.electronAPI.probeMedia(filePath);

        setMetadata(basicMeta);
        setCurrentTimeMs(0);
        setHistory([]);
        setFuture([]);

        if (loadedPlanRecord && loadedPlanRecord.sourcePath === filePath) {
          setCuts(loadedPlanRecord.cuts);
          setDecisions(loadedPlanRecord.decisions);
          if (loadedPlanRecord.concatSingleFile !== undefined) {
            setConcatSingleFile(loadedPlanRecord.concatSingleFile);
          }
          if (loadedPlanRecord.stripOriginalCover !== undefined) {
            setStripOriginalCover(loadedPlanRecord.stripOriginalCover);
          }
        } else {
          setCuts([]);
          setDecisions({});
        }

        // 瞬间解除整屏加载遮罩，播放器立即挂载并可播放
        setIsLoading(false);

        // 第二阶段：若未命中本地关键帧缓存，后台异步静默提取物理关键帧
        if (basicMeta.keyframes.length <= 1 && window.electronAPI.probeKeyframes) {
          setIsKeyframeScanning(true);
          window.electronAPI
            .probeKeyframes(filePath)
            .then((keyframes) => {
              setMetadata((prev) => (prev && prev.filePath === filePath ? { ...prev, keyframes } : prev));
              setIsKeyframeScanning(false);
            })
            .catch((scanErr) => {
              console.warn('后台扫描关键帧异常:', scanErr);
              setIsKeyframeScanning(false);
            });
        }
      }
    } catch (err: any) {
      console.error('探测视频失败:', err);
      setNotice({ type: 'error', message: err.message || '探测视频元数据失败' });
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (initialVideoPath) {
      loadAndProbeVideo(initialVideoPath);
    }
  }, [initialVideoPath]);

  // 动态分段列表计算
  const calculateSegments = (): Segment[] => {
    if (!metadata || metadata.durationMs <= 0) return [];

    const sortedCuts = Array.from(new Set([0, ...cuts, metadata.durationMs])).sort((a, b) => a - b);
    const segmentsList: Segment[] = [];

    for (let i = 0; i < sortedCuts.length - 1; i++) {
      const segId = `seg_${i}`;
      const startMs = sortedCuts[i];
      const endMs = sortedCuts[i + 1];
      const decision = decisions[segId] !== undefined ? decisions[segId] : 'keep';

      segmentsList.push({
        id: segId,
        index: i + 1,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        decision,
      });
    }

    return segmentsList;
  };

  const segments = calculateSegments();

  // 插入切点
  const handleInsertCut = () => {
    if (!metadata) return;
    const timeMs = playerRef.current ? playerRef.current.getCurrentTimeMs() : currentTimeMs;

    // 防止在开头或结尾插点
    if (timeMs <= 200 || timeMs >= metadata.durationMs - 200) {
      setNotice({ type: 'warning', message: '不能在视频首尾 200ms 内插入切点' });
      return;
    }
    // 防止与已有切点过近
    const tooClose = cuts.some((c) => Math.abs(c - timeMs) < 200);
    if (tooClose) {
      setNotice({ type: 'warning', message: '切点距离已有标记过近 (需间隔 200ms 以上)' });
      return;
    }

    const newCuts = [...cuts, timeMs].sort((a, b) => a - b);
    commitState(newCuts, decisions);
    setNotice(null);
  };

  // 删除特定切点
  const handleDeleteCut = (cutTimeMs: number) => {
    const newCuts = cuts.filter((c) => c !== cutTimeMs);
    commitState(newCuts, decisions);
    setNotice({ type: 'warning', message: `已移除位于 ${formatTimecode(cutTimeMs, false)} 的切点标记` });
  };

  // 合并某分段至上一段
  const handleMergeSegment = (segmentId: string) => {
    const segIndex = parseInt(segmentId.replace('seg_', ''), 10);
    if (isNaN(segIndex) || segIndex === 0) return;

    const cutIndexToRemove = segIndex - 1;
    if (cuts[cutIndexToRemove] !== undefined) {
      const removedCut = cuts[cutIndexToRemove];
      const newCuts = cuts.filter((_, idx) => idx !== cutIndexToRemove);
      commitState(newCuts, decisions);
      setNotice({
        type: 'warning',
        message: `已删除位于 ${formatTimecode(removedCut, false)} 的切点，并合并相邻分段`,
      });
    }
  };

  // 切换分段决策
  const handleToggleDecision = (segmentId: string, decision: RetentionDecision) => {
    const newDecisions = { ...decisions, [segmentId]: decision };
    commitState(cuts, newDecisions);
  };

  // 试听
  const handleAudition = (startMs: number, endMs: number) => {
    setAuditionRange({ startMs, endMs });
  };

  // 微调起点
  const handleNudgeStart = (segmentId: string, deltaMs: number) => {
    const segIndex = parseInt(segmentId.replace('seg_', ''), 10);
    if (isNaN(segIndex) || segIndex === 0) return;

    const cutIndex = segIndex - 1;
    if (cuts[cutIndex] !== undefined) {
      const updated = [...cuts];
      updated[cutIndex] = Math.max(0, updated[cutIndex] + deltaMs);
      commitState(updated.sort((a, b) => a - b), decisions);
    }
  };

  // 微调终点
  const handleNudgeEnd = (segmentId: string, deltaMs: number) => {
    const segIndex = parseInt(segmentId.replace('seg_', ''), 10);
    if (isNaN(segIndex) || segIndex >= cuts.length) return;

    const cutIndex = segIndex;
    if (cuts[cutIndex] !== undefined) {
      const updated = [...cuts];
      updated[cutIndex] = Math.max(0, updated[cutIndex] + deltaMs);
      commitState(updated.sort((a, b) => a - b), decisions);
    }
  };

  // 统计计算
  const keptDurationMs = segments.filter((s) => s.decision === 'keep').reduce((acc, s) => acc + s.durationMs, 0);
  const discardedDurationMs = segments.filter((s) => s.decision === 'discard').reduce((acc, s) => acc + s.durationMs, 0);

  // 构建方案
  const buildCurrentPlan = async (): Promise<MediaRetentionPlan | null> => {
    if (!metadata || !window.electronAPI) return null;
    const outPath = await window.electronAPI.resolveOutputPath(metadata.filePath, concatSingleFile);

    return planRetention(
      metadata.filePath,
      metadata.durationMs,
      segments,
      metadata.keyframes,
      outPath,
      concatSingleFile,
      stripOriginalCover
    );
  };

  // 存为方案
  const handleSavePlan = async () => {
    if (!metadata || !window.electronAPI) return;
    try {
      const outPath = await window.electronAPI.resolveOutputPath(metadata.filePath, concatSingleFile);
      const planId = loadedPlanRecord ? loadedPlanRecord.id : `plan_${Date.now()}`;

      const record: PlanRecord = {
        id: planId,
        title: metadata.fileName,
        sourcePath: metadata.filePath,
        outputPath: outPath,
        totalDurationMs: metadata.durationMs,
        keptDurationMs,
        cutsCount: cuts.length,
        status: 'ready',
        updatedAt: new Date().toISOString(),
        completedAt: null,
        cuts,
        decisions,
        concatSingleFile,
        stripOriginalCover,
      };

      await window.electronAPI.savePlan(record);
      setNotice({ type: 'success', message: '方案已成功保存至本地方案中心！' });
      if (onPlanSaved) onPlanSaved();
    } catch (err: any) {
      setNotice({ type: 'error', message: err.message || '保存方案失败' });
    }
  };

  // 立即执行剪辑
  const handleExecuteCut = async () => {
    if (!metadata || !window.electronAPI) return;
    setExecuting(true);
    setNotice(null);

    try {
      const plan = await buildCurrentPlan();
      if (!plan) throw new Error('无法生成剪辑方案');
      if (plan.blockers.length > 0) throw new Error(plan.blockers.join('; '));

      const result = await window.electronAPI.executeCut(plan);

      if (result.success) {
        setLastExportedPath(result.outputPath);
        const isMultiSeg = !concatSingleFile && plan.planSegments.length > 1;
        setNotice({
          type: 'success',
          message: isMultiSeg
            ? `剪辑成功！已独立切出 ${plan.planSegments.length} 个视频片段至目标目录 (首段: ${result.outputPath.split(/[\\/]/).pop()})`
            : `剪辑成功！产物已导出至: ${result.outputPath}`,
        });

        const record: PlanRecord = {
          id: loadedPlanRecord ? loadedPlanRecord.id : `plan_${Date.now()}`,
          title: metadata.fileName,
          sourcePath: metadata.filePath,
          outputPath: result.outputPath,
          totalDurationMs: metadata.durationMs,
          keptDurationMs,
          cutsCount: cuts.length,
          status: 'completed',
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          cuts,
          decisions,
          concatSingleFile,
          stripOriginalCover,
        };
        await window.electronAPI.savePlan(record);
        if (onPlanSaved) onPlanSaved();
      } else {
        setNotice({ type: 'error', message: result.error || '剪辑执行失败' });
      }
    } catch (err: any) {
      setNotice({ type: 'error', message: err.message || '执行过程发生异常' });
    } finally {
      setExecuting(false);
    }
  };

  // 在系统文件管理器中定位产物
  const handleRevealInExplorer = () => {
    if (lastExportedPath && window.electronAPI) {
      window.electronAPI.showItemInFolder(lastExportedPath);
    }
  };

  // 打开输出目录 (如果有导出产物则定位产物，否则直达输出目录或原视频所在文件夹)
  const handleOpenOutputFolder = async () => {
    if (!window.electronAPI) return;
    if (lastExportedPath) {
      window.electronAPI.showItemInFolder(lastExportedPath);
      return;
    }
    if (metadata?.filePath) {
      try {
        const outPath = await window.electronAPI.resolveOutputPath(metadata.filePath);
        window.electronAPI.showItemInFolder(outPath);
      } catch {
        window.electronAPI.showItemInFolder(metadata.filePath);
      }
    }
  };

  // 选择自定义输出目录 (唤起系统原生选择目录对话框并实时更新预显路径)
  const handleSelectOutputDir = async () => {
    if (!window.electronAPI) return;
    try {
      const currentDir = safeOutputPath ? safeOutputPath.replace(/[\\/][^\\/]+$/, '') : undefined;
      const selectedDir = await window.electronAPI.selectDirectory(currentDir);
      if (selectedDir) {
        await window.electronAPI.saveConfig({
          outputDirectoryRule: 'custom_fixed',
          customOutputDirectory: selectedDir,
        });
        setNotice({
          type: 'success',
          message: `输出目录已更新为: ${selectedDir}`,
        });
        if (metadata?.filePath) {
          const newPath = await window.electronAPI.resolveOutputPath(metadata.filePath, concatSingleFile);
          setSafeOutputPath(newPath);
        }
      }
    } catch (err: any) {
      setNotice({ type: 'error', message: `设置输出目录失败: ${err?.message || err}` });
    }
  };

  // 拖拽事件处理
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const fullPath = getFilePathFromFile(file);
      if (fullPath) {
        loadAndProbeVideo(fullPath);
      } else {
        setNotice({ type: 'error', message: '未能解析拖拽文件的完整本地路径' });
      }
    }
  };

  // 空状态视图
  if (!metadata) {
    return (
      <div className="flex-1 h-full overflow-y-auto px-8 py-6">
        <div className="max-w-[1360px] mx-auto space-y-6">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileInputChange}
            accept="video/mp4,video/mkv,video/mov,video/avi,video/flv,video/ts,video/webm,video/*"
            className="hidden"
          />

          {notice && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-center justify-between transition-all shadow-lg ${
                notice.type === 'success'
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                  : notice.type === 'warning'
                  ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                  : 'bg-rose-500/15 border-rose-500/30 text-rose-300'
              }`}
            >
              <div className="flex items-center gap-2 font-medium">
                {notice.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0" />
                )}
                <span>{notice.message}</span>
              </div>
              <button onClick={() => setNotice(null)} className="text-zinc-400 hover:text-white text-xs px-1">
                ✕
              </button>
            </div>
          )}

          <div
            onClick={handleChooseFile}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-3xl p-16 flex flex-col items-center justify-center cursor-pointer transition-all ${
              isDraggingOver
                ? 'border-blue-500 bg-blue-500/10 scale-[1.01] shadow-2xl shadow-blue-500/20'
                : 'border-white/15 hover:border-blue-500/50 bg-white/[0.01] hover:bg-blue-500/[0.02]'
            }`}
          >
            <div className="w-16 h-16 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 group-hover:scale-110 group-hover:bg-blue-500/20 transition-all mb-4 shadow-lg shadow-blue-500/10">
              {isLoading ? (
                <Loader2 className="w-8 h-8 animate-spin" />
              ) : isDraggingOver ? (
                <UploadCloud className="w-8 h-8 scale-110 transition-transform text-blue-400" />
              ) : (
                <Film className="w-8 h-8" />
              )}
            </div>
            <h3 className="text-base font-bold text-white mb-1.5">
              {isLoading
                ? '正在秒级解析全片关键帧索引...'
                : isDraggingOver
                ? '松开鼠标即可立即载入视频！'
                : '点击或直接拖入待裁剪视频'}
            </h3>
            <p className="text-xs text-zinc-400 max-w-[420px] text-center leading-relaxed">
              支持直接将 MP4、MKV、MOV、TS 等视频拖入本框。由 FFprobe 在后台建立物理 I-Frame 关键帧索引，严格贯彻向左吸附保全铁律。
            </p>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleChooseFile();
              }}
              className="mt-5 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-2 transition-all shadow-md shadow-blue-500/20 active:scale-95 focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <Film className="w-4 h-4" /> 选择本地视频文件
            </button>
          </div>

          <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 flex items-center justify-between text-xs text-zinc-400">
            <span className="flex items-center gap-2">
              <Scissors className="w-4 h-4 text-blue-400" />
              <span>
                快捷键支持：<b>空格键</b> 播放/暂停，<b>C 键</b> 插入切点，<b>左右方向键</b> 逐帧微调，<b>Ctrl+Z</b> 撤销切点
              </span>
            </span>
            <span className="font-mono text-zinc-400">向左吸附前向 I 帧已全局锁定</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 h-full overflow-hidden px-4 sm:px-6 xl:px-8 py-3 flex flex-col relative min-h-0">
      <div className="w-full max-w-[1360px] mx-auto space-y-2 flex-1 flex flex-col min-h-0">
        {/* 1. 纯净视频画面视窗 (Video Viewport: 100% 视频呈现，弹性拉满) */}
        <VideoPlayer
          ref={playerRef}
          videoPath={metadata.filePath}
          durationMs={metadata.durationMs}
          onTimeUpdate={(ms) => setCurrentTimeMs(ms)}
          onPlayStateChange={(playing) => setIsPlaying(playing)}
          onInsertCut={handleInsertCut}
          aspectRatioMode={aspectRatioMode}
          auditionRange={auditionRange}
          onAuditionEnd={() => setAuditionRange(null)}
        />

        {/* 2. 主时间轴控制台 (Timeline Console: 二合一整合控制条与 Canvas 时间轨) */}
        <div className="shrink-0">
          <Timeline
            durationMs={metadata.durationMs}
            currentTimeMs={currentTimeMs}
            keyframes={metadata.keyframes}
            cuts={cuts}
            segments={segments}
            isPlaying={isPlaying}
            aspectRatioMode={aspectRatioMode}
            onSeek={(ms) => playerRef.current?.seekTo(ms)}
            onDeleteCut={handleDeleteCut}
            onTogglePlay={() => playerRef.current?.togglePlay()}
            onStepFrame={(delta) => playerRef.current?.stepFrame(delta)}
            onStepSeconds={(sec) => playerRef.current?.stepSeconds(sec)}
            onToggleAspectRatio={(mode) => setAspectRatioMode(mode)}
            onInsertCut={handleInsertCut}
          />
        </div>

        {/* 3. 分段卡片流工具条与撤销重做控制 */}
        <div className="flex items-center justify-between pt-0.5 shrink-0">
          <div className="flex items-center gap-3 text-sm font-bold text-white">
            <div className="flex items-center gap-1.5">
              <Scissors className="w-4 h-4 text-blue-400" />
              <span>分段列表（共 {segments.length} 段）</span>
            </div>

            {/* 关键帧后台扫描与索引状态指示 */}
            {isKeyframeScanning ? (
              <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[11px] font-normal animate-pulse">
                <Loader2 className="w-3 h-3 animate-spin text-amber-400" />
                <span>后台建立关键帧索引中...</span>
              </span>
            ) : metadata && metadata.keyframes && metadata.keyframes.length > 1 ? (
              <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300 text-[11px] font-mono font-normal">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                <span>{metadata.keyframes.length} 关键帧已就绪</span>
              </span>
            ) : null}

            {/* 撤销 / 重做按钮组 */}
            <div className="flex items-center bg-black/40 border border-white/10 rounded-lg p-0.5 text-xs font-normal">
              <button
                disabled={history.length === 0}
                onClick={handleUndo}
                className="px-2 py-1 rounded text-zinc-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1 hover:bg-white/10 transition-all active:scale-95"
                title="撤销上一步操作 (Ctrl+Z)"
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>撤销</span>
              </button>
              <button
                disabled={future.length === 0}
                onClick={handleRedo}
                className="px-2 py-1 rounded text-zinc-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1 hover:bg-white/10 transition-all active:scale-95 border-l border-white/10"
                title="重做下一步操作 (Ctrl+Y)"
              >
                <Redo2 className="w-3.5 h-3.5" />
                <span>重做</span>
              </button>
            </div>
          </div>

          <div className="text-xs text-zinc-400">
            按 <kbd className="bg-white/10 px-1.5 py-0.5 rounded text-[11px] font-mono text-zinc-200">C</kbd> 插入切点 · 点击卡片切换保留/丢弃 · 支持单段试听与微调
          </div>
        </div>

        {/* 4. 精炼双行分段卡片流 (单卡锁定 72px 黄金高度，抗挤压排版，零垂直滚动条) */}
        <div className="max-h-[160px] shrink-0 overflow-y-auto overflow-x-hidden pr-0.5">
          <SegmentCardsGrid
            segments={segments}
            auditionRange={auditionRange}
            onToggleDecision={handleToggleDecision}
            onAudition={handleAudition}
            onNudgeStart={handleNudgeStart}
            onNudgeEnd={handleNudgeEnd}
            onMergeWithPrevious={handleMergeSegment}
          />
        </div>

        {/* 5. 底部固定状态 Dock 栏 (深度自适应与防溢出优化，无缝适应小屏与高 DPI) */}
        <div className="mt-auto shrink-0 pt-1 pb-1">
          <div className="px-3 py-2 rounded-2xl bg-[#161b22]/95 border border-white/10 shadow-2xl backdrop-blur-md flex flex-wrap lg:flex-nowrap items-center justify-between gap-2 min-w-0">
            {/* 左侧：统计指标与预定产物名 (自适应收纳与截断保护) */}
            <div className="flex items-center gap-2 sm:gap-2.5 text-xs font-mono shrink min-w-0">
              <div className="whitespace-nowrap hidden 2xl:block">
                <span className="text-zinc-400">原片:</span>{' '}
                <span className="text-white font-bold">{formatTimecode(metadata.durationMs, false)}</span>
              </div>
              <div className="whitespace-nowrap">
                <span className="text-zinc-400">保留:</span>{' '}
                <span className="text-emerald-400 font-bold">{formatTimecode(keptDurationMs, false)}</span>
              </div>
              <div className="whitespace-nowrap">
                <span className="text-zinc-400">丢弃:</span>{' '}
                <span className="text-rose-400 font-bold">{formatTimecode(discardedDurationMs, false)}</span>
              </div>
              <div className="whitespace-nowrap">
                <span className="text-zinc-400">切点:</span>{' '}
                <span className="text-amber-400 font-bold">{cuts.length}</span>
                <span className="hidden sm:inline text-amber-400"> 个</span>
              </div>

              {/* 实时预定产物文件名预览 (点击可在资源管理器中打开，支持弹性截断) */}
              {safeOutputPath && (
                <div
                  onClick={handleOpenOutputFolder}
                  className="flex items-center gap-1.5 text-xs font-mono bg-black/40 px-2 py-1 rounded-lg border border-white/10 shrink min-w-0 cursor-pointer hover:border-white/25 transition-all"
                  title={`点击在文件管理器中打开目标目录\n即将保存至: ${safeOutputPath}`}
                >
                  <span className="text-zinc-400 shrink-0">📁 预定:</span>
                  <span className="text-sky-300 font-bold max-w-[80px] sm:max-w-[120px] 2xl:max-w-[180px] truncate">
                    {safeOutputPath.split(/[\\/]/).pop()}
                  </span>
                </div>
              )}
            </div>

            {/* 中间：剪辑偏好选项组 (合并单文件 + 首帧封面策略，文案响应式简写) */}
            <div className="flex items-center gap-2 sm:gap-2.5 text-xs text-zinc-300 select-none shrink-0 mx-0.5">
              <label className="flex items-center gap-1 cursor-pointer hover:text-white transition-colors" title="多个保留片段是否拼接合并为一个视频文件">
                <input
                  type="checkbox"
                  checked={concatSingleFile}
                  onChange={(e) => setConcatSingleFile(e.target.checked)}
                  className="w-3.5 h-3.5 accent-blue-500 rounded cursor-pointer"
                />
                <span>
                  <span className="hidden xl:inline">多保留段</span>
                  <span className="xl:hidden">多段</span>合并
                </span>
              </label>

              <label className="flex items-center gap-1 cursor-pointer hover:text-white transition-colors" title="勾选后剥离原片固定封面，让切片视频自动展示各段首帧画面，防止所有切片封面雷同">
                <input
                  type="checkbox"
                  checked={stripOriginalCover}
                  onChange={(e) => setStripOriginalCover(e.target.checked)}
                  className="w-3.5 h-3.5 accent-blue-500 rounded cursor-pointer"
                />
                <span>
                  <span className="hidden xl:inline">自适应</span>首帧封面
                </span>
              </label>
            </div>

            {/* 右侧动作按钮组 (紧凑排布，零溢出保证) */}
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 ml-auto lg:ml-0">
              {/* 输出目录组合按键：点击更改目录，侧边一键打开 */}
              <div className="flex items-center bg-white/5 rounded-xl border border-white/10 overflow-hidden text-xs">
                <button
                  onClick={handleSelectOutputDir}
                  className="px-2 sm:px-2.5 py-1.5 hover:bg-white/10 text-zinc-300 hover:text-white font-semibold flex items-center gap-1 transition-all focus-visible:ring-2 focus-visible:ring-blue-500 active:scale-95"
                  title="点击选择/更换剪辑产物的输出目标目录"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                  <span>输出目录</span>
                </button>
                <button
                  onClick={handleOpenOutputFolder}
                  className="p-1.5 hover:bg-white/10 text-zinc-400 hover:text-white transition-all border-l border-white/10 active:scale-95"
                  title="在系统资源管理器中打开当前输出目录"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </div>

              <button
                onClick={handleSavePlan}
                className="px-2.5 sm:px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-all border border-white/10 active:scale-95 shadow-md focus-visible:ring-2 focus-visible:ring-blue-500"
                title="将当前切点与决策保存为待批处理方案"
              >
                <Save className="w-3.5 h-3.5 text-zinc-300" />
                <span>存为方案</span>
              </button>

              <button
                disabled={executing || keptDurationMs === 0}
                onClick={handleExecuteCut}
                className="px-3 sm:px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold flex items-center gap-1.5 transition-all shadow-lg shadow-emerald-500/20 active:scale-95 border border-emerald-400/30 focus-visible:ring-2 focus-visible:ring-emerald-400 shrink-0 whitespace-nowrap"
              >
                {executing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>无损流拷贝剪辑中...</span>
                  </>
                ) : (
                  <>
                    <Rocket className="w-4 h-4" />
                    <span>🚀 立即执行剪辑</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 6. 就近浮动通知 Toast (在底部 Dock 栏正上方浮动展示，聚焦视线，不挤占页面布局) */}
      {notice && (
        <div
          className={`absolute bottom-20 left-1/2 -translate-x-1/2 z-50 max-w-[700px] w-auto px-4 py-2.5 rounded-2xl border text-xs flex items-center gap-3 shadow-2xl backdrop-blur-md transition-all animate-in fade-in slide-in-from-bottom-3 ${
            notice.type === 'success'
              ? 'bg-[#12261e]/95 border-emerald-500/40 text-emerald-200 shadow-emerald-950/50'
              : notice.type === 'warning'
              ? 'bg-[#291f0c]/95 border-amber-500/40 text-amber-200 shadow-amber-950/50'
              : 'bg-[#281316]/95 border-rose-500/40 text-rose-200 shadow-rose-950/50'
          }`}
        >
          <div className="flex items-center gap-2 font-medium">
            {notice.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span className="truncate max-w-[450px]">{notice.message}</span>
          </div>

          <div className="flex items-center gap-2 shrink-0 ml-auto">
            {notice.type === 'success' && lastExportedPath && (
              <button
                onClick={handleRevealInExplorer}
                className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1.5 transition-all shadow-sm active:scale-95 text-[11px]"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>定位产物</span>
              </button>
            )}
            <button
              onClick={() => setNotice(null)}
              className="text-zinc-400 hover:text-white text-xs px-1 hover:bg-white/10 rounded transition-colors"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
