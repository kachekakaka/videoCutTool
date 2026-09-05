import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Segment } from '../../shared/types';
import { formatTimecode } from './VideoPlayer';
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Play,
  Pause,
  StepBack,
  StepForward,
  Rewind,
  FastForward,
  Scissors,
} from 'lucide-react';

interface TimelineProps {
  durationMs: number;
  currentTimeMs: number;
  keyframes: number[];
  cuts: number[];
  segments: Segment[];
  isPlaying?: boolean;
  aspectRatioMode?: 'auto' | '16:9' | '1:1';
  onSeek: (timeMs: number) => void;
  onDeleteCut?: (cutMs: number) => void;
  onTogglePlay?: () => void;
  onStepFrame?: (deltaFrames: number) => void;
  onStepSeconds?: (seconds: number) => void;
  onToggleAspectRatio?: (mode: 'auto' | '16:9' | '1:1') => void;
  onInsertCut?: () => void;
}

export const Timeline: React.FC<TimelineProps> = ({
  durationMs,
  currentTimeMs,
  keyframes,
  cuts,
  segments,
  isPlaying = false,
  aspectRatioMode = 'auto',
  onSeek,
  onDeleteCut,
  onTogglePlay,
  onStepFrame,
  onStepSeconds,
  onToggleAspectRatio,
  onInsertCut,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingRef = useRef(false);
  const isPanningRef = useRef(false);
  const panStartXRef = useRef(0);
  const panStartViewMsRef = useRef(0);

  const [zoom, setZoom] = useState(1); // 1x ~ 8x 缩放倍数
  const [viewStartMs, setViewStartMs] = useState(0); // 视窗起始时间 (ms)
  const [selectedCutMs, setSelectedCutMs] = useState<number | null>(null);

  // 计算当前可视时间窗口 (严格封顶于视频末尾，彻底消除后半截不可达缺陷)
  const visibleDurationMs = Math.max(1000, durationMs / zoom);
  const maxViewStartMs = Math.max(0, durationMs - visibleDurationMs);
  const clampedViewStartMs = Math.max(0, Math.min(maxViewStartMs, viewStartMs));
  const viewEndMs = Math.min(durationMs, clampedViewStartMs + visibleDurationMs);

  // 缩放调节（以当前指针或当前视窗中心为锚点平滑展开）
  const handleZoom = (delta: number) => {
    setZoom((prev) => {
      const next = Math.max(1, Math.min(8, Number((prev + delta).toFixed(1))));
      if (next === 1) {
        setViewStartMs(0);
      } else {
        const nextVisible = durationMs / next;
        // 优先以当前播放指针为锚点进行缩放，确保焦点不迷失
        const anchor =
          currentTimeMs >= clampedViewStartMs && currentTimeMs <= viewEndMs
            ? currentTimeMs
            : clampedViewStartMs + visibleDurationMs / 2;
        const nextMaxStart = Math.max(0, durationMs - nextVisible);
        const nextStart = Math.max(0, Math.min(nextMaxStart, anchor - nextVisible / 2));
        setViewStartMs(nextStart);
      }
      return next;
    });
  };

  const resetZoom = () => {
    setZoom(1);
    setViewStartMs(0);
  };

  // 键盘快捷键监听 Delete 删除选中的切点
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedCutMs !== null && onDeleteCut) {
        onDeleteCut(selectedCutMs);
        setSelectedCutMs(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedCutMs, onDeleteCut]);

  // 绘制时间轴
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, width, height);
    if (durationMs <= 0) return;

    const logicalWidth = width / dpr;
    const logicalHeight = height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. 绘制刻度背景
    ctx.fillStyle = '#0f131a';
    ctx.fillRect(0, 0, logicalWidth, logicalHeight);

    // 2. 绘制时间刻度线 (顶部 14px)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillRect(0, 0, logicalWidth, 14);

    // 动态步长计算
    let stepMs = 5000 / zoom;
    if (stepMs > 30000) stepMs = 30000;
    else if (stepMs > 10000) stepMs = 10000;
    else if (stepMs > 2000) stepMs = 2000;
    else if (stepMs > 500) stepMs = 500;
    else stepMs = 200;

    const firstTickMs = Math.floor(clampedViewStartMs / stepMs) * stepMs;
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let t = firstTickMs; t <= viewEndMs; t += stepMs) {
      if (t < clampedViewStartMs) continue;
      const x = ((t - clampedViewStartMs) / visibleDurationMs) * logicalWidth;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 8);
      ctx.lineTo(x, 14);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.fillText(formatTimecode(t, false), x, 5);
    }

    // 3. 绘制分段区间 (高度 16px ~ 38px，共 22px 高度，紧凑利落)
    const trackY = 16;
    const trackHeight = 22;

    for (const seg of segments) {
      if (seg.endMs < clampedViewStartMs || seg.startMs > viewEndMs) continue;

      const clampedStart = Math.max(clampedViewStartMs, seg.startMs);
      const clampedEnd = Math.min(viewEndMs, seg.endMs);
      const x1 = ((clampedStart - clampedViewStartMs) / visibleDurationMs) * logicalWidth;
      const x2 = ((clampedEnd - clampedViewStartMs) / visibleDurationMs) * logicalWidth;
      const segWidth = Math.max(2, x2 - x1);

      if (seg.decision === 'keep') {
        // 保留段：翠绿柔和磨砂底色
        ctx.fillStyle = 'rgba(35, 134, 54, 0.45)';
        ctx.strokeStyle = '#2ea043';
        ctx.lineWidth = 1.5;
        ctx.fillRect(x1, trackY, segWidth, trackHeight);
        ctx.strokeRect(x1, trackY, segWidth, trackHeight);
      } else {
        // 丢弃段：深灰暗红底色 + 色盲辅助 45度斑马斜纹
        ctx.fillStyle = 'rgba(218, 54, 51, 0.2)';
        ctx.strokeStyle = 'rgba(218, 54, 51, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.fillRect(x1, trackY, segWidth, trackHeight);
        ctx.strokeRect(x1, trackY, segWidth, trackHeight);

        // 绘制无障碍斑马线 (Hatching lines for Colorblind)
        ctx.save();
        ctx.beginPath();
        ctx.rect(x1, trackY, segWidth, trackHeight);
        ctx.clip();
        ctx.strokeStyle = 'rgba(248, 81, 73, 0.25)';
        ctx.lineWidth = 1.5;
        for (let lx = x1 - trackHeight; lx < x1 + segWidth; lx += 8) {
          ctx.beginPath();
          ctx.moveTo(lx, trackY + trackHeight);
          ctx.lineTo(lx + trackHeight, trackY);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 序号标识
      if (segWidth > 24) {
        ctx.fillStyle = seg.decision === 'keep' ? '#3fb950' : '#f85149';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(`#${seg.index}`, x1 + segWidth / 2, trackY + trackHeight / 2);
      }
    }

    // 4. 绘制关键帧位置微标 (青色微圆点，位于轨道底部)
    ctx.fillStyle = '#38bdf8';
    for (const kf of keyframes) {
      if (kf >= clampedViewStartMs && kf <= viewEndMs) {
        const kx = ((kf - clampedViewStartMs) / visibleDurationMs) * logicalWidth;
        ctx.beginPath();
        ctx.arc(kx, logicalHeight - 3, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 5. 绘制切点竖线旗标
    for (const cutMs of cuts) {
      if (cutMs >= clampedViewStartMs && cutMs <= viewEndMs) {
        const cx = ((cutMs - clampedViewStartMs) / visibleDurationMs) * logicalWidth;
        const isSelected = selectedCutMs === cutMs;

        ctx.strokeStyle = isSelected ? '#38bdf8' : '#f59e0b';
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, logicalHeight);
        ctx.stroke();

        // 顶部微型菱形
        ctx.fillStyle = isSelected ? '#38bdf8' : '#f59e0b';
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx - (isSelected ? 4 : 2.5), isSelected ? 6 : 4);
        ctx.lineTo(cx + (isSelected ? 4 : 2.5), isSelected ? 6 : 4);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 6. 绘制播放游标针 (当前时间)
    if (currentTimeMs >= clampedViewStartMs && currentTimeMs <= viewEndMs) {
      const playheadX = ((currentTimeMs - clampedViewStartMs) / visibleDurationMs) * logicalWidth;
      ctx.shadowColor = '#58a6ff';
      ctx.shadowBlur = 5;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;

      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, logicalHeight);
      ctx.stroke();

      // 游标顶部倒三角指针
      ctx.fillStyle = '#58a6ff';
      ctx.beginPath();
      ctx.moveTo(playheadX - 5, 0);
      ctx.lineTo(playheadX + 5, 0);
      ctx.lineTo(playheadX, 7);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }, [durationMs, currentTimeMs, keyframes, cuts, segments, zoom, clampedViewStartMs, viewEndMs, visibleDurationMs, selectedCutMs]);

  // 自适应 Canvas 大小
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      draw();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    return () => observer.disconnect();
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  const getTimeFromMouseEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || durationMs <= 0) return 0;
    const rect = canvas.getBoundingClientRect();
    const offsetX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = offsetX / rect.width;
    return Math.round(clampedViewStartMs + ratio * visibleDurationMs);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // 中键或右键：进入视窗平移模式
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      isPanningRef.current = true;
      panStartXRef.current = e.clientX;
      panStartViewMsRef.current = clampedViewStartMs;
      return;
    }

    if (e.button !== 0) return; // 左键才触发寻址与切点选择

    const targetMs = getTimeFromMouseEvent(e);

    // 检查是否点击在某个切点附近 (±6px)
    const canvas = canvasRef.current;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      let clickedCut: number | null = null;
      for (const c of cuts) {
        const cx = ((c - clampedViewStartMs) / visibleDurationMs) * rect.width;
        if (Math.abs(cx - (e.clientX - rect.left)) <= 6) {
          clickedCut = c;
          break;
        }
      }
      setSelectedCutMs(clickedCut);
    }

    isDraggingRef.current = true;
    onSeek(targetMs);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanningRef.current && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const deltaPx = e.clientX - panStartXRef.current;
      const deltaMs = (deltaPx / rect.width) * visibleDurationMs;
      const nextStart = Math.max(0, Math.min(maxViewStartMs, panStartViewMsRef.current - deltaMs));
      setViewStartMs(nextStart);
      return;
    }

    if (isDraggingRef.current) {
      const targetMs = getTimeFromMouseEvent(e);
      onSeek(targetMs);
    }
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
    isPanningRef.current = false;
  };

  // 鼠标滚轮缩放与水平平移
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (e.ctrlKey) {
      // Ctrl + 滚轮：缩放
      if (e.deltaY < 0) {
        handleZoom(0.5);
      } else {
        handleZoom(-0.5);
      }
    } else {
      // 普通滚轮或触控板：水平平移时间轴视野
      if (zoom <= 1) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      // 每次滚动平移可视窗口宽度的 7%
      const panStepMs = visibleDurationMs * 0.07 * (delta > 0 ? 1 : -1);
      setViewStartMs((prev) => Math.max(0, Math.min(maxViewStartMs, prev + panStepMs)));
    }
  };

  return (
    <div className="w-full flex flex-col gap-1 px-3 py-1.5 rounded-xl bg-[#161b22]/90 border border-white/10 shadow-xl backdrop-blur-md">
      {/* ── 顶部三段式控制条 (左侧时间与图例 + 中间绝对居中播放 + 右侧缩放与切点) ── */}
      <div className="relative flex items-center justify-between gap-2 px-1 min-h-[28px]">
        {/* 左侧：时间码与比例切换 + 紧凑内联图例 */}
        <div className="flex items-center gap-2 shrink-0 z-0">
          <div className="flex items-center gap-1.5 font-mono text-xs text-zinc-300">
            <span className="text-white font-bold text-xs bg-black/50 px-1.5 py-0.5 rounded border border-white/10 shadow-inner">
              {formatTimecode(currentTimeMs)}
            </span>
            <span className="text-zinc-500">/</span>
            <span className="text-zinc-400 text-xs">{formatTimecode(durationMs)}</span>

            {onToggleAspectRatio && (
              <button
                onClick={() => {
                  const next = aspectRatioMode === 'auto' ? '16:9' : aspectRatioMode === '16:9' ? '1:1' : 'auto';
                  onToggleAspectRatio(next);
                }}
                className="px-1.5 py-0.5 rounded text-[11px] font-sans text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 transition-colors ml-0.5"
                title="切换画面比例模式 (自适应 / 16:9 / 1:1)"
              >
                {aspectRatioMode === 'auto' ? '自适应' : aspectRatioMode === '16:9' ? '16:9' : '1:1'}
              </button>
            )}
          </div>

          {/* 紧凑内联图例 (大屏完整展开，小屏微型色标自适应，彻底杜绝重叠) */}
          <div className="hidden min-[1080px]:flex items-center gap-1.5 text-[10px] text-zinc-400 bg-black/40 border border-white/10 rounded-md px-1.5 py-0.5">
            <span className="flex items-center gap-0.5" title="I 帧关键帧 (安全吸附切点)">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
              <span>关键帧</span>
            </span>
            <span className="flex items-center gap-0.5" title="导出保留正片">
              <span className="w-1.5 h-1.5 rounded-sm bg-emerald-500" />
              <span>保留</span>
            </span>
            <span className="flex items-center gap-0.5" title="导出丢弃切片">
              <span className="w-1.5 h-1.5 rounded-sm bg-rose-500" />
              <span>丢弃</span>
            </span>
            <span className="flex items-center gap-0.5" title="时间切点 (点选可按 Del 删除)">
              <span className="w-1.5 h-1.5 rounded-sm bg-amber-400" />
              <span>切点</span>
            </span>
          </div>

          <div
            className="flex min-[1080px]:hidden items-center gap-1 text-[10px] text-zinc-400 bg-black/40 border border-white/10 rounded-md px-1.5 py-0.5 cursor-help"
            title="图例说明: 蓝点=关键帧, 绿块=保留正片, 红块=丢弃切片, 黄块=时间切点"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
            <span className="w-1.5 h-1.5 rounded-sm bg-emerald-500" />
            <span className="w-1.5 h-1.5 rounded-sm bg-rose-500" />
            <span className="w-1.5 h-1.5 rounded-sm bg-amber-400" />
            <span className="text-[9px] text-zinc-500 font-sans ml-0.5">图例</span>
          </div>
        </div>

        {/* 中间：播放核心操作群 (数学绝对居中聚焦视线) */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-1.5 z-10 pointer-events-auto">
          {onStepSeconds && (
            <button
              onClick={() => onStepSeconds(-1)}
              className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-all active:scale-95"
              title="快退 1 秒 (Shift+左方向键)"
            >
              <Rewind className="w-3.5 h-3.5" />
            </button>
          )}

          {onStepFrame && (
            <button
              onClick={() => onStepFrame(-1)}
              className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-all active:scale-95"
              title="上一帧 (左方向键)"
            >
              <StepBack className="w-3.5 h-3.5" />
            </button>
          )}

          {onTogglePlay && (
            <button
              onClick={onTogglePlay}
              className="w-7 h-7 rounded-lg bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center transition-all shadow-md shadow-blue-500/30 active:scale-95 mx-0.5"
              title={isPlaying ? '暂停 (空格)' : '播放 (空格)'}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current ml-0.5" />}
            </button>
          )}

          {onStepFrame && (
            <button
              onClick={() => onStepFrame(1)}
              className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-all active:scale-95"
              title="下一帧 (右方向键)"
            >
              <StepForward className="w-3.5 h-3.5" />
            </button>
          )}

          {onStepSeconds && (
            <button
              onClick={() => onStepSeconds(1)}
              className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-all active:scale-95"
              title="快进 1 秒 (Shift+右键)"
            >
              <FastForward className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* 右侧：缩放控制器与插入切点 */}
        <div className="flex items-center gap-2 shrink-0 z-0 ml-auto">
          {selectedCutMs !== null && onDeleteCut && (
            <button
              onClick={() => {
                onDeleteCut(selectedCutMs);
                setSelectedCutMs(null);
              }}
              className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-bold hover:bg-amber-500/30 transition-all flex items-center gap-1 active:scale-95"
            >
              <span>删除切点 ({formatTimecode(selectedCutMs, false)})</span>
            </button>
          )}

          {/* 恒定等宽缩放胶囊，重置按钮常驻防位移错位 */}
          <div className="flex items-center bg-black/50 border border-white/10 rounded-lg p-0.5 text-[10px]">
            <button
              onClick={() => handleZoom(-0.5)}
              className="p-1 rounded hover:bg-white/10 text-zinc-300 hover:text-white transition-all active:scale-95"
              title="缩小时间轴 (Ctrl + 滚轮向下)"
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            <span className="w-8 text-center font-mono text-white font-bold select-none">{zoom.toFixed(1)}x</span>
            <button
              onClick={() => handleZoom(0.5)}
              className="p-1 rounded hover:bg-white/10 text-zinc-300 hover:text-white transition-all active:scale-95"
              title="放大时间轴 (Ctrl + 滚轮向上)"
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <button
              onClick={resetZoom}
              disabled={zoom === 1}
              className={`p-1 rounded transition-all ml-0.5 border-l border-white/10 ${
                zoom === 1
                  ? 'opacity-20 text-zinc-600 cursor-not-allowed pointer-events-none'
                  : 'hover:bg-white/10 text-zinc-300 hover:text-white cursor-pointer active:scale-95'
              }`}
              title={zoom === 1 ? '已处于 1:1 全片视窗' : '还原 1:1 全片视窗'}
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </div>

          {onInsertCut && (
            <button
              onClick={onInsertCut}
              className="px-3 py-1 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-blue-500/25 transition-all active:scale-95 border border-blue-400/30"
              title="在当前游标处插入切点 (快捷键 C)"
            >
              <Scissors className="w-3 h-3" />
              <span>插入切点</span>
              <kbd className="bg-black/30 border border-white/20 px-1 py-0.2 rounded text-[10px] text-blue-200">C</kbd>
            </button>
          )}
        </div>
      </div>

      {/* ── Canvas 时间轴主轨道 (紧凑 46px 高度) ── */}
      <div className="relative w-full h-[46px] rounded-xl overflow-hidden border border-white/10 cursor-crosshair select-none">
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
          className="w-full h-full block"
        />

        {/* 缩放状态下底部微型视窗位置指示条 */}
        {zoom > 1 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50 pointer-events-none">
            <div
              className="h-full bg-blue-500/70 rounded-full transition-all duration-75"
              style={{
                marginLeft: `${Math.min(99, Math.max(0, (clampedViewStartMs / durationMs) * 100))}%`,
                width: `${Math.min(100, Math.max(1, (visibleDurationMs / durationMs) * 100))}%`,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};
