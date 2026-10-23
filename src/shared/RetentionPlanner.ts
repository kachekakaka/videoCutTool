import { Segment, MediaRetentionPlan, PlanSegment, KeyframePoint, OutputMode, SegmentOutputGroups, OutputGroup, ExportPrecision } from './types';
import { compareTime, millisecondsTime } from './mediaTime';

/** 同一份逻辑清单用于页面、保存摘要及实际执行，编号按最早成员排序。 */
export function resolveOutputGroups(segments: Segment[], mode: OutputMode, membership: SegmentOutputGroups): OutputGroup[] {
  const kept = segments.filter(segment => segment.decision === 'keep').sort((a, b) => a.startMs - b.startMs);
  if (mode === 'single') return kept.length ? [{ segmentIds: kept.map(segment => segment.id) }] : [];
  const groups = new Map<string, OutputGroup>();
  for (const segment of kept) {
    const key = mode === 'custom' && membership[segment.id] ? `group:${membership[segment.id]}` : `segment:${segment.id}`;
    if (!groups.has(key)) groups.set(key, { segmentIds: [] });
    groups.get(key)!.segmentIds.push(segment.id);
  }
  return [...groups.values()];
}

export function validateOutputGroups(segments: Segment[], mode: OutputMode, membership: SegmentOutputGroups): void {
  if (!['separate', 'single', 'custom'].includes(mode) || !membership || typeof membership !== 'object' || Array.isArray(membership)) throw new Error('裁剪方案输出配置无效，请重新建立方案');
  const entries = Object.entries(membership);
  if (entries.length > segments.length || (mode !== 'custom' && entries.length)) throw new Error('输出方式与自定义组合不一致');
  const kept = new Set(segments.filter(segment => segment.decision === 'keep').map(segment => segment.id));
  const counts = new Map<string, number>();
  for (const [id, group] of entries) {
    if (!kept.has(id) || typeof group !== 'string' || !/^[\w-]{1,80}$/.test(group)) throw new Error('输出组合包含无效或丢弃的片段');
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  if ([...counts.values()].some(count => count < 2)) throw new Error('输出组合至少需要两个保留片段');
}

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
  outputMode: OutputMode = 'single',
  stripOriginalCover: boolean = true,
  keyframePoints?: KeyframePoint[],
  membership: SegmentOutputGroups = {},
  exportPrecision: ExportPrecision = 'keyframe'
): MediaRetentionPlan {
  validateOutputGroups(segments, outputMode, membership);
  if (!['keyframe', 'frame'].includes(exportPrecision)) throw new Error('导出精度无效');
  const sortedKeyframes = [...keyframes].sort((a, b) => a - b);
  // 确保关键帧列表中至少包含 0
  if (sortedKeyframes.length === 0 || sortedKeyframes[0] > 0) {
    sortedKeyframes.unshift(0);
  }

  const keptSegments = segments.filter(s => s.decision === 'keep');
  const planSegments: PlanSegment[] = [];

  for (const seg of keptSegments) {
    if (exportPrecision === 'frame') {
      planSegments.push({ segmentId: seg.id, userRange: { startMs: seg.startMs, endMs: seg.endMs }, safeRange: { startMs: seg.startMs, endMs: seg.endMs }, sourceKeyframeMs: seg.startMs });
      continue;
    }
    // 1. 向左吸附关键帧：查找满足 K_i <= startMs 的最大关键帧
    let safeStart = 0;
    for (let i = sortedKeyframes.length - 1; i >= 0; i--) {
      if (sortedKeyframes[i] <= seg.startMs) {
        safeStart = sortedKeyframes[i];
        break;
      }
    }

    const exact = keyframePoints && [...keyframePoints].reverse().find(point => compareTime(point.time, millisecondsTime(seg.startMs)) <= 0);
    if (keyframePoints?.length && !exact && seg.startMs > 0) throw new Error('保留区间之前没有可用关键帧，无法保证无损裁剪起点');
    if (exact) safeStart = Math.max(0, exact.timeMs);

    // 2. 终点保全：不能少于用户指定的 endMs，且不超过总时长
    const safeEnd = Math.min(totalDurationMs, seg.endMs);

    planSegments.push({
      segmentId: seg.id,
      userRange: { startMs: seg.startMs, endMs: seg.endMs },
      safeRange: { startMs: safeStart, endMs: safeEnd },
      sourceKeyframeMs: safeStart,
      ...(exact ? { seekTime: exact.time } : {}),
    });
  }

  const outputs = resolveOutputGroups(segments, outputMode, membership).map(group => {
    const members = group.segmentIds.map(id => planSegments.find(segment => segment.segmentId === id)!);
    // 安全区间只在同一个输出文件内融合，空间配置仍保留每个逻辑成员。
    const mergedSegments: PlanSegment[] = [];
    for (const seg of members) {
      if (mergedSegments.length === 0) {
        mergedSegments.push(structuredClone(seg));
      } else {
        const prev = mergedSegments[mergedSegments.length - 1];
        // 如果当前段的安全起点小于等于前一段的安全终点，说明产生重叠，执行合并
        if (seg.safeRange.startMs <= prev.safeRange.endMs) {
          prev.safeRange.endMs = Math.max(prev.safeRange.endMs, seg.safeRange.endMs);
          prev.userRange.endMs = Math.max(prev.userRange.endMs, seg.userRange.endMs);
        } else {
          mergedSegments.push(structuredClone(seg));
        }
      }
    }
    return { ...group, planSegments: mergedSegments, spatialSegments: members };
  });

  const totalKeptDurationMs = outputs.flatMap(output => output.planSegments).reduce(
    (acc, s) => acc + (s.safeRange.endMs - s.safeRange.startMs),
    0
  );

  const blockers: string[] = [];
  if (outputs.length === 0) {
    blockers.push('未选择任何保留片段，无法生成剪辑方案');
  }

  return {
    version: '1.0',
    exportPrecision,
    sourcePath,
    durationMs: totalDurationMs,
    stripOriginalCover,
    outputPath,
    outputs,
    totalKeptDurationMs,
    blockers,
  };
}
