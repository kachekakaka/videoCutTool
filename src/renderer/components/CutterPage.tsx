import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { MediaMetadata, RetentionDecision, PlanRecord, CompressConfig } from '../../shared/types';
import { COMPRESS_PRESETS } from '../../shared/compressPresets';
import { VideoCompareView, PreviewSample } from './VideoCompareView';
import { VideoPlayer, VideoPlayerRef, formatTimecode } from './VideoPlayer';
import { Timeline } from './Timeline';
import { SegmentCardsGrid } from './SegmentCardsGrid';
import { RetentionDraft, DraftSnapshot } from '../../shared/RetentionDraft';
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
  FolderEdit,
  UploadCloud,
  Zap,
  Settings,
  Sparkles,
  Sliders,
  Eye,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

interface CutterPageProps {
  onOpenVideo: () => void;
  initialVideoPath?: string | null;
  loadedPlanRecord?: PlanRecord | null;
  onPlanSaved?: () => void;
  isActive?: boolean;
}

export const CutterPage: React.FC<CutterPageProps> = ({
  onOpenVideo,
  initialVideoPath,
  loadedPlanRecord,
  onPlanSaved,
  isActive = true,
}) => {
  const [metadata, setMetadata] = useState<MediaMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isKeyframeScanning, setIsKeyframeScanning] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // 跨 Tab 重新切回工作台时，微延时触发 resize 事件，确保时间轴 Canvas 自适应重新测算并重绘
  useEffect(() => {
    if (isActive) {
      const timer = setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isActive]);

  // 核心领域深模块草稿
  const [draft, setDraft] = useState<RetentionDraft | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);

  // 历史快照栈支持撤销/重做 (Undo / Redo)
  const [history, setHistory] = useState<DraftSnapshot[]>([]);
  const [future, setFuture] = useState<DraftSnapshot[]>([]);

  // 试听区间
  const [auditionRange, setAuditionRange] = useState<{ startMs: number; endMs: number } | null>(null);

  // 微调步长选择 (ms，默认为 100ms 即 0.1s)
  const [nudgeStepMs, setNudgeStepMs] = useState(100);

  // 播放状态与画面比例
  const [isPlaying, setIsPlaying] = useState(false);
  const [aspectRatioMode, setAspectRatioMode] = useState<'auto' | '16:9' | '1:1'>('auto');

  // 安全产物预定路径 (防重名递增预显)
  const [safeOutputPath, setSafeOutputPath] = useState<string>('');

  // 执行与提示状态
  const [executing, setExecuting] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);

  // 当前绑定方案状态与保存模态框
  const [currentPlanId, setCurrentPlanId] = useState<string | null>(loadedPlanRecord ? loadedPlanRecord.id : null);
  const [currentPlanTitle, setCurrentPlanTitle] = useState<string>(loadedPlanRecord ? loadedPlanRecord.title : '');
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [planTitleInput, setPlanTitleInput] = useState('');
  const [saveMode, setSaveMode] = useState<'update' | 'new'>('update');
  const [showNoCutWarningModal, setShowNoCutWarningModal] = useState(false);

  // 降码设置面板与就地画质对比视窗状态
  const [showCompressSettings, setShowCompressSettings] = useState(false);
  const [mainViewportMode, setMainViewportMode] = useState<'player' | 'compare'>('player');
  const [showAdvancedCompress, setShowAdvancedCompress] = useState(false);

  // 画质对比抽样画格、选中的场景页码及视图模式常驻工作台（跨 Tab / 跨视窗绝不丢失）
  const [cachedCompareSamples, setCachedCompareSamples] = useState<PreviewSample[]>([]);
  const [currentCompareSampleIndex, setCurrentCompareSampleIndex] = useState<number>(0);
  const [compareViewMode, setCompareViewMode] = useState<'split' | 'side-by-side'>('split');

  // 从领域模型派生数据（受 draftVersion 驱动响应式刷新）
  const cuts = useMemo(() => (draft ? draft.getCuts() : []), [draft, draftVersion]);
  const segments = useMemo(() => (draft ? draft.getSegments() : []), [draft, draftVersion]);
  const keptDurationMs = useMemo(() => (draft ? draft.getKeptDurationMs() : 0), [draft, draftVersion]);
  const discardedDurationMs = useMemo(() => (draft ? draft.getDiscardedDurationMs() : 0), [draft, draftVersion]);
  const concatSingleFile = draft ? draft.concatSingleFile : true;
  const stripOriginalCover = draft ? draft.stripOriginalCover : true;

  // 降码模式状态与当前配置派生
  const isCompressMode = Boolean(draft?.compress?.enabled);
  const currentCompressConfig = useMemo<CompressConfig>(() => {
    return draft?.compress || {
      enabled: false,
      preset: 'balanced',
      crf: 22,
      hardwareAcceleration: true,
    };
  }, [draft, draftVersion]);

  // 计算用于画质对比抽样的代表性时间戳 (自适应保证至少 3 个场景)
  const sampleTimestamps = useMemo(() => {
    const keptSegs = segments.filter((s) => s.decision === 'keep');
    if (keptSegs.length === 0) {
      const dur = metadata?.durationMs || 10000;
      return [Math.round(dur * 0.2), Math.round(dur * 0.5), Math.round(dur * 0.8)];
    }
    // 只有 1 个保留分段时（比如未打切点全片保留，或单段较长）：在段内均匀抽取 20%、50%、80% 处的 3 帧
    if (keptSegs.length === 1) {
      const seg = keptSegs[0];
      const span = seg.endMs - seg.startMs;
      return [
        Math.round(seg.startMs + span * 0.2),
        Math.round(seg.startMs + span * 0.5),
        Math.round(seg.startMs + span * 0.8),
      ];
    }
    // 有 2 个保留分段时：段 1 抽 1 帧 (50%)，段 2 抽 2 帧 (35%, 70%)，凑足 3 帧
    if (keptSegs.length === 2) {
      const s1 = keptSegs[0];
      const s2 = keptSegs[1];
      const span1 = s1.endMs - s1.startMs;
      const span2 = s2.endMs - s2.startMs;
      return [
        Math.round(s1.startMs + span1 * 0.5),
        Math.round(s2.startMs + span2 * 0.35),
        Math.round(s2.startMs + span2 * 0.7),
      ];
    }
    // 3 个或以上保留段时：每个段落取中央中点，最多取 5 帧
    return keptSegs.map((s) => Math.round((s.startMs + s.endMs) / 2)).slice(0, 5);
  }, [segments, metadata?.durationMs]);

  // 切点或保留分段变动导致抽样时间戳改变时，清空抽样帧缓存，触发按新时间戳重新抽取
  const prevTimestampsKeyRef = useRef<string>('');
  useEffect(() => {
    const key = sampleTimestamps.join(',');
    if (prevTimestampsKeyRef.current && prevTimestampsKeyRef.current !== key) {
      setCachedCompareSamples([]);
    }
    prevTimestampsKeyRef.current = key;
  }, [sampleTimestamps]);

  // 实时推导预定安全产物路径
  useEffect(() => {
    if (!metadata?.filePath) {
      setSafeOutputPath('');
      return;
    }
    let isCancelled = false;
    if (window.electronAPI?.resolveOutputPath) {
      window.electronAPI
        .resolveOutputPath(metadata.filePath, concatSingleFile, currentPlanTitle)
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
  }, [metadata?.filePath, concatSingleFile, currentPlanTitle]);



  const playerRef = useRef<VideoPlayerRef | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 提交草稿操作变更至撤销栈
  const commitDraftChange = useCallback(
    (mutator: (d: RetentionDraft) => boolean | void) => {
      if (!draft) return;
      const snap = draft.snapshot();
      const res = mutator(draft);
      if (res !== false) {
        setHistory((prev) => [...prev, snap]);
        setFuture([]);
        setDraftVersion((v) => v + 1);
      }
    },
    [draft]
  );

  // 撤销操作 (Undo, Ctrl+Z)
  const handleUndo = useCallback(() => {
    if (!draft || history.length === 0) return;
    const previous = history[history.length - 1];
    const currentSnap = draft.snapshot();
    setHistory((prev) => prev.slice(0, prev.length - 1));
    setFuture((prev) => [currentSnap, ...prev]);
    draft.restore(previous);
    setDraftVersion((v) => v + 1);
  }, [draft, history]);

  // 重做操作 (Redo, Ctrl+Y / Ctrl+Shift+Z)
  const handleRedo = useCallback(() => {
    if (!draft || future.length === 0) return;
    const next = future[0];
    const currentSnap = draft.snapshot();
    setFuture((prev) => prev.slice(1));
    setHistory((prev) => [...prev, currentSnap]);
    draft.restore(next);
    setDraftVersion((v) => v + 1);
  }, [draft, future]);

  // 全局快捷键监听撤销、重做与弹窗 Esc 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

      if (e.key === 'Escape') {
        if (showNoCutWarningModal) {
          e.preventDefault();
          setShowNoCutWarningModal(false);
          return;
        }
        if (showSaveModal) {
          e.preventDefault();
          setShowSaveModal(false);
          return;
        }
        if (mainViewportMode === 'compare') {
          e.preventDefault();
          setMainViewportMode('player');
          return;
        }
      }

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
  }, [handleUndo, handleRedo, showNoCutWarningModal, showSaveModal, mainViewportMode]);

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

  // 载入视频并探测关键帧 (两阶段秒开机制：300ms 快速出图，后台静默扫描关键帧并落盘缓存)
  const loadAndProbeVideo = async (filePath: string, recordToLoad?: PlanRecord | null) => {
    setIsLoading(true);
    setIsKeyframeScanning(false);
    setNotice(null);
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
        setCachedCompareSamples([]); // 彻底清空旧视频的画质对比抽样缓存
        setCurrentCompareSampleIndex(0);
        setMainViewportMode('player');

        let newDraft: RetentionDraft;
        if (recordToLoad && recordToLoad.sourcePath === filePath) {
          newDraft = RetentionDraft.fromRecord(recordToLoad, basicMeta.durationMs);
          setCurrentPlanId(recordToLoad.id);
          setCurrentPlanTitle(recordToLoad.title);
        } else {
          newDraft = new RetentionDraft(filePath, basicMeta.durationMs);
          setCurrentPlanId(null);
          setCurrentPlanTitle('');
        }
        setDraft(newDraft);
        setDraftVersion((v) => v + 1);

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

  // 跨 Tab 或方案中心加载新方案时同步方案状态
  useEffect(() => {
    if (loadedPlanRecord) {
      setCurrentPlanId(loadedPlanRecord.id);
      setCurrentPlanTitle(loadedPlanRecord.title);
    }
  }, [loadedPlanRecord]);

  useEffect(() => {
    if (initialVideoPath) {
      loadAndProbeVideo(initialVideoPath, loadedPlanRecord);
    }
  }, [initialVideoPath, loadedPlanRecord]);

  // 插入切点
  const handleInsertCut = () => {
    if (!draft || !metadata) return;
    const timeMs = playerRef.current ? playerRef.current.getCurrentTimeMs() : currentTimeMs;
    let success = false;
    commitDraftChange((d) => {
      success = d.addCut(timeMs);
      return success;
    });

    if (!success) {
      setNotice({ type: 'warning', message: '切点距离视频首尾或已有标记过近 (需间隔 200ms 以上)' });
    } else {
      setNotice(null);
    }
  };

  // 删除特定切点
  const handleDeleteCut = (cutTimeMs: number) => {
    if (!draft) return;
    let success = false;
    commitDraftChange((d) => {
      success = d.removeCut(cutTimeMs);
      return success;
    });
    if (success) {
      setNotice({ type: 'warning', message: `已移除位于 ${formatTimecode(cutTimeMs, false)} 的切点标记` });
    }
  };

  // 移动切点至新时间戳（长按拖拽 / 就地时间码输入）
  const handleMoveCut = useCallback(
    (cutIndex: number, newTimeMs: number): boolean => {
      if (!draft) return false;
      let ok = false;
      commitDraftChange((d) => {
        ok = d.moveCut(cutIndex, newTimeMs);
        return ok;
      });
      return ok;
    },
    [draft, commitDraftChange]
  );

  // 合并某分段至上一段（直接调用 RetentionDraft 领域方法，零字符串推导）
  const handleMergeSegment = (segmentId: string) => {
    if (!draft) return;
    commitDraftChange((d) => {
      return d.mergeSegmentWithPrevious(segmentId);
    });
    setNotice({
      type: 'warning',
      message: '已安全合并相邻分段（执行保留优先保全铁律）',
    });
  };

  // 切换分段决策
  const handleToggleDecision = (segmentId: string, decision: RetentionDecision) => {
    commitDraftChange((d) => {
      d.setDecision(segmentId, decision);
    });
  };

  // 试听
  const handleAudition = (startMs: number, endMs: number) => {
    setAuditionRange({ startMs, endMs });
  };

  // 微调起点（领域方法）
  const handleNudgeStart = (segmentId: string, deltaMs: number) => {
    if (!draft) return;
    commitDraftChange((d) => {
      return d.nudgeSegmentStart(segmentId, deltaMs);
    });
  };

  // 微调终点（领域方法）
  const handleNudgeEnd = (segmentId: string, deltaMs: number) => {
    if (!draft) return;
    commitDraftChange((d) => {
      return d.nudgeSegmentEnd(segmentId, deltaMs);
    });
  };

  // 切换多段合并偏好
  const handleToggleConcat = (val: boolean) => {
    commitDraftChange((d) => {
      d.concatSingleFile = val;
    });
  };

  // 切换导出模式 (无损秒切 vs 智能降码)
  const handleToggleExportMode = (mode: 'lossless' | 'compress') => {
    commitDraftChange((d) => {
      if (mode === 'lossless') {
        d.compress = undefined;
        setShowCompressSettings(false);
        setMainViewportMode('player');
      } else {
        d.compress = d.compress || {
          enabled: true,
          preset: 'balanced',
          crf: 22,
          hardwareAcceleration: true,
        };
        d.compress.enabled = true;
      }
    });
  };

  // 更新降码配置项
  const handleUpdateCompressConfig = (updater: (cfg: CompressConfig) => void) => {
    setCachedCompareSamples([]); // 配置变更时清空抽样帧缓存，按新配置增量重新抽取
    commitDraftChange((d) => {
      if (!d.compress) {
        d.compress = {
          enabled: true,
          preset: 'balanced',
          crf: 22,
          hardwareAcceleration: true,
        };
      }
      updater(d.compress);
    });
  };

  // 切换首帧封面剥离偏好
  const handleToggleCover = (val: boolean) => {
    commitDraftChange((d) => {
      d.stripOriginalCover = val;
    });
  };

  // 统一构建持久化方案记录
  const buildCurrentRecord = async (): Promise<PlanRecord | null> => {
    if (!draft || !metadata || !window.electronAPI) return null;
    const title = currentPlanTitle || metadata.fileName.replace(/\.[^/.]+$/, '');
    const outPath = await window.electronAPI.resolveOutputPath(metadata.filePath, draft.concatSingleFile, title);
    const planId = currentPlanId || `plan_${Date.now()}`;
    return draft.toRecord({
      id: planId,
      title: title,
      outputPath: outPath,
    });
  };

  // 打开存为方案输入弹窗
  const handleOpenSaveModal = () => {
    if (!metadata || !draft) return;
    const defaultTitle = currentPlanTitle || metadata.fileName.replace(/\.[^/.]+$/, '');
    setPlanTitleInput(defaultTitle);
    setSaveMode(currentPlanId ? 'update' : 'new');
    setShowSaveModal(true);
  };

  // 确认保存方案（支持用户自定义方案名，支持更新原方案与另存为新方案）
  const handleConfirmSavePlan = async () => {
    const trimmedTitle = planTitleInput.trim();
    if (!trimmedTitle || !draft || !metadata || !window.electronAPI) return;

    try {
      const outPath = await window.electronAPI.resolveOutputPath(metadata.filePath, draft.concatSingleFile, trimmedTitle);
      const isUpdating = saveMode === 'update' && Boolean(currentPlanId);
      const targetId = isUpdating && currentPlanId ? currentPlanId : `plan_${Date.now()}`;

      const record = draft.toRecord({
        id: targetId,
        title: trimmedTitle,
        outputPath: outPath,
      });

      await window.electronAPI.savePlan(record);
      setCurrentPlanId(targetId);
      setCurrentPlanTitle(trimmedTitle);
      setShowSaveModal(false);

      setNotice({
        type: 'success',
        message: isUpdating
          ? `方案「${trimmedTitle}」已成功更新保存！`
          : `已成功另存为新方案「${trimmedTitle}」！`,
      });
      if (onPlanSaved) onPlanSaved();
    } catch (err: any) {
      setNotice({ type: 'error', message: err.message || '保存方案失败' });
    }
  };

  // 立即执行剪辑（秒级移交后台异步引擎，不阻塞工作台）
  const handleExecuteCut = async (forceBypassNoCutCheck = false) => {
    // 无损秒切防呆拦截：若未开启降码、且未设切点（只有 1 个保留分段），不处理并弹窗提醒
    if (!forceBypassNoCutCheck && !isCompressMode && cuts.length === 0 && segments.length === 1 && segments[0].decision === 'keep') {
      setShowNoCutWarningModal(true);
      return;
    }

    setExecuting(true);
    setNotice(null);

    try {
      const record = await buildCurrentRecord();
      if (!record || !window.electronAPI) return;
      const res = await window.electronAPI.submitDraft(record);
      if (onPlanSaved) onPlanSaved();

      setNotice({
        type: 'success',
        message: res.queued
          ? '方案已排入后台剪辑队列等待执行（可在方案中心查看实时进度）'
          : '方案已移交后台异步引擎正在处理，导出完成将自动弹出通知（可在方案中心查看）',
      });
    } catch (err: any) {
      setNotice({ type: 'error', message: err.message || '提交剪辑任务失败' });
    } finally {
      setExecuting(false);
    }
  };

  // 打开输出目录
  const handleOpenOutputFolder = async () => {
    if (!window.electronAPI) return;
    if (safeOutputPath) {
      window.electronAPI.showItemInFolder(safeOutputPath);
      return;
    }
    if (metadata?.filePath) {
      try {
        const outPath = await window.electronAPI.resolveOutputPath(metadata.filePath, concatSingleFile, currentPlanTitle);
        window.electronAPI.showItemInFolder(outPath);
      } catch {
        window.electronAPI.showItemInFolder(metadata.filePath);
      }
    }
  };

  // 选择自定义输出目录
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
          const newPath = await window.electronAPI.resolveOutputPath(metadata.filePath, concatSingleFile, currentPlanTitle);
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
        {/* 1. 纯净视频画面视窗 / 降码画质 A/B 对比就地视窗 */}
        {mainViewportMode === 'player' ? (
          <div className="relative flex-1 min-h-0 flex flex-col">
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
            {/* 降码模式下右上角提供就地画质对比切换药丸 */}
            {isCompressMode && (
              <div className="absolute top-3 right-3 z-20 flex items-center">
                <button
                  onClick={() => setMainViewportMode('compare')}
                  className="px-3 py-1.5 rounded-xl bg-black/75 hover:bg-black/90 text-purple-300 hover:text-white border border-purple-500/40 text-xs font-semibold flex items-center gap-1.5 backdrop-blur-md shadow-xl transition-all hover:scale-105 active:scale-95"
                  title="就地进入降码画质 A/B 对比视窗（支持卷帘与并排放大检视）"
                >
                  <Sparkles className="w-3.5 h-3.5 text-purple-400" />
                  <span>画质对比 (A/B)</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="relative flex-1 min-h-0 bg-black rounded-2xl overflow-hidden border border-white/10 shadow-2xl flex flex-col">
            <VideoCompareView
              videoPath={metadata.filePath}
              config={currentCompressConfig}
              sampleTimestampsMs={sampleTimestamps}
              cachedSamples={cachedCompareSamples}
              currentSampleIndex={currentCompareSampleIndex}
              onSampleIndexChange={setCurrentCompareSampleIndex}
              onSamplesLoaded={setCachedCompareSamples}
              onSwitchToPlayer={() => setMainViewportMode('player')}
              viewMode={compareViewMode}
              onViewModeChange={setCompareViewMode}
              aspectRatioMode={aspectRatioMode}
            />
          </div>
        )}

        {/* 2. 主时间轴控制台 */}
        <div className="shrink-0">
          <Timeline
            durationMs={metadata.durationMs}
            currentTimeMs={currentTimeMs}
            keyframes={metadata.keyframes}
            cuts={cuts as number[]}
            segments={segments}
            videoPath={metadata.filePath}
            isPlaying={isPlaying}
            aspectRatioMode={aspectRatioMode}
            onSeek={(ms) => {
              setAuditionRange(null);
              playerRef.current?.seekTo(ms);
            }}
            onDeleteCut={handleDeleteCut}
            onMoveCut={handleMoveCut}
            onTogglePlay={() => {
              setAuditionRange(null);
              playerRef.current?.togglePlay();
            }}
            onStepFrame={(delta) => {
              setAuditionRange(null);
              playerRef.current?.stepFrame(delta);
            }}
            onStepSeconds={(sec) => {
              setAuditionRange(null);
              playerRef.current?.stepSeconds(sec);
            }}
            onToggleAspectRatio={(mode) => setAspectRatioMode(mode)}
            onInsertCut={handleInsertCut}
          />
        </div>

        {/* 3. 分段卡片流工具条与撤销重做控制 */}
        <div className="flex items-center justify-between gap-3 h-8 shrink-0 min-w-0 select-none">
          {/* 左侧核心操作区：恒定单行防折行 */}
          <div className="flex items-center gap-2 sm:gap-2.5 shrink-0 whitespace-nowrap">
            <div className="flex items-center gap-1.5 text-xs font-bold text-white whitespace-nowrap shrink-0">
              <Scissors className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span>分段列表 ({segments.length})</span>
            </div>

            {/* 关键帧后台扫描与索引状态指示 */}
            {isKeyframeScanning ? (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[10px] font-normal animate-pulse whitespace-nowrap shrink-0">
                <Loader2 className="w-2.5 h-2.5 animate-spin text-amber-400 shrink-0" />
                <span>扫描关键帧...</span>
              </span>
            ) : metadata && metadata.keyframes && metadata.keyframes.length > 1 ? (
              <span
                className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300 text-[10px] font-mono font-normal whitespace-nowrap shrink-0"
                title={`共探测到 ${metadata.keyframes.length} 个物理关键帧`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                <span>{metadata.keyframes.length} 关键帧</span>
              </span>
            ) : null}

            {/* 撤销 / 重做按钮组 */}
            <div className="flex items-center bg-black/40 border border-white/10 rounded-lg p-0.5 text-xs font-normal whitespace-nowrap shrink-0">
              <button
                disabled={history.length === 0}
                onClick={handleUndo}
                className="px-2 py-0.5 rounded text-zinc-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1 hover:bg-white/10 transition-all active:scale-95 whitespace-nowrap"
                title="撤销上一步操作 (Ctrl+Z)"
              >
                <Undo2 className="w-3.5 h-3.5 shrink-0" />
                <span className="whitespace-nowrap">撤销</span>
              </button>
              <button
                disabled={future.length === 0}
                onClick={handleRedo}
                className="px-2 py-0.5 rounded text-zinc-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1 hover:bg-white/10 transition-all active:scale-95 border-l border-white/10 whitespace-nowrap"
                title="重做下一步操作 (Ctrl+Y)"
              >
                <Redo2 className="w-3.5 h-3.5 shrink-0" />
                <span className="whitespace-nowrap">重做</span>
              </button>
            </div>

            {/* 微调步长多档选择器 */}
            <div className="flex items-center bg-black/40 border border-white/10 rounded-lg p-0.5 text-xs font-normal whitespace-nowrap shrink-0">
              <span className="text-[10px] text-zinc-400 px-1.5 select-none whitespace-nowrap">步长:</span>
              {[100, 1000, 5000, 10000].map((step) => {
                const label = step < 1000 ? `${step / 1000}s` : `${step / 1000}s`;
                const isSelected = nudgeStepMs === step;
                return (
                  <button
                    key={step}
                    onClick={() => setNudgeStepMs(step)}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono whitespace-nowrap transition-all active:scale-95 ${
                      isSelected
                        ? 'bg-blue-600 text-white font-bold shadow-sm'
                        : 'text-zinc-400 hover:text-white hover:bg-white/5'
                    }`}
                    title={`微调步长设置为 ${label}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 右侧：快捷键指示栏，响应式平滑收缩，严禁折行 */}
          <div
            className="hidden md:flex items-center gap-1.5 min-w-0 justify-end overflow-hidden whitespace-nowrap text-[11px] text-zinc-400 shrink"
            title="常用快捷键：空格 播放/暂停 · C 插入切点 · 长按切点拖拽微调 · 双击切点就地修改时间 · ←/→ 逐帧微调 · Del 移除切点 · Ctrl+Z 撤销 · 点击卡片切换保留"
          >
            <span className="flex items-center gap-1 shrink-0">
              <kbd className="bg-white/10 text-zinc-200 px-1 py-0.5 rounded text-[10px] font-mono">空格</kbd> 播放
            </span>
            <span className="text-zinc-600 shrink-0">·</span>
            <span className="flex items-center gap-1 shrink-0">
              <kbd className="bg-white/10 text-zinc-200 px-1 py-0.5 rounded text-[10px] font-mono">C</kbd> 切点
            </span>
            <span className="hidden lg:inline text-zinc-600 shrink-0">·</span>
            <span className="hidden lg:flex items-center gap-1 shrink-0">
              <kbd className="bg-white/10 text-zinc-200 px-1 py-0.5 rounded text-[10px] font-mono">←</kbd>
              <kbd className="bg-white/10 text-zinc-200 px-1 py-0.5 rounded text-[10px] font-mono">→</kbd> 逐帧
            </span>
            <span className="hidden xl:inline text-zinc-600 shrink-0">·</span>
            <span className="hidden xl:flex items-center gap-1 shrink-0">
              <kbd className="bg-white/10 text-zinc-200 px-1 py-0.5 rounded text-[10px] font-mono">Del</kbd> 删切点
            </span>
            <span className="hidden 2xl:inline text-zinc-600 shrink-0">·</span>
            <span className="hidden 2xl:flex items-center gap-1 shrink-0">
              <kbd className="bg-white/10 text-zinc-200 px-1 py-0.5 rounded text-[10px] font-mono">Ctrl+Z</kbd> 撤销
            </span>
            <span className="hidden 2xl:inline text-zinc-600 shrink-0">·</span>
            <span className="text-zinc-400 hidden 2xl:inline shrink-0">点击卡片切换保留</span>
          </div>
        </div>

        {/* 4. 精炼双行分段卡片流 */}
        <div className="max-h-[160px] shrink-0 overflow-y-auto overflow-x-hidden pr-0.5">
          <SegmentCardsGrid
            segments={segments}
            currentTimeMs={currentTimeMs}
            auditionRange={auditionRange}
            stepMs={nudgeStepMs}
            onStepMsChange={setNudgeStepMs}
            onToggleDecision={handleToggleDecision}
            onAudition={handleAudition}
            onNudgeStart={handleNudgeStart}
            onNudgeEnd={handleNudgeEnd}
            onMergeWithPrevious={handleMergeSegment}
            onSeek={(ms) => {
              setAuditionRange(null);
              playerRef.current?.seekTo(ms);
            }}
          />
        </div>

        {/* 5. 底部固定状态 Dock 栏 */}
        <div className="mt-auto shrink-0 pt-1 pb-1">
          <div className="px-3 py-2 rounded-2xl bg-[#161b22]/95 border border-white/10 shadow-2xl backdrop-blur-md flex flex-wrap lg:flex-nowrap items-center justify-between gap-2 min-w-0">
            {/* 左侧：统计指标与预定产物名 */}
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

              {/* 实时预定产物文件名预览与目录控制胶囊 */}
              {safeOutputPath && (
                <div
                  className="flex items-center bg-black/40 px-2.5 py-1 rounded-xl border border-white/10 shrink min-w-0 gap-1.5 group hover:border-white/25 transition-all"
                >
                  <button
                    onClick={handleOpenOutputFolder}
                    className="flex items-center gap-1.5 text-xs font-mono text-zinc-300 hover:text-white transition-colors truncate focus-visible:outline-none"
                    title={`点击在系统资源管理器中打开目标目录\n预定保存完整路径: ${safeOutputPath}`}
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span className="text-zinc-400 shrink-0">预定:</span>
                    <span className="text-sky-300 font-bold max-w-[90px] sm:max-w-[140px] 2xl:max-w-[220px] truncate">
                      {safeOutputPath.split(/[\\/]/).pop()}
                    </span>
                  </button>
                  <button
                    onClick={handleSelectOutputDir}
                    className="p-1 hover:bg-white/10 rounded text-zinc-400 hover:text-amber-400 transition-all shrink-0 border-l border-white/10 pl-1.5 ml-0.5"
                    title="点击更换剪辑产物的保存目录"
                  >
                    <FolderEdit className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* 中间：剪辑偏好选项组 */}
            <div className="flex items-center gap-2 sm:gap-2.5 text-xs text-zinc-300 select-none shrink-0 mx-0.5">
              <label className="flex items-center gap-1 cursor-pointer hover:text-white transition-colors" title="多个保留片段是否拼接合并为一个视频文件">
                <input
                  type="checkbox"
                  checked={concatSingleFile}
                  onChange={(e) => handleToggleConcat(e.target.checked)}
                  className="w-3.5 h-3.5 accent-blue-500 rounded cursor-pointer"
                />
                <span>多段合并</span>
              </label>

              <label className="flex items-center gap-1 cursor-pointer hover:text-white transition-colors" title="勾选后剥离原片固定封面，让切片视频自动展示各段首帧画面，防止所有切片封面雷同">
                <input
                  type="checkbox"
                  checked={stripOriginalCover}
                  onChange={(e) => handleToggleCover(e.target.checked)}
                  className="w-3.5 h-3.5 accent-blue-500 rounded cursor-pointer"
                />
                <span>首帧封面</span>
              </label>
            </div>

            {/* 右侧动作按钮组 */}
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 ml-auto lg:ml-0 relative">
              {/* 模式选择胶囊：无损秒切 vs 智能降码 */}
              <div className="flex items-center bg-black/40 border border-white/10 p-0.5 rounded-xl text-xs font-medium">
                <button
                  onClick={() => handleToggleExportMode('lossless')}
                  className={`px-2.5 py-1 rounded-lg flex items-center gap-1 transition-all ${
                    !isCompressMode
                      ? 'bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/30 shadow-sm'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                  title="无损流复制秒级导出，100% 保持原始画质与原声"
                >
                  <Zap className="w-3.5 h-3.5 text-cyan-400" />
                  <span>无损秒切</span>
                </button>
                <button
                  onClick={() => handleToggleExportMode('compress')}
                  className={`px-2.5 py-1 rounded-lg flex items-center gap-1 transition-all ${
                    isCompressMode
                      ? 'bg-purple-500/20 text-purple-300 font-bold border border-purple-500/30 shadow-sm'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                  title="智能降码压制，大幅缩减文件体积并强制保留无损音频"
                >
                  <span>📦</span>
                  <span>智能降码</span>
                </button>
              </div>

              {/* 若开启了智能降码，显示设置按钮 */}
              {isCompressMode && (
                <button
                  onClick={() => setShowCompressSettings(!showCompressSettings)}
                  className={`p-1.5 rounded-xl border text-xs flex items-center gap-1 transition-all active:scale-95 ${
                    showCompressSettings
                      ? 'bg-purple-600 text-white border-purple-400 shadow-md shadow-purple-600/30'
                      : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border-white/10'
                  }`}
                  title="点击展开智能降码参数微调与画质对比预览"
                >
                  <Settings className="w-3.5 h-3.5" />
                </button>
              )}

              {/* 智能降码渐进式参数面板 Popover */}
              {isCompressMode && showCompressSettings && (
                <div
                  className="absolute bottom-12 right-0 z-40 w-[380px] bg-[#161a24] border border-white/15 rounded-2xl shadow-2xl p-4 flex flex-col gap-3.5 backdrop-blur-xl animate-in fade-in zoom-in-95 select-none"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between pb-2 border-b border-white/10">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-purple-400" />
                      <span className="text-xs font-bold text-white">智能降码预设与画质微调</span>
                    </div>
                    <button
                      onClick={() => setShowCompressSettings(false)}
                      className="text-zinc-400 hover:text-white text-xs px-1 hover:bg-white/10 rounded transition-colors"
                    >
                      ✕
                    </button>
                  </div>

                  {/* 四档经典预设选择卡片 */}
                  <div className="grid grid-cols-2 gap-2">
                    {(['high_quality', 'balanced', 'high_compression', 'scale_1080p'] as const).map((pid) => {
                      const meta = COMPRESS_PRESETS[pid];
                      const isSelected = currentCompressConfig.preset === pid;
                      return (
                        <button
                          key={pid}
                          onClick={() => {
                            handleUpdateCompressConfig((cfg) => {
                              cfg.preset = pid;
                              cfg.crf = meta.defaultCrf;
                              if (pid === 'scale_1080p') {
                                cfg.maxHeight = 1080;
                              } else {
                                delete cfg.maxHeight;
                              }
                            });
                          }}
                          className={`p-2.5 rounded-xl border text-left transition-all flex flex-col justify-between ${
                            isSelected
                              ? 'bg-purple-600/20 border-purple-500/50 shadow-md shadow-purple-500/10 ring-1 ring-purple-500'
                              : 'bg-black/30 border-white/10 hover:border-white/20 hover:bg-white/5'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className={`text-xs font-bold ${isSelected ? 'text-purple-300' : 'text-zinc-200'}`}>
                              {meta.title}
                            </span>
                            {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-purple-400" />}
                          </div>
                          <span className="text-[10px] text-zinc-400 mt-1 line-clamp-1">{meta.summary}</span>
                          <div className="mt-1.5 flex items-center justify-between text-[10px] font-mono">
                            <span className="text-emerald-400">-{meta.sizeReduceMin}~{meta.sizeReduceMax}% 体积</span>
                            <span className="text-purple-300">保真 {meta.qualityRetainMin}%+</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* 高级参数折叠切换 */}
                  <div className="pt-1 border-t border-white/5 flex flex-col gap-2">
                    <button
                      onClick={() => setShowAdvancedCompress(!showAdvancedCompress)}
                      className="flex items-center justify-between text-[11px] text-zinc-400 hover:text-white transition-colors py-1"
                    >
                      <span className="flex items-center gap-1">
                        <Sliders className="w-3.5 h-3.5" />
                        <span>高级参数微调 (CRF / 分辨率 / 硬件加速)</span>
                      </span>
                      {showAdvancedCompress ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>

                    {showAdvancedCompress && (
                      <div className="p-2.5 rounded-xl bg-black/40 border border-white/10 space-y-3 animate-in fade-in">
                        {/* CRF 调节滑块 */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-zinc-400">量化参数 CRF:</span>
                            <span className="font-mono text-purple-300 font-bold">
                              {currentCompressConfig.crf ?? 22} (越小画质越好)
                            </span>
                          </div>
                          <input
                            type="range"
                            min="18"
                            max="35"
                            value={currentCompressConfig.crf ?? 22}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10);
                              handleUpdateCompressConfig((cfg) => {
                                cfg.crf = val;
                                cfg.preset = 'custom';
                              });
                            }}
                            className="w-full accent-purple-500 cursor-pointer"
                          />
                          <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                            <span>18 极佳</span>
                            <span>22 均衡推荐</span>
                            <span>28 适中</span>
                            <span>35 极简</span>
                          </div>
                        </div>

                        {/* 分辨率限高选择 */}
                        <div className="space-y-1">
                          <span className="text-[11px] text-zinc-400 block">分辨率限制:</span>
                          <div className="grid grid-cols-3 gap-1.5 text-xs font-mono">
                            {[
                              { label: '原分辨率', val: undefined },
                              { label: '限高 1080p', val: 1080 },
                              { label: '限高 720p', val: 720 },
                            ].map((opt) => {
                              const isCur = currentCompressConfig.maxHeight === opt.val;
                              return (
                                <button
                                  key={opt.label}
                                  onClick={() => {
                                    handleUpdateCompressConfig((cfg) => {
                                      if (opt.val) cfg.maxHeight = opt.val;
                                      else delete cfg.maxHeight;
                                    });
                                  }}
                                  className={`py-1 rounded-lg border text-[10px] transition-all ${
                                    isCur
                                      ? 'bg-purple-600 text-white font-bold border-purple-400'
                                      : 'bg-black/30 border-white/10 text-zinc-400 hover:text-white'
                                  }`}
                                >
                                  {opt.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* 硬件加速开关 */}
                        <label className="flex items-center gap-2 cursor-pointer text-[11px] text-zinc-300 pt-1">
                          <input
                            type="checkbox"
                            checked={currentCompressConfig.hardwareAcceleration !== false}
                            onChange={(e) => {
                              handleUpdateCompressConfig((cfg) => {
                                cfg.hardwareAcceleration = e.target.checked;
                              });
                            }}
                            className="w-3.5 h-3.5 accent-purple-500 cursor-pointer"
                          />
                          <span>优先启用 GPU 硬件加速 (NVENC / QSV)</span>
                        </label>
                      </div>
                    )}
                  </div>

                  {/* 【🔍 预览画质与细节对比】核心入口 */}
                  <button
                    onClick={() => {
                      setShowCompressSettings(false);
                      setMainViewportMode('compare');
                    }}
                    className="w-full py-2 rounded-xl bg-purple-600/30 hover:bg-purple-600/50 text-purple-200 hover:text-white border border-purple-500/40 text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-md active:scale-98"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>{mainViewportMode === 'compare' ? '当前正处于对比视窗' : '就地画质对比 (抽样 3~5 帧)'}</span>
                  </button>
                </div>
              )}

              {/* 存为方案按钮 */}
              <button
                onClick={handleOpenSaveModal}
                className="px-2.5 sm:px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-all border border-white/10 active:scale-95 shadow-md focus-visible:ring-2 focus-visible:ring-blue-500"
                title={currentPlanId ? `保存或另存当前方案 (当前: ${currentPlanTitle})` : '将当前切点与决策保存为待批处理方案'}
              >
                <Save className="w-3.5 h-3.5 text-zinc-300" />
                <span>{currentPlanId ? '保存方案' : '存为方案'}</span>
              </button>

              {/* 主执行按钮：根据模式联动文案与渐变色 */}
              <button
                disabled={executing || keptDurationMs === 0}
                onClick={() => handleExecuteCut()}
                className={`px-2.5 sm:px-3 py-1.5 rounded-xl text-white text-xs font-bold flex items-center gap-1.5 transition-all shadow-lg active:scale-95 shrink-0 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${
                  isCompressMode
                    ? 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 shadow-purple-500/20 border border-purple-400/30 focus-visible:ring-purple-400'
                    : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-emerald-500/20 border border-emerald-400/30 focus-visible:ring-emerald-400'
                }`}
                title={isCompressMode ? "将保留片段合并后单次整体降码压制，完成后弹出通知" : "将当前方案移交后台异步引擎无损剪辑，完成后弹出通知"}
              >
                {executing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>提交中...</span>
                  </>
                ) : isCompressMode ? (
                  <>
                    <Rocket className="w-3.5 h-3.5" />
                    <span>降码导出</span>
                  </>
                ) : (
                  <>
                    <Rocket className="w-3.5 h-3.5" />
                    <span>立即剪辑</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 6. 就近浮动通知 Toast */}
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
            <button
              onClick={() => setNotice(null)}
              className="text-zinc-400 hover:text-white text-xs px-1 hover:bg-white/10 rounded transition-colors"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* 7. 保存方案弹窗 (暗黑质感模态框) */}
      {showSaveModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in"
          onClick={() => setShowSaveModal(false)}
        >
          <div
            className="w-full max-w-md bg-[#161b22] border border-white/10 rounded-2xl p-6 shadow-2xl animate-in zoom-in-95 select-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-blue-400 shrink-0">
                <Save className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-white mb-1">
                  {currentPlanId ? '保存或另存方案' : '存为剪辑方案'}
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed mb-4">
                  请输入方案名称，保存后可在方案管理中心调取查看、修改或批量执行剪辑。
                </p>

                {/* 若当前已有正在编辑的方案，提供更新与另存选择 */}
                {currentPlanId && (
                  <div className="mb-4 p-2.5 rounded-xl bg-black/40 border border-white/10 flex flex-col gap-2">
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-zinc-200">
                      <input
                        type="radio"
                        name="saveMode"
                        checked={saveMode === 'update'}
                        onChange={() => setSaveMode('update')}
                        className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                      />
                      <span className="font-medium">覆盖更新当前方案</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-zinc-200">
                      <input
                        type="radio"
                        name="saveMode"
                        checked={saveMode === 'new'}
                        onChange={() => setSaveMode('new')}
                        className="w-3.5 h-3.5 accent-blue-500 cursor-pointer"
                      />
                      <span className="font-medium">另存为新方案（保留原方案）</span>
                    </label>
                  </div>
                )}

                {/* 方案名称输入框 */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-zinc-400 block">
                    方案名称
                  </label>
                  <input
                    type="text"
                    autoFocus
                    value={planTitleInput}
                    onChange={(e) => setPlanTitleInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleConfirmSavePlan();
                      } else if (e.key === 'Escape') {
                        setShowSaveModal(false);
                      }
                    }}
                    placeholder="输入方案名称..."
                    className="w-full bg-[#0d1117] border border-white/15 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-zinc-500 outline-none transition-all font-sans"
                  />
                </div>

                {/* 方案内容摘要 */}
                <div className="mt-3 text-[11px] text-zinc-400 bg-white/5 px-3 py-2 rounded-xl flex items-center justify-between font-mono">
                  <span>保留分段: {segments.filter((s) => s.decision === 'keep').length} / {segments.length} 段</span>
                  <span>保留时长: {formatTimecode(keptDurationMs, false)}</span>
                </div>
                <div className="mt-1.5 text-[11px] text-zinc-400 bg-white/5 px-3 py-1.5 rounded-xl flex items-center justify-between font-mono">
                  <span>导出模式:</span>
                  <span className={isCompressMode ? 'text-purple-300 font-bold' : 'text-cyan-300 font-bold'}>
                    {isCompressMode
                      ? `📦 智能降码 (${currentCompressConfig.preset === 'custom' ? '自定义' : COMPRESS_PRESETS[currentCompressConfig.preset]?.title || '降码'} CRF ${currentCompressConfig.crf ?? 22})`
                      : '⚡ 无损秒切'}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowSaveModal(false)}
                className="px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white text-xs font-semibold transition-all active:scale-95"
              >
                取消 (Esc)
              </button>
              <button
                type="button"
                disabled={!planTitleInput.trim()}
                onClick={handleConfirmSavePlan}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold transition-all shadow-lg shadow-blue-600/30 active:scale-95 flex items-center gap-1.5"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{saveMode === 'update' && currentPlanId ? '确认更新' : '确认保存'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 8. 无损单段防呆拦截弹窗 */}
      {showNoCutWarningModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in"
          onClick={() => setShowNoCutWarningModal(false)}
        >
          <div
            className="w-full max-w-md bg-[#161b22] border border-amber-500/30 rounded-2xl p-6 shadow-2xl animate-in zoom-in-95 select-none"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
                <AlertCircle className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-white mb-1.5">
                  未检测到任何裁剪点
                </h3>
                <p className="text-xs text-zinc-300 leading-relaxed mb-3">
                  当前视频处于<b>全片保留</b>状态，且未开启降码压缩，直接导出仅相当于原样复制一次文件，没有实际内容被裁剪。
                </p>

                <div className="bg-black/40 border border-white/10 rounded-xl p-3 text-xs space-y-2 text-zinc-400">
                  <div className="flex items-start gap-2 text-zinc-300">
                    <span className="text-blue-400 font-bold">•</span>
                    <span><b>若要裁剪废片</b>：请在播放器或时间轴上按 <kbd className="bg-white/10 text-white px-1 py-0.5 rounded font-mono text-[10px]">C</kbd> 键插入切点，并点击不需要的段落将其标记为丢弃。</span>
                  </div>
                  <div className="flex items-start gap-2 text-zinc-300">
                    <span className="text-purple-400 font-bold">•</span>
                    <span><b>若要压缩全片</b>：可一键切换为「智能降码」模式，将整部视频直接压制瘦身。</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowNoCutWarningModal(false)}
                className="px-3.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white text-xs font-semibold transition-all active:scale-95"
              >
                我知道了 (Esc)
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowNoCutWarningModal(false);
                  handleToggleExportMode('compress');
                }}
                className="px-3.5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition-all shadow-lg shadow-purple-600/30 active:scale-95 flex items-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>切换至智能降码</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowNoCutWarningModal(false);
                  handleExecuteCut(true);
                }}
                className="px-3 py-2 rounded-xl bg-transparent hover:bg-white/5 text-zinc-400 hover:text-zinc-200 text-[11px] font-medium transition-all"
                title="执意将未裁剪的原片直接复制导出到输出目录"
              >
                依然全片导出
              </button>
            </div>
          </div>
        </div>
      )}


    </div>
  );
};
