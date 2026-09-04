import { Segment, MediaRetentionPlan, PlanSegment } from './types';

/**
 * 关键帧保全规划器纯函数 (RetentionPlanner)
 * 严格执行“绝不多删一帧正片”原则（Floor to Keyframe）
 */
export function planRetention(
  sourcePath: string,
  totalDurationMs: number,
  segments: Segment[],
  keyframes: number[],
  outputPath: string,
  concatToSingleFile: boolean = true,
  stripOriginalCover: boolean = true
): MediaRetentionPlan {
  const sortedKeyframes = [...keyframes].sort((a, b) => a - b);
  // 确保关键帧列表中至少包含 0
  if (sortedKeyframes.length === 0 || sortedKeyframes[0] > 0) {
    sortedKeyframes.unshift(0);
  }

  const keptSegments = segments.filter(s => s.decision === 'keep');
  const planSegments: PlanSegment[] = [];

  for (const seg of keptSegments) {
    // 1. 向左吸附关键帧：查找满足 K_i <= startMs 的最大关键帧
    let safeStart = 0;
    for (let i = sortedKeyframes.length - 1; i >= 0; i--) {
      if (sortedKeyframes[i] <= seg.startMs) {
        safeStart = sortedKeyframes[i];
        break;
      }
    }

    // 2. 终点保全：不能少于用户指定的 endMs，且不超过总时长
    const safeEnd = Math.min(totalDurationMs, seg.endMs);

    planSegments.push({
      segmentId: seg.id,
      userRange: { startMs: seg.startMs, endMs: seg.endMs },
      safeRange: { startMs: safeStart, endMs: safeEnd },
      sourceKeyframeMs: safeStart,
    });
  }

  // 3. 相邻重叠自动融合 (Overlap Consolidation)
  // 仅在合并单文件模式 (concatToSingleFile === true) 下，相邻且重叠的正片才进行融合以减少拼接开销；
  // 当不合并 (concatToSingleFile === false) 时，用户要求将各个保留片段独立导出为视频，必须保持各段独立性！
  let effectiveSegments: PlanSegment[] = planSegments;

  if (concatToSingleFile) {
    const mergedSegments: PlanSegment[] = [];
    for (const seg of planSegments) {
      if (mergedSegments.length === 0) {
        mergedSegments.push({ ...seg });
      } else {
        const prev = mergedSegments[mergedSegments.length - 1];
        // 如果当前段的安全起点小于等于前一段的安全终点，说明产生重叠，执行合并
        if (seg.safeRange.startMs <= prev.safeRange.endMs) {
          prev.safeRange.endMs = Math.max(prev.safeRange.endMs, seg.safeRange.endMs);
          prev.userRange.endMs = Math.max(prev.userRange.endMs, seg.userRange.endMs);
        } else {
          mergedSegments.push({ ...seg });
        }
      }
    }
    effectiveSegments = mergedSegments;
  }

  const totalKeptDurationMs = effectiveSegments.reduce(
    (acc, s) => acc + (s.safeRange.endMs - s.safeRange.startMs),
    0
  );

  const blockers: string[] = [];
  if (effectiveSegments.length === 0) {
    blockers.push('未选择任何保留片段，无法生成剪辑方案');
  }

  return {
    version: '1.0',
    sourcePath,
    durationMs: totalDurationMs,
    concatToSingleFile,
    stripOriginalCover,
    outputPath,
    planSegments: effectiveSegments,
    totalKeptDurationMs,
    blockers,
  };
}
