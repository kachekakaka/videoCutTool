import React, { useRef, useEffect, useState } from 'react';
import { Segment, RetentionDecision } from '../../shared/types';
import { Play, ArrowRight, Clock, Trash2 } from 'lucide-react';

interface SegmentCardsGridProps {
  segments: Segment[];
  currentTimeMs?: number;
  auditionRange?: { startMs: number; endMs: number } | null;
  stepMs?: number;
  onStepMsChange?: (step: number) => void;
  onToggleDecision: (segmentId: string, decision: RetentionDecision) => void;
  onAudition: (startMs: number, endMs: number) => void;
  onNudgeStart: (segmentId: string, deltaMs: number) => void;
  onNudgeEnd: (segmentId: string, deltaMs: number) => void;
  onMergeWithPrevious?: (segmentId: string) => void;
  onSeek?: (timeMs: number) => void;
}

const STEP_OPTIONS = [100, 1000, 5000, 10000]; // 0.1s, 1s, 5s, 10s

const formatStepLabel = (ms: number): string => {
  if (ms < 1000) return `${ms / 1000}s`;
  return `${ms / 1000}s`;
};

// 交互式时分秒毫秒微调组件
interface TimecodeWheelProps {
  ms: number;
  stepMs: number;
  stepLabel: string;
  onNudge: (deltaMs: number) => void;
}

const TimecodeWheel: React.FC<TimecodeWheelProps> = ({ ms, stepMs, stepLabel, onNudge }) => {
  const safeMs = Math.max(0, isNaN(ms) ? 0 : ms);
  const totalSeconds = Math.floor(safeMs / 1000);
  const milliseconds = Math.floor(safeMs % 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number, z = 2) => ('00' + n).slice(-z);
  const padMs = ('000' + milliseconds).slice(-3);

  const handleWheelOnUnit = (e: React.WheelEvent, unitDelta: number) => {
    e.preventDefault();
    e.stopPropagation();
    // 滚轮向上增加，向下减少
    const delta = e.deltaY < 0 ? unitDelta : -unitDelta;
    onNudge(delta);
  };

  return (
    <span className="inline-flex items-center select-none font-mono text-[10px] text-[#f0f6fc]">
      {/* 小时 */}
      <span
        onWheel={(e) => handleWheelOnUnit(e, 3600000)}
        className="hover:bg-blue-500/30 hover:text-blue-200 rounded px-0.5 cursor-ns-resize transition-colors"
        title="鼠标滚轮微调小时 (±1h)"
      >
        {pad(hours)}
      </span>
      <span className="text-zinc-500">:</span>
      {/* 分钟 */}
      <span
        onWheel={(e) => handleWheelOnUnit(e, 60000)}
        className="hover:bg-blue-500/30 hover:text-blue-200 rounded px-0.5 cursor-ns-resize transition-colors"
        title="鼠标滚轮微调分钟 (±1m)"
      >
        {pad(minutes)}
      </span>
      <span className="text-zinc-500">:</span>
      {/* 秒 */}
      <span
        onWheel={(e) => handleWheelOnUnit(e, 1000)}
        className="hover:bg-blue-500/30 hover:text-blue-200 font-semibold text-white rounded px-0.5 cursor-ns-resize transition-colors"
        title="鼠标滚轮微调秒 (±1s)"
      >
        {pad(seconds)}
      </span>
      <span className="text-zinc-500">.</span>
      {/* 毫秒 */}
      <span
        onWheel={(e) => handleWheelOnUnit(e, stepMs)}
        className="text-zinc-400 hover:bg-blue-500/30 hover:text-blue-200 rounded px-0.5 cursor-ns-resize transition-colors"
        title={`鼠标滚轮微调毫秒 (±${stepLabel})`}
      >
        {padMs}
      </span>
    </span>
  );
};

export const SegmentCardsGrid: React.FC<SegmentCardsGridProps> = ({
  segments,
  currentTimeMs,
  auditionRange,
  stepMs: controlledStepMs,
  onStepMsChange,
  onToggleDecision,
  onAudition,
  onNudgeStart,
  onNudgeEnd,
  onMergeWithPrevious,
  onSeek,
}) => {
  // 步长状态：支持受控与非受控
  const [internalStepMs, setInternalStepMs] = useState(100);
  const activeStepMs = controlledStepMs ?? internalStepMs;

  const handleCycleStep = (e: React.MouseEvent) => {
    e.stopPropagation();
    const curIdx = STEP_OPTIONS.indexOf(activeStepMs);
    const nextIdx = (curIdx + 1) % STEP_OPTIONS.length;
    const nextStep = STEP_OPTIONS[nextIdx];
    if (onStepMsChange) {
      onStepMsChange(nextStep);
    } else {
      setInternalStepMs(nextStep);
    }
  };

  const stepLabel = formatStepLabel(activeStepMs);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 items-stretch">
      {segments.map((seg, idx) => {
        const isKept = seg.decision === 'keep';
        const durationSec = (seg.durationMs / 1000).toFixed(1);
        const canMerge = idx > 0 && onMergeWithPrevious;

        // 判定试听状态
        const isAuditioning = Boolean(
          auditionRange &&
          Math.abs(seg.startMs - auditionRange.startMs) < 100 &&
          Math.abs(seg.endMs - auditionRange.endMs) < 100
        );

        // 判定当前播放指针所在分段（末尾段特殊包含尾帧）
        const isLast = idx === segments.length - 1;
        const isPlayheadActive =
          currentTimeMs !== undefined &&
          currentTimeMs >= seg.startMs &&
          (isLast ? currentTimeMs <= seg.endMs : currentTimeMs < seg.endMs);

        // 自动聚焦引用
        const cardRef = useRef<HTMLDivElement | null>(null);
        useEffect(() => {
          if (isPlayheadActive && cardRef.current) {
            cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
          }
        }, [isPlayheadActive]);

        return (
          <div
            key={seg.id}
            ref={cardRef}
            className={`flex flex-col justify-between rounded-xl px-2.5 py-1.5 border transition-all shadow-md relative group h-[74px] select-none ${
              isAuditioning
                ? 'bg-[#12281e]/95 border-emerald-400 ring-2 ring-emerald-400/70 shadow-[0_0_15px_rgba(52,211,153,0.35)] animate-pulse'
                : isPlayheadActive
                ? 'bg-[#142334]/95 border-blue-500/80 ring-2 ring-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.3)]'
                : isKept
                ? 'bg-[#161b22]/90 border-emerald-500/30 hover:border-emerald-500/50 shadow-emerald-950/20'
                : 'bg-[#161b22]/50 border-rose-500/20 hover:border-rose-500/40 opacity-80 shadow-rose-950/10'
            }`}
          >
            {/* 左侧状态发光指示条 */}
            <div
              className={`absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r ${
                isAuditioning
                  ? 'bg-emerald-400 shadow-[0_0_12px_#34d399]'
                  : isPlayheadActive
                  ? 'bg-blue-400 shadow-[0_0_10px_#60a5fa]'
                  : isKept
                  ? 'bg-emerald-500 shadow-[0_0_8px_#2ea043]'
                  : 'bg-rose-500'
              }`}
            />

            {/* ── 行 1：状态决策与试听/合并操作 (高度 24px) ── */}
            <div className="flex items-center justify-between pl-1 shrink-0 h-6">
              {/* 左：序号 + 保留/丢弃切换小胶囊 */}
              <div className="flex items-center gap-1.5 shrink-0">
                <span
                  onClick={() => onSeek && onSeek(seg.startMs)}
                  className={`font-mono font-bold text-[11px] px-1.5 py-0.2 rounded cursor-pointer transition-colors ${
                    isPlayheadActive
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-zinc-200 bg-white/10 hover:bg-white/20'
                  }`}
                  title="点击跳转至此段起点"
                >
                  #{seg.index}
                </span>

                <div className="flex items-center bg-black/60 p-0.5 rounded-md border border-white/10 text-[10px]">
                  <button
                    onClick={() => onToggleDecision(seg.id, 'keep')}
                    className={`px-1.5 py-0.2 rounded transition-all font-semibold active:scale-95 ${
                      isKept
                        ? 'bg-emerald-600 text-white shadow-sm'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                    title="设为此段保留"
                  >
                    保留
                  </button>
                  <button
                    onClick={() => onToggleDecision(seg.id, 'discard')}
                    className={`px-1.5 py-0.2 rounded transition-all font-semibold active:scale-95 ${
                      !isKept
                        ? 'bg-rose-600 text-white shadow-sm'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                    title="设为此段丢弃"
                  >
                    丢弃
                  </button>
                </div>
              </div>

              {/* 右：时长 + 合并 + 试听 */}
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-[10px] text-zinc-400 font-mono flex items-center gap-0.5 bg-black/40 px-1.5 py-0.5 rounded border border-white/5 whitespace-nowrap">
                  <Clock className="w-2.5 h-2.5 text-zinc-400" />
                  <span>{durationSec}s</span>
                </span>

                {canMerge && (
                  <button
                    onClick={() => onMergeWithPrevious(seg.id)}
                    className="p-1 rounded text-amber-400/80 hover:text-amber-300 hover:bg-amber-500/15 transition-all text-[10px] flex items-center active:scale-95"
                    title="删除前切点，将此段合并至上一段"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}

                <button
                  onClick={() => onAudition(seg.startMs, seg.endMs)}
                  className={`px-1.5 py-0.5 rounded transition-all text-[11px] flex items-center gap-1 active:scale-95 border ${
                    isAuditioning
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40 shadow-sm font-bold'
                      : 'bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white border-white/5'
                  }`}
                  title={isAuditioning ? '正在试听该片段' : '试听该片段'}
                >
                  {isAuditioning ? (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                      <span className="text-emerald-300 font-semibold">试听中</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-2.5 h-2.5 fill-current text-blue-400" />
                      <span>试听</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* ── 行 2：时间码（支持滚轮悬停微调）与步长微调按钮 ── */}
            <div className="flex items-center justify-between pl-1 shrink-0 h-6">
              {/* 左：纯白等宽时间码 (HH:MM:SS.mmm，悬停时分秒滚动加减) */}
              <div className="flex items-center gap-1 font-mono text-[10px] whitespace-nowrap bg-black/50 px-1.5 py-0.5 rounded border border-white/5">
                <TimecodeWheel
                  ms={seg.startMs}
                  stepMs={activeStepMs}
                  stepLabel={stepLabel}
                  onNudge={(delta) => onNudgeStart(seg.id, delta)}
                />
                <ArrowRight className="w-2.5 h-2.5 text-zinc-500 shrink-0" />
                <TimecodeWheel
                  ms={seg.endMs}
                  stepMs={activeStepMs}
                  stepLabel={stepLabel}
                  onNudge={(delta) => onNudgeEnd(seg.id, delta)}
                />
              </div>

              {/* 右：步长切换胶囊与微调按钮 */}
              <div className="flex items-center gap-1 shrink-0 font-mono text-[10px]">
                {/* 步长切换胶囊 */}
                <button
                  onClick={handleCycleStep}
                  className="px-1 py-0.5 rounded bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 border border-blue-400/25 text-[9px] font-sans font-medium transition-all active:scale-95"
                  title={`点击切换微调步长 (当前: ${stepLabel}，支持 0.1s / 1s / 5s / 10s)`}
                >
                  {stepLabel}
                </button>

                <button
                  onClick={() => onNudgeStart(seg.id, -activeStepMs)}
                  className="px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white border border-white/5 transition-colors active:scale-95"
                  title={`左移入点 ${stepLabel}`}
                >
                  -{stepLabel}
                </button>
                <button
                  onClick={() => onNudgeEnd(seg.id, activeStepMs)}
                  className="px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white border border-white/5 transition-colors active:scale-95"
                  title={`右移出点 ${stepLabel}`}
                >
                  +{stepLabel}
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
