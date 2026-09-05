import React, { useState, useEffect, useRef } from 'react';
import {
  Columns,
  ArrowLeftRight,
  Loader2,
  Info,
  RotateCcw,
  Sparkles,
  ArrowLeft,
} from 'lucide-react';
import { CompressConfig, PreviewSample } from '../../shared/types';
import { COMPRESS_PRESETS } from '../../shared/compressPresets';
import { formatTimecode } from './VideoPlayer';
import {
  calculateSplitPercentFromEvent,
  clampPanOffset,
} from '../../shared/viewportCompareMath';

export type { PreviewSample };

export interface VideoCompareViewProps {
  videoPath: string;
  config: CompressConfig;
  sampleTimestampsMs: number[];
  cachedSamples: PreviewSample[];
  currentSampleIndex: number;
  onSampleIndexChange: (index: number) => void;
  onSamplesLoaded: (samples: PreviewSample[]) => void;
  onSwitchToPlayer: () => void;
  viewMode?: 'split' | 'side-by-side';
  onViewModeChange?: (mode: 'split' | 'side-by-side') => void;
  aspectRatioMode?: 'auto' | '16:9' | '1:1' | 'contain';
}

export const VideoCompareView: React.FC<VideoCompareViewProps> = ({
  videoPath,
  config,
  sampleTimestampsMs,
  cachedSamples,
  currentSampleIndex,
  onSampleIndexChange,
  onSamplesLoaded,
  onSwitchToPlayer,
  viewMode: controlledViewMode,
  onViewModeChange,
  aspectRatioMode = 'contain',
}) => {
  const aspectClass =
    aspectRatioMode === '16:9'
      ? 'aspect-video object-contain'
      : aspectRatioMode === '1:1'
      ? 'aspect-square object-contain'
      : 'object-contain';
  const [loading, setLoading] = useState(cachedSamples.length === 0);
  const [error, setError] = useState<string | null>(null);

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

  // 加载抽样帧数据（有缓存且配置一致时不重复拉取）
  useEffect(() => {
    let isMounted = true;

    if (cachedSamples.length > 0) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const fetchSamples = async () => {
      try {
        if (!window.electronAPI?.previewCompressionSamples) {
          throw new Error('未检测到预览采样服务通道');
        }
        const timestamps = sampleTimestampsMs.length > 0 ? sampleTimestampsMs : [1000, 3000, 5000];
        const res = await window.electronAPI.previewCompressionSamples(videoPath, timestamps, config);
        if (isMounted) {
          if (res && res.length > 0) {
            onSamplesLoaded(res);
            if (currentSampleIndex >= res.length) {
              onSampleIndexChange(0);
            }
          } else {
            setError('未能抽取到有效测试画格');
          }
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err.message || '加载预览抽样失败');
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchSamples();

    return () => {
      isMounted = false;
    };
  }, [videoPath, config, sampleTimestampsMs, cachedSamples.length, currentSampleIndex, onSampleIndexChange, onSamplesLoaded]);

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

  // 键盘快捷键监听
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onSwitchToPlayer();
      } else if (['1', '2', '3', '4', '5'].includes(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < cachedSamples.length) {
          onSampleIndexChange(idx);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSwitchToPlayer, cachedSamples.length, onSampleIndexChange]);

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
        {/* 场景帧胶囊切换 */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          <span className="text-zinc-400 text-[11px] shrink-0">抽样场景:</span>
          {cachedSamples.map((s, idx) => (
            <button
              key={s.index}
              onClick={() => {
                onSampleIndexChange(idx);
                setPanOffset({ x: 0, y: 0 });
              }}
              className={`px-2.5 py-0.5 rounded-md text-[11px] font-mono transition-all flex items-center gap-1 border shrink-0 ${
                currentSampleIndex === idx
                  ? 'bg-blue-600 text-white font-bold border-blue-400 shadow-sm'
                  : 'bg-black/30 text-zinc-400 border-white/5 hover:text-white hover:border-white/20'
              }`}
              title={`切换至第 ${idx + 1} 个测试场景 (${formatTimecode(s.timestampMs, false)})，快捷键按数字键 ${idx + 1}`}
            >
              <span>场景 {idx + 1}</span>
              <span className="opacity-70 text-[10px]">({formatTimecode(s.timestampMs, false)})</span>
            </button>
          ))}
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
