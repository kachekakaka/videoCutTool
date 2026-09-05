import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Segment } from '../../shared/types';
import { formatTimecode, parseTimecodeToMs } from './VideoPlayer';
import { TimelineThumbnailPreview } from './TimelineThumbnailPreview';
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

interface CutDragState {
  isDragging: boolean;
  cutIndex: number;
  originalTimeMs: number;
  currentTimeMs: number;
  isSnapped: boolean;
  isHitBarrier: boolean;
  anchorX: number;
}

interface CutPopoverState {
  visible: boolean;
  cutIndex: number;
  cutMs: number;
  anchorX: number;
  inputValue: string;
  errorMsg?: string;
}

interface TimelineProps {
  durationMs: number;
  currentTimeMs: number;
  keyframes: number[];
  cuts: number[];
  segments: Segment[];
  videoPath?: string;
  isPlaying?: boolean;
  aspectRatioMode?: 'auto' | '16:9' | '1:1';
  onSeek: (timeMs: number) => void;
  onDeleteCut?: (cutMs: number) => void;
  onMoveCut?: (cutIndex: number, newTimeMs: number) => boolean;
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
  videoPath,
  isPlaying = false,
  aspectRatioMode = 'auto',
  onSeek,
  onDeleteCut,
  onMoveCut,
  onTogglePlay,
  onStepFrame,
  onStepSeconds,
  onToggleAspectRatio,
  onInsertCut,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackWrapperRef = useRef<HTMLDivElement | null>(null);
  const popoverInputRef = useRef<HTMLInputElement | null>(null);

  const isDraggingRef = useRef(false);
  const isPanningRef = useRef(false);
  const panStartXRef = useRef(0);
  const panStartViewMsRef = useRef(0);

  // 长按与拖拽状态追踪
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const dragStartRef = useRef<{ startX: number; startY: number; timeMs: number; cutIndex: number } | null>(null);
  const lastCutClickRef = useRef<{ cutIndex: number; time: number } | null>(null);

  const [zoom, setZoom] = useState(1); // 1x ~ 8x 缩放倍数
  const [viewStartMs, setViewStartMs] = useState(0); // 视窗起始时间 (ms)
  const [selectedCutMs, setSelectedCutMs] = useState<number | null>(null);
  const [trackWidth, setTrackWidth] = useState(800);

  // 切点长按拖拽状态
  const [cutDragState, setCutDragState] = useState<CutDragState>({
    isDragging: false,
    cutIndex: -1,
    originalTimeMs: 0,
    currentTimeMs: 0,
    isSnapped: false,
    isHitBarrier: false,
    anchorX: 0,
  });
  const cutDragStateRef = useRef(cutDragState);
  cutDragStateRef.current = cutDragState;

  // 切点就地时间码编辑气泡状态
  const [popoverState, setPopoverState] = useState<CutPopoverState>({
    visible: false,
    cutIndex: -1,
    cutMs: 0,
    anchorX: 0,
    inputValue: '',
  });

  // 当 popover 开启时自动聚焦输入框并全选内容
  useEffect(() => {
    if (popoverState.visible && popoverInputRef.current) {
      popoverInputRef.current.focus();
      popoverInputRef.current.select();
    }
  }, [popoverState.visible]);

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

  // 键盘快捷键监听 Delete 删除选中的切点 & Escape 取消输入气泡
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPopoverState((p) => (p.visible ? { ...p, visible: false } : p));
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedCutMs !== null && onDeleteCut) {
        if (popoverState.visible) return;
        onDeleteCut(selectedCutMs);
        setSelectedCutMs(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedCutMs, onDeleteCut, popoverState.visible]);

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
    for (let i = 0; i < cuts.length; i++) {
      const rawCutMs = cuts[i];
      const isThisDragging = cutDragState.isDragging && cutDragState.cutIndex === i;
      const cutMs = isThisDragging ? cutDragState.currentTimeMs : rawCutMs;

      if (cutMs >= clampedViewStartMs && cutMs <= viewEndMs) {
        const cx = ((cutMs - clampedViewStartMs) / visibleDurationMs) * logicalWidth;
        const isSelected = selectedCutMs === rawCutMs || isThisDragging;

        if (isThisDragging) {
          // 长按拖拽激活状态：Scale 1.25 + 亮蓝外发光脉冲
          ctx.save();
          ctx.shadowColor = '#38bdf8';
          ctx.shadowBlur = 10;
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(cx, 0);
          ctx.lineTo(cx, logicalHeight);
          ctx.stroke();

          // 顶部放大菱形
          ctx.fillStyle = '#38bdf8';
          ctx.beginPath();
          ctx.moveTo(cx, 0);
          ctx.lineTo(cx - 5.5, 7.5);
          ctx.lineTo(cx + 5.5, 7.5);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        } else {
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
  }, [durationMs, currentTimeMs, keyframes, cuts, segments, zoom, clampedViewStartMs, viewEndMs, visibleDurationMs, selectedCutMs, cutDragState]);

  // 自适应 Canvas 大小
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      setTrackWidth(rect.width);
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

    if (e.button !== 0) return; // 左键才触发

    const canvas = canvasRef.current;
    if (!canvas || durationMs <= 0) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;

    // 检查是否点击在某个切点旗标附近 (±8px 热区)
    let hitCutIdx = -1;
    for (let i = 0; i < cuts.length; i++) {
      const cx = ((cuts[i] - clampedViewStartMs) / visibleDurationMs) * rect.width;
      if (Math.abs(cx - clickX) <= 8) {
        hitCutIdx = i;
        break;
      }
    }

    if (hitCutIdx !== -1) {
      // 记录起始点
      dragStartRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        timeMs: cuts[hitCutIdx],
        cutIndex: hitCutIdx,
      };

      // 启动 300ms 长按检测定时器
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(() => {
        const initialAnchorX = ((cuts[hitCutIdx] - clampedViewStartMs) / visibleDurationMs) * rect.width;
        setCutDragState({
          isDragging: true,
          cutIndex: hitCutIdx,
          originalTimeMs: cuts[hitCutIdx],
          currentTimeMs: cuts[hitCutIdx],
          isSnapped: false,
          isHitBarrier: false,
          anchorX: initialAnchorX,
        });
        longPressTimerRef.current = null;
      }, 300);

      return;
    }

    // 点击未命中切点：关闭可能打开的输入气泡，走常规 Seek
    setPopoverState((p) => (p.visible ? { ...p, visible: false } : p));
    setSelectedCutMs(null);
    const targetMs = getTimeFromMouseEvent(e);
    isDraggingRef.current = true;
    onSeek(targetMs);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // 1. 中键平移视窗
    if (isPanningRef.current && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const deltaPx = e.clientX - panStartXRef.current;
      const deltaMs = (deltaPx / rect.width) * visibleDurationMs;
      const nextStart = Math.max(0, Math.min(maxViewStartMs, panStartViewMsRef.current - deltaMs));
      setViewStartMs(nextStart);
      return;
    }

    // 2. 长按判定中检查位移：若 300ms 内位移超过 5px，判定为普通滑动，取消长按切点
    if (longPressTimerRef.current && dragStartRef.current) {
      const dist = Math.hypot(e.clientX - dragStartRef.current.startX, e.clientY - dragStartRef.current.startY);
      if (dist > 5) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
        dragStartRef.current = null; // 及时重置，避免 mouseup 误判为短按切点
        // 转为常规时间轴游标 Seek
        isDraggingRef.current = true;
        const targetMs = getTimeFromMouseEvent(e);
        onSeek(targetMs);
        return;
      }
    }

    // 3. 正在长按拖拽切点
    if (cutDragStateRef.current.isDragging && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const rawMs = getTimeFromMouseEvent(e);
      const cutIdx = cutDragStateRef.current.cutIndex;

      // 碰撞防护屏障：前后边界至少保持 200ms
      const prevBound = cutIdx === 0 ? 0 : cuts[cutIdx - 1];
      const nextBound = cutIdx === cuts.length - 1 ? durationMs : cuts[cutIdx + 1];
      const minAllowed = prevBound + 200;
      const maxAllowed = nextBound - 200;

      let clampedMs = rawMs;
      let hitBarrier = false;
      if (clampedMs <= minAllowed) {
        clampedMs = minAllowed;
        hitBarrier = true;
      } else if (clampedMs >= maxAllowed) {
        clampedMs = maxAllowed;
        hitBarrier = true;
      }

      // 关键帧向近磁吸（在屏幕像素空间 ±8px 检测）
      let snapped = false;
      const currentPx = ((clampedMs - clampedViewStartMs) / visibleDurationMs) * rect.width;
      let closestKf: number | null = null;
      let minDiffPx = 9;

      for (const kf of keyframes) {
        if (kf >= minAllowed && kf <= maxAllowed) {
          const kfPx = ((kf - clampedViewStartMs) / visibleDurationMs) * rect.width;
          const diff = Math.abs(kfPx - currentPx);
          if (diff <= 8 && diff < minDiffPx) {
            minDiffPx = diff;
            closestKf = kf;
          }
        }
      }

      if (closestKf !== null) {
        clampedMs = closestKf;
        snapped = true;
        hitBarrier = false;
      }

      const anchorX = ((clampedMs - clampedViewStartMs) / visibleDurationMs) * rect.width;

      setCutDragState((prev) => ({
        ...prev,
        currentTimeMs: clampedMs,
        isSnapped: snapped,
        isHitBarrier: hitBarrier,
        anchorX,
      }));
      return;
    }

    // 4. 普通时间轴拖拽游标 Seek
    if (isDraggingRef.current) {
      const targetMs = getTimeFromMouseEvent(e);
      onSeek(targetMs);
    }
  };

  const handleMouseUp = () => {
    // 1. 清除长按计时器
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    // 2. 如果正处于切点拖拽状态，提交移动
    if (cutDragStateRef.current.isDragging) {
      const { cutIndex, currentTimeMs, originalTimeMs } = cutDragStateRef.current;
      if (currentTimeMs !== originalTimeMs && onMoveCut) {
        onMoveCut(cutIndex, currentTimeMs);
        setSelectedCutMs(currentTimeMs);
      }
      setCutDragState({
        isDragging: false,
        cutIndex: -1,
        originalTimeMs: 0,
        currentTimeMs: 0,
        isSnapped: false,
        isHitBarrier: false,
        anchorX: 0,
      });
      dragStartRef.current = null;
      return;
    }

    // 3. 如果在切点上短按松开（< 300ms 且无位移）
    if (dragStartRef.current && canvasRef.current) {
      const { cutIndex, timeMs } = dragStartRef.current;
      const now = Date.now();
      const last = lastCutClickRef.current;
      const rect = canvasRef.current.getBoundingClientRect();

      if (last && last.cutIndex === cutIndex && now - last.time < 300) {
        // 快速双击：弹出就地时间码编辑输入气泡
        const anchorX = ((timeMs - clampedViewStartMs) / visibleDurationMs) * rect.width;
        setPopoverState({
          visible: true,
          cutIndex,
          cutMs: timeMs,
          anchorX,
          inputValue: formatTimecode(timeMs, true),
          errorMsg: undefined,
        });
        lastCutClickRef.current = null;
      } else {
        // 普通单击：选中切点并寻址
        setSelectedCutMs(timeMs);
        onSeek(timeMs);
        lastCutClickRef.current = { cutIndex, time: now };
      }
      dragStartRef.current = null;
    }

    isDraggingRef.current = false;
    isPanningRef.current = false;
  };

  // 就地时间码输入气泡提交
  const handlePopoverSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!popoverState.visible || popoverState.cutIndex < 0) return;

    const parsed = parseTimecodeToMs(popoverState.inputValue);
    if (parsed === null) {
      setPopoverState((p) => ({ ...p, errorMsg: '时间格式无效，请输入 HH:MM:SS.mmm 或纯秒数' }));
      return;
    }

    const cutIdx = popoverState.cutIndex;
    const prevBound = cutIdx === 0 ? 0 : cuts[cutIdx - 1];
    const nextBound = cutIdx === cuts.length - 1 ? durationMs : cuts[cutIdx + 1];

    if (parsed < prevBound + 200 || parsed > nextBound - 200) {
      setPopoverState((p) => ({
        ...p,
        errorMsg: `时间必须在 ${formatTimecode(prevBound + 200)} 与 ${formatTimecode(nextBound - 200)} 之间 (至少 200ms 安全间距)`,
      }));
      return;
    }

    if (onMoveCut) {
      const success = onMoveCut(cutIdx, parsed);
      if (success) {
        setSelectedCutMs(parsed);
        onSeek(parsed);
        setPopoverState((p) => ({ ...p, visible: false }));
      } else {
        setPopoverState((p) => ({ ...p, errorMsg: '移动切点失败，请检查边界限制' }));
      }
    } else {
      setPopoverState((p) => ({ ...p, visible: false }));
    }
  };

  // 底部蓝线微型滚动条拖拽与点击跳转逻辑
  const scrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const isThumbDraggingRef = useRef(false);
  const thumbDragStartXRef = useRef(0);
  const thumbDragStartViewMsRef = useRef(0);

  const handleThumbMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isThumbDraggingRef.current = true;
    thumbDragStartXRef.current = e.clientX;
    thumbDragStartViewMsRef.current = clampedViewStartMs;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isThumbDraggingRef.current || !scrollbarTrackRef.current) return;
      const trackRect = scrollbarTrackRef.current.getBoundingClientRect();
      const deltaPx = moveEvent.clientX - thumbDragStartXRef.current;
      const deltaMs = (deltaPx / trackRect.width) * durationMs;
      const nextStart = Math.max(0, Math.min(maxViewStartMs, thumbDragStartViewMsRef.current + deltaMs));
      setViewStartMs(nextStart);
    };

    const onMouseUp = () => {
      isThumbDraggingRef.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isThumbDraggingRef.current || !scrollbarTrackRef.current) return;
    const trackRect = scrollbarTrackRef.current.getBoundingClientRect();
    const clickX = e.clientX - trackRect.left;
    const clickRatio = Math.max(0, Math.min(1, clickX / trackRect.width));
    const targetCenterMs = clickRatio * durationMs;
    const nextStart = Math.max(0, Math.min(maxViewStartMs, targetCenterMs - visibleDurationMs / 2));
    setViewStartMs(nextStart);
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

      {/* ── Canvas 时间轴主轨道与悬浮小窗外层包装 ── */}
      <div ref={trackWrapperRef} className="relative w-full">
        <div
          className={`relative w-full h-[46px] rounded-xl overflow-hidden border border-white/10 select-none transition-colors ${
            cutDragState.isDragging ? 'cursor-grabbing' : 'cursor-crosshair'
          }`}
        >
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

          {/* 缩放状态下底部微型视窗位置可拖拽滚动条 */}
          {zoom > 1 && (
            <div
              ref={scrollbarTrackRef}
              onClick={handleTrackClick}
              className="absolute bottom-0 left-0 right-0 h-2 bg-black/60 hover:bg-black/80 transition-colors z-20 cursor-pointer select-none"
              title="点击或拖拽平移视窗"
            >
              <div
                onMouseDown={handleThumbMouseDown}
                className="h-full bg-blue-500 hover:bg-blue-400 active:bg-blue-300 rounded-full cursor-grab active:cursor-grabbing shadow-sm transition-[background-color]"
                style={{
                  marginLeft: `${Math.min(99, Math.max(0, (clampedViewStartMs / durationMs) * 100))}%`,
                  width: `${Math.min(100, Math.max(1, (visibleDurationMs / durationMs) * 100))}%`,
                }}
              />
            </div>
          )}
        </div>

        {/* 悬浮微型画格小窗预览 (Scrub Thumbnail Preview) */}
        <TimelineThumbnailPreview
          videoPath={videoPath}
          targetMs={cutDragState.currentTimeMs}
          anchorX={cutDragState.anchorX}
          containerWidth={trackWidth}
          visible={cutDragState.isDragging}
          isSnapped={cutDragState.isSnapped}
          isHitBarrier={cutDragState.isHitBarrier}
        />

        {/* 双击切点弹出的就地时间码编辑气泡 (In-place Popover) */}
        {popoverState.visible && (
          <div
            className="absolute bottom-full mb-3 z-50 bg-[#0c0e14]/95 border border-blue-500/50 rounded-xl p-2.5 shadow-2xl backdrop-blur-md flex flex-col gap-2 min-w-[220px] animate-in fade-in zoom-in-95"
            style={{
              left: `${Math.max(8, Math.min(trackWidth - 230, popoverState.anchorX - 110))}px`,
            }}
          >
            <div className="flex items-center justify-between text-xs text-zinc-300 font-medium">
              <span className="flex items-center gap-1">
                <Scissors className="w-3 h-3 text-blue-400" />
                <span>切点 #{popoverState.cutIndex + 1} 时间</span>
              </span>
              <button
                type="button"
                onClick={() => setPopoverState((p) => ({ ...p, visible: false }))}
                className="text-zinc-500 hover:text-white text-xs px-1"
                title="关闭 (Esc)"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handlePopoverSubmit} className="flex flex-col gap-1.5">
              <input
                ref={popoverInputRef}
                type="text"
                value={popoverState.inputValue}
                onChange={(e) =>
                  setPopoverState((p) => ({ ...p, inputValue: e.target.value, errorMsg: undefined }))
                }
                placeholder="00:00:00.000 或秒数"
                className="w-full bg-black/70 border border-white/20 rounded-lg px-2.5 py-1 font-mono text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
              />
              {popoverState.errorMsg && (
                <div className="text-[10px] text-rose-400 leading-tight">
                  {popoverState.errorMsg}
                </div>
              )}
              <div className="flex items-center justify-end gap-1.5 text-[11px] mt-0.5">
                <button
                  type="button"
                  onClick={() => setPopoverState((p) => ({ ...p, visible: false }))}
                  className="px-2 py-0.5 rounded text-zinc-400 hover:text-white transition-colors"
                >
                  取消 (Esc)
                </button>
                <button
                  type="submit"
                  className="px-2.5 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium shadow-sm transition-colors active:scale-95"
                >
                  确定 (Enter)
                </button>
              </div>
            </form>

            {/* 指向切点的小三角箭头 */}
            <div
              className="w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-[#0c0e14] absolute top-full"
              style={{
                left: `${Math.max(12, Math.min(208, popoverState.anchorX - Math.max(8, Math.min(trackWidth - 230, popoverState.anchorX - 110))))}px`,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};
