import React, { useRef, useEffect, useState } from 'react';
import { Segment, RetentionDecision } from '../../shared/types';
import { formatTimecode, parseTimecodeToMs } from './VideoPlayer';
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

const formatStepLabel = (ms: number): string => {
  return `${ms / 1000}s`;
};

// 交互式时分秒毫秒微调组件（支持直接点击敲字输入与鼠标滚轮微调，支持首末物理边界锁定）
interface TimecodeWheelProps {
  ms: number;
  stepMs: number;
  stepLabel: string;
  readOnly?: boolean;
  lockTooltip?: string;
  onNudge: (deltaMs: number) => void;
}

const TimecodeWheel: React.FC<TimecodeWheelProps> = ({
  ms,
  stepMs,
  stepLabel,
  readOnly = false,
  lockTooltip,
  onNudge,
}) => {
  const safeMs = Math.max(0, isNaN(ms) ? 0 : ms);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const totalSeconds = Math.floor(safeMs / 1000);
  const milliseconds = Math.floor(safeMs % 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number, z = 2) => ('00' + n).slice(-z);
  const padMs = ('000' + milliseconds).slice(-3);

  const handleWheelOnUnit = (e: React.WheelEvent, unitDelta: number) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    // 滚轮向上增加，向下减少
    const delta = e.deltaY < 0 ? unitDelta : -unitDelta;
    onNudge(delta);
  };

  const handleStartEdit = (e: React.MouseEvent) => {
    if (readOnly) return;
    e.stopPropagation();
    setEditValue(formatTimecode(safeMs, true));
    setIsEditing(true);
  };

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleCommit = () => {
    setIsEditing(false);
    const parsed = parseTimecodeToMs(editValue);
    if (parsed !== null && parsed !== safeMs) {
      const delta = parsed - safeMs;
      onNudge(delta);
    }
  };

  if (isEditing && !readOnly) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleCommit();
          } else if (e.key === 'Escape') {
            setIsEditing(false);
          }
        }}
        onBlur={handleCommit}
        className="w-[84px] h-[18px] bg-black/90 border border-blue-400 rounded px-1 font-mono text-[10px] text-white focus:outline-none focus:ring-1 focus:ring-blue-400"
      />
    );
  }

  return (
    <span
      onClick={handleStartEdit}
      className={`inline-flex items-center select-none font-mono text-[10px] rounded px-0.5 transition-colors ${
        readOnly
          ? 'text-zinc-500 cursor-not-allowed'
          : 'text-[#f0f6fc] cursor-pointer hover:bg-blue-500/10 group/tc'
      }`}
      title={
        readOnly
          ? lockTooltip || '视频全片物理边界 (不可微调)'
          : '单击直接打字输入时间码 (或悬停时分秒滚动滚轮微调)'
      }
    >
      {/* 小时 */}
      <span
        onWheel={(e) => handleWheelOnUnit(e, 3600000)}
        className={readOnly ? '' : 'hover:bg-blue-500/30 hover:text-blue-200 rounded px-0.5 cursor-ns-resize transition-colors'}
        title={readOnly ? undefined : '鼠标滚轮微调小时 (±1h)'}
      >
        {pad(hours)}
      </span>
      <span className="text-zinc-500">:</span>
      {/* 分钟 */}
      <span
        onWheel={(e) => handleWheelOnUnit(e, 60000)}
        className={readOnly ? '' : 'hover:bg-blue-500/30 hover:text-blue-200 rounded px-0.5 cursor-ns-resize transition-colors'}
        title={readOnly ? undefined : '鼠标滚轮微调分钟 (±1m)'}
      >
        {pad(minutes)}
      </span>
      <span className="text-zinc-500">:</span>
      {/* 秒 */}
      <span
        onWheel={(e) => handleWheelOnUnit(e, 1000)}
        className={readOnly ? '' : 'hover:bg-blue-500/30 hover:text-blue-200 font-semibold text-white rounded px-0.5 cursor-ns-resize transition-colors'}
        title={readOnly ? undefined : '鼠标滚轮微调秒 (±1s)'}
      >
        {pad(seconds)}
      </span>
      <span className="text-zinc-500">.</span>
      {/* 毫秒 */}
      <span
        onWheel={(e) => handleWheelOnUnit(e, stepMs)}
        className={readOnly ? '' : 'text-zinc-400 hover:bg-blue-500/30 hover:text-blue-200 rounded px-0.5 cursor-ns-resize transition-colors'}
        title={readOnly ? undefined : `鼠标滚轮微调毫秒 (±${stepLabel})`}
      >
        {padMs}
      </span>
    </span>
  );
};
// 单个分段卡片项组件（独立承载自身的生命周期与聚焦滚动 Hook，严格遵守 React 规范）
interface SegmentCardItemProps {
  seg: Segment;
  idx: number;
  totalSegments: number;
  nextSegmentId?: string;
  currentTimeMs?: number;
  auditionRange?: { startMs: number; endMs: number } | null;
  activeStepMs: number;
  stepLabel: string;
  onToggleDecision: (segmentId: string, decision: RetentionDecision) => void;
  onAudition: (startMs: number, endMs: number) => void;
  onNudgeStart: (segmentId: string, deltaMs: number) => void;
  onNudgeEnd: (segmentId: string, deltaMs: number) => void;
  onMergeWithPrevious?: (segmentId: string) => void;
  onSeek?: (timeMs: number) => void;
}

const SegmentCardItem: React.FC<SegmentCardItemProps> = ({
  seg,
  idx,
  totalSegments,
  nextSegmentId,
  currentTimeMs,
  auditionRange,
  activeStepMs,
  stepLabel,
  onToggleDecision,
  onAudition,
  onNudgeStart,
  onNudgeEnd,
  onMergeWithPrevious,
  onSeek,
}) => {
  const isKept = seg.decision === 'keep';
  const durationSec = (seg.durationMs / 1000).toFixed(1);
  const canDelete = totalSegments > 1 && Boolean(onMergeWithPrevious);

  const handleDelete = () => {
    if (!onMergeWithPrevious) return;
    if (idx === 0 && nextSegmentId) {
      // 第一段：删除其后置切点，将此段合并至下一段
      onMergeWithPrevious(nextSegmentId);
    } else {
      // 其他段：删除其前置切点，将此段合并至上一段
      onMergeWithPrevious(seg.id);
    }
  };

  // 判定试听状态
  const isAuditioning = Boolean(
    auditionRange &&
    Math.abs(seg.startMs - auditionRange.startMs) < 100 &&
    Math.abs(seg.endMs - auditionRange.endMs) < 100
  );

  // 判定当前播放指针所在分段（末尾段特殊包含尾帧）
  const isLast = idx === totalSegments - 1;
  const isPlayheadActive =
    currentTimeMs !== undefined &&
    currentTimeMs >= seg.startMs &&
    (isLast ? currentTimeMs <= seg.endMs : currentTimeMs < seg.endMs);

  // 自动聚焦引用 (位于子组件顶层，符合 React Hook 铁律)
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (isPlayheadActive && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [isPlayheadActive]);

  return (
    <div
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

        {/* 右：时长 + 删除合并 + 试听 */}
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[10px] text-zinc-400 font-mono flex items-center gap-0.5 bg-black/40 px-1.5 py-0.5 rounded border border-white/5 whitespace-nowrap">
            <Clock className="w-2.5 h-2.5 text-zinc-400" />
            <span>{durationSec}s</span>
          </span>

          {canDelete && (
            <button
              onClick={handleDelete}
              className="p-1 rounded text-amber-400/80 hover:text-amber-300 hover:bg-amber-500/15 transition-all text-[10px] flex items-center active:scale-95"
              title={idx === 0 ? '删除切点，将此段与下一段合并' : '删除切点，将此段与上一段合并'}
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

      {/* ── 行 2：时间码（支持滚轮悬停微调）与紧凑加减微调按钮 ── */}
      {(() => {
        const isStartLocked = idx === 0;
        const isEndLocked = idx === totalSegments - 1;

        return (
          <div className="flex items-center justify-between pl-1 shrink-0 h-6">
            {/* 左：纯白等宽时间码 (HH:MM:SS.mmm，悬停时分秒滚动加减) */}
            <div className="flex items-center gap-1 font-mono text-[10px] whitespace-nowrap bg-black/50 px-1.5 py-0.5 rounded border border-white/5">
              <TimecodeWheel
                ms={seg.startMs}
                stepMs={activeStepMs}
                stepLabel={stepLabel}
                readOnly={isStartLocked}
                lockTooltip="视频物理起点 00:00:00 (不可微调)"
                onNudge={(delta) => onNudgeStart(seg.id, delta)}
              />
              <ArrowRight className="w-2.5 h-2.5 text-zinc-500 shrink-0" />
              <TimecodeWheel
                ms={seg.endMs}
                stepMs={activeStepMs}
                stepLabel={stepLabel}
                readOnly={isEndLocked}
                lockTooltip="视频物理终点 (不可微调)"
                onNudge={(delta) => onNudgeEnd(seg.id, delta)}
              />
            </div>

            {/* 右：纯符号微调加减按钮 (无长文本，杜绝错位) */}
            <div className="flex items-center gap-1 shrink-0 font-mono text-xs">
              <button
                disabled={isStartLocked}
                onClick={() => onNudgeStart(seg.id, -activeStepMs)}
                className={`w-5 h-5 rounded flex items-center justify-center border border-white/10 transition-colors font-bold ${
                  isStartLocked
                    ? 'opacity-20 cursor-not-allowed bg-white/5 text-zinc-600'
                    : 'bg-white/5 hover:bg-white/15 text-zinc-300 hover:text-white active:scale-90'
                }`}
                title={isStartLocked ? '视频物理起点不可微调' : `左移入点 (步长 ${stepLabel})`}
              >
                -
              </button>
              <button
                disabled={isEndLocked}
                onClick={() => onNudgeEnd(seg.id, activeStepMs)}
                className={`w-5 h-5 rounded flex items-center justify-center border border-white/10 transition-colors font-bold ${
                  isEndLocked
                    ? 'opacity-20 cursor-not-allowed bg-white/5 text-zinc-600'
                    : 'bg-white/5 hover:bg-white/15 text-zinc-300 hover:text-white active:scale-90'
                }`}
                title={isEndLocked ? '视频物理终点不可微调' : `右移出点 (步长 ${stepLabel})`}
              >
                +
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export const SegmentCardsGrid: React.FC<SegmentCardsGridProps> = ({
  segments,
  currentTimeMs,
  auditionRange,
  stepMs = 100,
  onToggleDecision,
  onAudition,
  onNudgeStart,
  onNudgeEnd,
  onMergeWithPrevious,
  onSeek,
}) => {
  const activeStepMs = stepMs;
  const stepLabel = formatStepLabel(activeStepMs);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 items-stretch">
      {segments.map((seg, idx) => (
        <SegmentCardItem
          key={seg.id}
          seg={seg}
          idx={idx}
          totalSegments={segments.length}
          nextSegmentId={idx < segments.length - 1 ? segments[idx + 1].id : undefined}
          currentTimeMs={currentTimeMs}
          auditionRange={auditionRange}
          activeStepMs={activeStepMs}
          stepLabel={stepLabel}
          onToggleDecision={onToggleDecision}
          onAudition={onAudition}
          onNudgeStart={onNudgeStart}
          onNudgeEnd={onNudgeEnd}
          onMergeWithPrevious={onMergeWithPrevious}
          onSeek={onSeek}
        />
      ))}
    </div>
  );
};
