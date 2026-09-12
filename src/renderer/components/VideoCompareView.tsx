import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Columns,
  ArrowLeftRight,
  Loader2,
  Info,
  RotateCcw,
  Sparkles,
  ArrowLeft,
  Plus,
  X,
} from 'lucide-react';
import { CompressConfig, PreviewSample } from '../../shared/types';
import { COMPRESS_PRESETS } from '../../shared/compressPresets';
import { formatTimecode, parseTimecodeToMs } from './VideoPlayer';
import {
  calculateSplitPercentFromEvent,
  clampPanOffset,
} from '../../shared/viewportCompareMath';

export type { PreviewSample };

export interface VideoCompareViewProps {
  config: CompressConfig;
  cachedSamples: PreviewSample[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  currentSampleIndex: number;
  onSampleIndexChange: (index: number) => void;
  onSwitchToPlayer: () => void;
  viewMode?: 'split' | 'side-by-side';
  onViewModeChange?: (mode: 'split' | 'side-by-side') => void;
  aspectRatioMode?: 'auto' | '16:9' | '1:1' | 'contain';
  onAddSample?: (timestampMs: number) => Promise<boolean>;
  onDeleteSample?: (sampleIndex: number) => void;
  onResetDefaultSamples?: () => void;
  isCustomized?: boolean;
  currentTimeMs?: number;
  durationMs?: number;
  isAddingSample?: boolean;
  shortcutsEnabled?: boolean;
}

export const VideoCompareView: React.FC<VideoCompareViewProps> = ({
  config,
  cachedSamples,
  loading,
  error,
  onRetry,
  currentSampleIndex,
  onSampleIndexChange,
  onSwitchToPlayer,
  viewMode: controlledViewMode,
  onViewModeChange,
  aspectRatioMode = 'contain',
  onAddSample,
  onDeleteSample,
  onResetDefaultSamples,
  isCustomized = false,
  currentTimeMs,
  durationMs,
  isAddingSample = false,
  shortcutsEnabled = true,
}) => {
  const aspectClass =
    aspectRatioMode === '16:9'
      ? 'aspect-video object-contain'
      : aspectRatioMode === '1:1'
      ? 'aspect-square object-contain'
      : 'object-contain';

  // 添加对比场景弹层与输入状态
  const [showAddPopover, setShowAddPopover] = useState(false);
  const [addTimeInput, setAddTimeInput] = useState('');
  const [addInputError, setAddInputError] = useState('');
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const addPopoverRef = useRef<HTMLDivElement | null>(null);
  const scenesBarRef = useRef<HTMLDivElement | null>(null);
  const focusAfterDeleteRef = useRef(false);
  const addPopoverSessionRef = useRef(0);
  const [popoverPosition, setPopoverPosition] = useState({ left: 12, top: 12 });

  const closeAddPopover = () => {
    addPopoverSessionRef.current += 1;
    setShowAddPopover(false);
    addButtonRef.current?.focus({ preventScroll: true });
  };
  const toggleAddPopover = () => {
    if (showAddPopover) { closeAddPopover(); return; }
    addPopoverSessionRef.current += 1;
    setAddTimeInput(formatTimecode(currentTimeMs ?? 0, false));
    setAddInputError('');
    setShowAddPopover(true);
  };

  useLayoutEffect(() => {
    if (!showAddPopover) return;
    // 挂到 body 后按按钮的视口位置定位，避开滚动容器和视频圆角容器的裁剪。
    const positionPopover = () => {
      const anchor = addButtonRef.current?.getBoundingClientRect();
      const popover = addPopoverRef.current?.getBoundingClientRect();
      if (!anchor || !popover) return;
      setPopoverPosition({
        left: Math.max(12, Math.min(anchor.right - popover.width, window.innerWidth - popover.width - 12)),
        top: Math.max(12, Math.min(anchor.top - popover.height - 8, window.innerHeight - popover.height - 12)),
      });
    };
    positionPopover();
    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', positionPopover, true);
    return () => {
      window.removeEventListener('resize', positionPopover);
      window.removeEventListener('scroll', positionPopover, true);
    };
  }, [showAddPopover, addInputError]);

  useEffect(() => {
    if (!showAddPopover) return;
    addInputRef.current?.focus();
    addInputRef.current?.select();
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!addPopoverRef.current?.contains(target) && !addButtonRef.current?.contains(target)) setShowAddPopover(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => {
      addPopoverSessionRef.current += 1;
      document.removeEventListener('pointerdown', closeOutside);
    };
  }, [showAddPopover]);

  useEffect(() => {
    if (!shortcutsEnabled || loading) setShowAddPopover(false);
  }, [shortcutsEnabled, loading]);

  const handleConfirmAdd = async () => {
    if (!onAddSample || isAddingSample || loading || cachedSamples.length >= 5) return;
    const input = addTimeInput.trim();
    const parsed = /^\d+(?::[0-5]?\d){0,2}(?:\.\d{1,3})?$/.test(input) ? parseTimecodeToMs(input) : null;
    if (parsed === null || !Number.isFinite(parsed) || parsed < 0) {
      setAddInputError('格式无效，支持 01:23.450 或秒数');
      return;
    }
    if (durationMs !== undefined && parsed >= durationMs) {
      setAddInputError(`时间点须早于视频结束 (${formatTimecode(durationMs, false)})`);
      return;
    }
    // 防重复检测（与已有场景相差 < 500ms）
    const isDuplicate = cachedSamples.some((s) => Math.abs(s.timestampMs - parsed) < 500);
    if (isDuplicate) {
      setAddInputError('该时间点附近已有对比场景');
      return;
    }
    const session = addPopoverSessionRef.current;
    const added = await onAddSample(parsed);
    if (session !== addPopoverSessionRef.current) return;
    if (added) closeAddPopover();
    else setAddInputError('未能添加场景，请检查提示后重试');
  };

  const deleteSample = (index: number) => {
    if (isAddingSample || loading || cachedSamples.length <= 1) return;
    focusAfterDeleteRef.current = true;
    onDeleteSample?.(index);
  };
  useEffect(() => {
    if (!focusAfterDeleteRef.current) return;
    focusAfterDeleteRef.current = false;
    scenesBarRef.current?.querySelector<HTMLButtonElement>(`[data-scene-index="${currentSampleIndex}"]`)?.focus({ preventScroll: true });
  }, [cachedSamples, currentSampleIndex]);

  // 对比视图模式: 支持外部受控 (工作台常驻) 或内部 fallback
  const [internalViewMode, setInternalViewMode] = useState<'split' | 'side-by-side'>('split');
  const viewMode = controlledViewMode ?? internalViewMode;
  const setViewMode = (mode: 'split' | 'side-by-side') => {
    if (onViewModeChange) onViewModeChange(mode);
    setInternalViewMode(mode);
  };

  // 卷帘分割线百分比 (2 ~ 98)
  const [splitPercent, setSplitPercent] = useState<number>(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);

  // 放大倍率: 1 (100%), 2 (200%), 4 (400%)
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const viewportRef = useRef<HTMLDivElement | null>(null);

  // 全局鼠标拖拽与把手事件监听，彻底杜绝手势抢占
  useEffect(() => {
    const handleWindowMouseMove = (e: MouseEvent) => {
      if (isDraggingSplit && viewportRef.current) {
        const rect = viewportRef.current.getBoundingClientRect();
        const percent = calculateSplitPercentFromEvent(e.clientX, rect);
        setSplitPercent(percent);
      } else if (isPanning && zoomLevel > 1 && viewportRef.current) {
        const dx = e.clientX - panStartRef.current.x;
        const dy = e.clientY - panStartRef.current.y;
        const rect = viewportRef.current.getBoundingClientRect();
        setPanOffset((prev) => {
          const raw = { x: prev.x + dx, y: prev.y + dy };
          return clampPanOffset(raw, zoomLevel, { width: rect.width, height: rect.height });
        });
        panStartRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handleWindowMouseUp = () => {
      setIsDraggingSplit(false);
      setIsPanning(false);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [isDraggingSplit, isPanning, zoomLevel]);

  // 键盘快捷键监听 (支持 1~5 切场景、Esc 返回、Delete/Backspace 删除当前场景)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!shortcutsEnabled || e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      const isInput = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));

      if (e.key === 'Escape') {
        if (showAddPopover) {
          e.preventDefault();
          closeAddPopover();
        } else {
          onSwitchToPlayer();
        }
      } else if (['1', '2', '3', '4', '5'].includes(e.key)) {
        if (isInput) return;
        const idx = parseInt(e.key, 10) - 1;
        if (idx < cachedSamples.length) {
          onSampleIndexChange(idx);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isInput || isAddingSample || loading || !scenesBarRef.current?.contains(target)) return;
        if (cachedSamples.length > 1 && onDeleteSample) {
          e.preventDefault();
          deleteSample(currentSampleIndex);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSwitchToPlayer, cachedSamples.length, onSampleIndexChange, onDeleteSample, currentSampleIndex, showAddPopover, shortcutsEnabled, isAddingSample, loading]);

  // 画布上鼠标按下：启动平移手势 (支持放大时的左键拖拽，或中键/右键任意时刻平移)
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if ((zoomLevel > 1 || e.button === 1 || e.button === 2) && !isDraggingSplit) {
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
      }
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  // 鼠标滚轮缩放支持 (1x ~ 4x 连续平滑缩放)
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.25 : -0.25;
    setZoomLevel((prev) => {
      const next = Math.max(1, Math.min(4, Math.round((prev + delta) * 100) / 100));
      if (next === 1) setPanOffset({ x: 0, y: 0 });
      return next;
    });
  };

  // 双击画面快速复位缩放与位置
  const handleDoubleClick = () => {
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  };

  const currentSample = cachedSamples[currentSampleIndex];
  const presetMeta = config.preset !== 'custom' ? COMPRESS_PRESETS[config.preset] : null;
  const crfDisplay = config.crf ?? presetMeta?.defaultCrf ?? 22;

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const reductionPercent = currentSample
    ? (((currentSample.originalSizeBytes - currentSample.compressedSizeBytes) / currentSample.originalSizeBytes) * 100).toFixed(1)
    : '0.0';

  return (
    <div className="w-full h-full flex flex-col bg-[#0b0e14] relative select-none overflow-hidden font-sans">
      {/* 1. 紧凑型顶部控制条 */}
      <div className="h-11 px-3 sm:px-4 border-b border-white/10 bg-[#121620] flex items-center justify-between shrink-0 z-20">
        {/* 左侧：返回剪辑播放与模式状态 */}
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            onClick={onSwitchToPlayer}
            className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1.5 transition-all shadow-md shadow-blue-600/20 active:scale-95 shrink-0"
            title="返回常规视频播放与剪辑 (Esc)"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>返回播放</span>
          </button>

          <div className="hidden sm:flex items-center gap-2 text-xs font-medium text-white truncate">
            <span className="text-zinc-400">|</span>
            <span className="flex items-center gap-1 text-purple-300">
              <Sparkles className="w-3.5 h-3.5" />
              <span>画质对比</span>
            </span>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-zinc-300">
              {config.preset === 'custom' ? '自定义' : presetMeta?.title} (CRF {crfDisplay})
            </span>
          </div>
        </div>

        {/* 右侧：对比模式切换与放大工具 */}
        <div className="flex items-center gap-2 shrink-0">
          {/* 模式双态胶囊 */}
          <div className="flex items-center bg-black/50 border border-white/10 p-0.5 rounded-lg gap-0.5">
            <button
              onClick={() => setViewMode('split')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition-all ${
                viewMode === 'split'
                  ? 'bg-blue-600 text-white font-bold shadow-sm'
                  : 'text-zinc-400 hover:text-white hover:bg-white/5'
              }`}
              title="卷帘对比模式 (左右拖动分割线)"
            >
              <ArrowLeftRight className="w-3 h-3" />
              <span className="hidden md:inline">卷帘对比</span>
            </button>
            <button
              onClick={() => setViewMode('side-by-side')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition-all ${
                viewMode === 'side-by-side'
                  ? 'bg-blue-600 text-white font-bold shadow-sm'
                  : 'text-zinc-400 hover:text-white hover:bg-white/5'
              }`}
              title="左右并排对比模式"
            >
              <Columns className="w-3 h-3" />
              <span className="hidden md:inline">左右并排</span>
            </button>
          </div>

          {/* 缩放选择 */}
          <div className="flex items-center bg-black/50 border border-white/10 p-0.5 rounded-lg gap-0.5">
            {[1, 2, 4].map((scale) => (
              <button
                key={scale}
                onClick={() => {
                  setZoomLevel(scale);
                  setPanOffset({ x: 0, y: 0 });
                }}
                className={`px-2 py-0.5 rounded text-[11px] font-mono transition-all ${
                  zoomLevel === scale
                    ? 'bg-white/20 text-white font-bold'
                    : 'text-zinc-400 hover:text-white'
                }`}
                title={`缩放到 ${scale * 100}% (双击画面快速复位)`}
              >
                {scale === 1 ? '1x' : `${scale}x`}
              </button>
            ))}
            {zoomLevel > 1 && (
              <button
                onClick={handleDoubleClick}
                className="p-1 rounded text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
                title="复位至 1x 居中"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 2. 核心主画布对比区 (与 VideoPlayer 同规格视口) */}
      <div
        ref={viewportRef}
        onMouseDown={handleCanvasMouseDown}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        className={`flex-1 relative overflow-hidden bg-black flex items-center justify-center min-h-0 ${
          zoomLevel > 1 ? (isPanning ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'
        }`}
      >
        {loading ? (
          <div className="flex flex-col items-center gap-2.5 text-zinc-400">
            <Loader2 className="w-7 h-7 animate-spin text-blue-400" />
            <span className="text-xs">正在抽取关键帧并执行单帧量化对比...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 text-rose-400 px-4 text-center">
            <Info className="w-6 h-6" />
            <span className="text-xs">{error}</span>
            <button onClick={onRetry} className="px-3 py-1 rounded bg-white/10 text-white text-xs hover:bg-white/20">重新加载</button>
          </div>
        ) : currentSample ? (
          viewMode === 'split' ? (
            // ================= A. 视口锚定卷帘对比视图 =================
            <div className="relative w-full h-full flex items-center justify-center overflow-hidden select-none">
              {/* 底层画面：原画 (随平移缩放自由变换) */}
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none transition-transform duration-75 ease-out"
                style={{
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
                  transformOrigin: 'center center',
                }}
              >
                <img
                  src={currentSample.originalBase64}
                  alt="原画"
                  className={`max-w-full max-h-full ${aspectClass} pointer-events-none`}
                />
              </div>

              {/* 顶层画面：降码图 (视口级 clipPath 裁切) */}
              <div
                className="absolute inset-0 pointer-events-none overflow-hidden select-none"
                style={{
                  clipPath: `polygon(${splitPercent}% 0, 100% 0, 100% 100%, ${splitPercent}% 100%)`,
                }}
              >
                <div
                  className="w-full h-full flex items-center justify-center transition-transform duration-75 ease-out"
                  style={{
                    transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
                    transformOrigin: 'center center',
                  }}
                >
                  <img
                    src={currentSample.compressedBase64}
                    alt="降码"
                    className={`max-w-full max-h-full ${aspectClass}`}
                  />
                </div>
              </div>

              {/* 视口级卷帘分割把手 (永远锚定在可视画框内，绝不随画面放大平移漂出！) */}
              <div
                className="absolute top-0 bottom-0 z-30 pointer-events-auto cursor-col-resize group select-none"
                style={{ left: `${splitPercent}%`, transform: 'translateX(-50%)' }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setIsDraggingSplit(true);
                }}
              >
                {/* 24px 宽热区防脱手 */}
                <div className="w-6 h-full flex items-center justify-center relative">
                  {/* 分割光晕线 */}
                  <div className="w-0.5 h-full bg-white/90 shadow-[0_0_10px_rgba(255,255,255,0.9)] group-hover:bg-blue-400 group-hover:shadow-[0_0_14px_rgba(59,130,246,1)] transition-colors" />
                  {/* 居中拖拽把手图标 */}
                  <div className="absolute top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white text-zinc-900 shadow-xl flex items-center justify-center border border-black/20 group-hover:scale-110 active:scale-95 transition-transform pointer-events-none">
                    <ArrowLeftRight className="w-3.5 h-3.5" />
                  </div>
                </div>
              </div>

              {/* 视口浮动标签 */}
              <div className="absolute top-3 left-3 z-20 bg-black/60 backdrop-blur-md px-2.5 py-1 rounded-md border border-white/10 text-white text-[11px] font-mono flex items-center gap-1.5 pointer-events-none shadow-md">
                <span className="w-2 h-2 rounded-full bg-cyan-400" />
                <span>原画 ({formatBytes(currentSample.originalSizeBytes)})</span>
              </div>

              <div className="absolute top-3 right-3 z-20 bg-black/60 backdrop-blur-md px-2.5 py-1 rounded-md border border-white/10 text-white text-[11px] font-mono flex items-center gap-1.5 pointer-events-none shadow-md">
                <span className="w-2 h-2 rounded-full bg-purple-400" />
                <span>降码 CRF {crfDisplay} ({formatBytes(currentSample.compressedSizeBytes)})</span>
              </div>

              {zoomLevel > 1 && (
                <div className="absolute bottom-3 right-3 z-20 bg-black/70 backdrop-blur-md px-2.5 py-1 rounded-md border border-white/10 text-zinc-300 text-[10px] font-mono pointer-events-none">
                  按住拖动画布平移 · 双击复位
                </div>
              )}
            </div>
          ) : (
            // ================= B. 左右并排对比视图 =================
            <div
              className="w-full h-full p-2 grid grid-cols-2 gap-2 items-center select-none"
              style={{
                transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
                transformOrigin: 'center center',
              }}
            >
              {/* 左视窗：原画 */}
              <div className="relative w-full h-full bg-[#141824] rounded-xl border border-white/10 overflow-hidden flex flex-col">
                <div className="px-3 py-1.5 bg-black/40 border-b border-white/10 flex items-center justify-between text-[11px] font-mono">
                  <span className="text-cyan-300 font-bold flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" /> 原片画质
                  </span>
                  <span className="text-zinc-400">{formatBytes(currentSample.originalSizeBytes)}</span>
                </div>
                <div className="flex-1 flex items-center justify-center p-1.5 min-h-0">
                  <img
                    src={currentSample.originalBase64}
                    alt="原片画质"
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              </div>

              {/* 右视窗：降码 */}
              <div className="relative w-full h-full bg-[#141824] rounded-xl border border-white/10 overflow-hidden flex flex-col">
                <div className="px-3 py-1.5 bg-black/40 border-b border-white/10 flex items-center justify-between text-[11px] font-mono">
                  <span className="text-purple-300 font-bold flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-purple-400" /> 降码 (CRF {crfDisplay})
                  </span>
                  <span className="text-emerald-400 font-bold">
                    {formatBytes(currentSample.compressedSizeBytes)} (-{reductionPercent}%)
                  </span>
                </div>
                <div className="flex-1 flex items-center justify-center p-1.5 min-h-0">
                  <img
                    src={currentSample.compressedBase64}
                    alt="降码画质"
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              </div>
            </div>
          )
        ) : null}
      </div>

      {/* 3. 底部多场景抽样帧选择栏 */}
      <div className="h-10 px-3 sm:px-4 border-t border-white/10 bg-[#121620] flex items-center justify-between shrink-0 z-20 text-xs">
        {/* 场景帧胶囊切换与增删 */}
        <div ref={scenesBarRef} className="flex items-center gap-1.5 overflow-x-auto no-scrollbar relative">
          <span className="text-zinc-400 text-[11px] shrink-0">抽样场景:</span>
          {cachedSamples.map((s, idx) => (
            <div
              key={s.timestampMs}
              className={`px-2.5 py-0.5 rounded-md text-[11px] font-mono transition-all flex items-center gap-1 border shrink-0 group ${
                currentSampleIndex === idx
                  ? 'bg-blue-600 text-white font-bold border-blue-400 shadow-sm'
                  : 'bg-black/30 text-zinc-400 border-white/5 hover:text-white hover:border-white/20'
              }`}
            >
              <button
                data-scene-index={idx}
                onClick={() => {
                  onSampleIndexChange(idx);
                  setPanOffset({ x: 0, y: 0 });
                }}
                className="flex items-center gap-1"
                title={`切换至第 ${idx + 1} 个测试场景 (${formatTimecode(s.timestampMs, false)})，选中后可按 Delete 删除`}
              >
                <span>场景 {idx + 1}</span>
                <span className="opacity-70 text-[10px]">({formatTimecode(s.timestampMs, false)})</span>
              </button>
              {cachedSamples.length > 1 && onDeleteSample && (
                <button
                  disabled={isAddingSample || loading}
                  aria-label={`删除场景 ${idx + 1}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSample(idx);
                  }}
                  className="ml-0.5 -mr-0.5 p-0.5 text-zinc-400 hover:text-red-300 hover:bg-red-500/20 rounded transition-all opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 disabled:cursor-wait"
                  title="删除此场景对比点 (快捷键 Delete)"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          ))}

          {/* 添加场景按钮与展开气泡 */}
          {onAddSample && (
            <div className="relative shrink-0 flex items-center">
              <button
                ref={addButtonRef}
                disabled={cachedSamples.length === 0 || cachedSamples.length >= 5 || isAddingSample || loading}
                onClick={toggleAddPopover}
                className={`px-2 py-0.5 rounded-md text-[11px] border flex items-center gap-1 transition-all ${
                  cachedSamples.length >= 5
                    ? 'bg-black/20 text-zinc-600 border-white/5 cursor-not-allowed'
                    : 'bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white border-white/10 hover:border-blue-500/40 active:scale-95'
                }`}
                title={cachedSamples.length >= 5 ? '已达 5 个对比场景上限' : '添加新的画质对比场景点（或双击时间轴空白处）'}
              >
                {isAddingSample ? (
                  <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
                ) : (
                  <Plus className="w-3 h-3 text-blue-400" />
                )}
                <span>场景</span>
              </button>

              {/* 展开的时间码输入气泡 */}
              {showAddPopover && shortcutsEnabled && createPortal(
                <div
                  ref={addPopoverRef}
                  role="dialog"
                  aria-label="添加对比场景点"
                  style={popoverPosition}
                  className="fixed z-[60] bg-[#161a24] border border-white/20 rounded-xl p-3 shadow-2xl flex flex-col gap-2.5 w-80 max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto backdrop-blur-xl select-none"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between text-xs font-bold text-white pb-1.5 border-b border-white/10">
                    <span className="flex items-center gap-1">
                      <Plus className="w-3.5 h-3.5 text-blue-400" /> 添加对比场景点
                    </span>
                    <button
                      onClick={closeAddPopover}
                      className="text-zinc-400 hover:text-white text-xs px-1 hover:bg-white/10 rounded"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <input
                        ref={addInputRef}
                        type="text"
                        value={addTimeInput}
                        disabled={isAddingSample}
                        onChange={(e) => {
                          setAddTimeInput(e.target.value);
                          setAddInputError('');
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void handleConfirmAdd(); }
                          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAddPopover(); }
                        }}
                        placeholder="00:00.000 或秒数"
                        className={`flex-1 min-w-0 px-2 py-1 bg-black/60 border rounded text-xs font-mono text-white outline-none transition-colors ${
                          addInputError ? 'border-rose-500' : 'border-white/15 focus:border-blue-500'
                        }`}
                      />
                      {currentTimeMs !== undefined && (
                        <button
                          type="button"
                          disabled={isAddingSample}
                          onClick={() => {
                            setAddTimeInput(formatTimecode(currentTimeMs, false));
                            setAddInputError('');
                          }}
                          className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-[10px] border border-white/10 whitespace-nowrap active:scale-95 transition-all"
                          title="采纳当前时间轴游标所在帧"
                        >
                          当前帧
                        </button>
                      )}
                    </div>
                    {addInputError && (
                      <span className="text-[10px] text-rose-400">{addInputError}</span>
                    )}
                  </div>

                  <div className="flex items-center justify-end gap-1.5 pt-0.5">
                    <button
                      onClick={closeAddPopover}
                      className="px-2 py-0.5 text-xs text-zinc-400 hover:text-white"
                    >
                      取消
                    </button>
                    <button
                      onClick={handleConfirmAdd}
                      disabled={isAddingSample || loading || cachedSamples.length >= 5}
                      className="px-3 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm active:scale-95 transition-all"
                    >
                      {isAddingSample ? '正在抽取...' : '确认添加'}
                    </button>
                  </div>
                </div>, document.body
              )}
            </div>
          )}

          {/* 恢复推荐场景按钮 */}
          {isCustomized && onResetDefaultSamples && (
            <button
              onClick={onResetDefaultSamples}
              className="px-2 py-0.5 rounded text-[10px] text-zinc-400 hover:text-zinc-200 bg-white/5 hover:bg-white/10 border border-white/10 flex items-center gap-1 transition-all shrink-0 active:scale-95"
              title="一键恢复系统自动推荐的抽样场景点"
            >
              <RotateCcw className="w-2.5 h-2.5 text-zinc-400" />
              <span>恢复推荐</span>
            </button>
          )}
        </div>

        {/* 缩减指示 */}
        {currentSample && (
          <div className="hidden md:flex items-center gap-3 text-[11px] font-mono">
            <span className="text-zinc-400">
              单帧缩减:{' '}
              <span className="text-emerald-400 font-bold">
                {reductionPercent}%
              </span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
