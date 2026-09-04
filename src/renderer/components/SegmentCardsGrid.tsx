import React from 'react';
import { Segment, RetentionDecision } from '../../shared/types';
import { Play, ArrowRight, Clock, Trash2 } from 'lucide-react';
import { formatTimecode } from './VideoPlayer';

interface SegmentCardsGridProps {
  segments: Segment[];
  auditionRange?: { startMs: number; endMs: number } | null;
  onToggleDecision: (segmentId: string, decision: RetentionDecision) => void;
  onAudition: (startMs: number, endMs: number) => void;
  onNudgeStart: (segmentId: string, deltaMs: number) => void;
  onNudgeEnd: (segmentId: string, deltaMs: number) => void;
  onMergeWithPrevious?: (segmentId: string) => void;
}

export const SegmentCardsGrid: React.FC<SegmentCardsGridProps> = ({
  segments,
  auditionRange,
  onToggleDecision,
  onAudition,
  onNudgeStart,
  onNudgeEnd,
  onMergeWithPrevious,
}) => {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 items-stretch">
      {segments.map((seg, idx) => {
        const isKept = seg.decision === 'keep';
        const durationSec = (seg.durationMs / 1000).toFixed(1);
        const canMerge = idx > 0 && onMergeWithPrevious;
        const isAuditioning = Boolean(
          auditionRange &&
          Math.abs(seg.startMs - auditionRange.startMs) < 100 &&
          Math.abs(seg.endMs - auditionRange.endMs) < 100
        );

        return (
          <div
            key={seg.id}
            className={`flex flex-col justify-between rounded-xl px-3 py-2 border transition-all shadow-md relative group h-[72px] select-none ${
              isAuditioning
                ? 'bg-[#12281e]/95 border-emerald-400 ring-2 ring-emerald-400/60 shadow-[0_0_15px_rgba(52,211,153,0.3)] animate-pulse'
                : isKept
                ? 'bg-[#161b22]/90 border-emerald-500/30 shadow-emerald-950/20'
                : 'bg-[#161b22]/50 border-rose-500/20 opacity-80 shadow-rose-950/10'
            }`}
          >
            {/* 左侧状态发光指示条 */}
            <div
              className={`absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r ${
                isAuditioning
                  ? 'bg-emerald-400 shadow-[0_0_12px_#34d399]'
                  : isKept
                  ? 'bg-emerald-500 shadow-[0_0_8px_#2ea043]'
                  : 'bg-rose-500'
              }`}
            />

            {/* ── 行 1：状态决策与试听/合并操作 (高度 24px) ── */}
            <div className="flex items-center justify-between pl-1 shrink-0 h-6">
              {/* 左：序号 + 保留/丢弃切换小胶囊 */}
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="font-mono font-bold text-[11px] text-zinc-200 bg-white/10 px-1.5 py-0.2 rounded">
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
                <span className="text-[11px] text-zinc-400 font-mono flex items-center gap-0.5 bg-black/40 px-1.5 py-0.5 rounded border border-white/5 whitespace-nowrap">
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
                      <span className="text-emerald-300">试听中</span>
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

            {/* ── 行 2：时间码与微调步进 (高度 24px，绝不换行) ── */}
            <div className="flex items-center justify-between pl-1 shrink-0 h-6">
              {/* 左：纯白等宽时间码 */}
              <div className="flex items-center gap-1 font-mono text-[11px] text-white whitespace-nowrap bg-black/40 px-2 py-0.5 rounded border border-white/5 select-all">
                <span className="font-semibold text-[#f0f6fc]">{formatTimecode(seg.startMs, false)}</span>
                <ArrowRight className="w-3 h-3 text-zinc-500 shrink-0" />
                <span className="font-semibold text-[#f0f6fc]">{formatTimecode(seg.endMs, false)}</span>
              </div>

              {/* 右：微调入点出点步进 */}
              <div className="flex items-center gap-1 shrink-0 font-mono text-[10px]">
                <button
                  onClick={() => onNudgeStart(seg.id, -100)}
                  className="px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white border border-white/5 transition-colors active:scale-95"
                  title="左移入点 0.1 秒"
                >
                  -0.1s
                </button>
                <button
                  onClick={() => onNudgeEnd(seg.id, 100)}
                  className="px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white border border-white/5 transition-colors active:scale-95"
                  title="右移出点 0.1 秒"
                >
                  +0.1s
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
