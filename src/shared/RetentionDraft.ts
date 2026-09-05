import { Segment, RetentionDecision, MediaRetentionPlan, PlanRecord } from './types';
import { planRetention } from './RetentionPlanner';

export interface DraftSnapshot {
  cuts: number[];
  decisions: Record<string, RetentionDecision>;
  concatSingleFile: boolean;
  stripOriginalCover: boolean;
}

/**
 * RetentionDraft 核心领域深模块
 * 封装切点插入防护、分段稳定生命周期、合并决策安全保全以及不可变物理切片计划生成
 */
export class RetentionDraft {
  public readonly mediaPath: string;
  public readonly totalDurationMs: number;
  private cuts: number[] = [];
  // 维护内部区间及其保留决策列表：每项代表一个物理连续区间
  private intervals: Array<{ startMs: number; endMs: number; decision: RetentionDecision }> = [];
  public concatSingleFile: boolean = true;
  public stripOriginalCover: boolean = true;

  constructor(mediaPath: string, totalDurationMs: number) {
    this.mediaPath = mediaPath;
    this.totalDurationMs = Math.max(0, totalDurationMs);
    // 初始状态：整个视频作为一个连续分段，默认保留
    this.intervals = [
      {
        startMs: 0,
        endMs: this.totalDurationMs,
        decision: 'keep',
      },
    ];
    this.rebuildCuts();
  }

  /**
   * 插入新切点
   * 严格执行安全防护：距视频首尾 >= 200ms，距已有切点 >= 200ms
   */
  public addCut(timeMs: number): boolean {
    const rounded = Math.round(timeMs);
    if (rounded < 200 || rounded > this.totalDurationMs - 200) {
      return false;
    }

    // 检查与已有切点的间距
    for (const cut of this.cuts) {
      if (Math.abs(cut - rounded) < 200) {
        return false;
      }
    }

    // 查找到被该切点切分的区间
    const targetIdx = this.intervals.findIndex(
      (it) => rounded > it.startMs && rounded < it.endMs
    );
    if (targetIdx === -1) {
      return false;
    }

    const target = this.intervals[targetIdx];
    const originalDecision = target.decision;

    // 拆分为前后两个子区间，继承原区间的保留决策
    const leftInterval = {
      startMs: target.startMs,
      endMs: rounded,
      decision: originalDecision,
    };
    const rightInterval = {
      startMs: rounded,
      endMs: target.endMs,
      decision: originalDecision,
    };

    this.intervals.splice(targetIdx, 1, leftInterval, rightInterval);
    this.rebuildCuts();
    return true;
  }

  /**
   * 删除指定切点
   * 关键不变量：合并相邻两段时，若任一段为 'keep'，则融合后的新段必然判定为 'keep'（安全优先，绝不多删一帧正片）
   */
  public removeCut(timeMs: number): boolean {
    const rounded = Math.round(timeMs);
    // 寻找最接近该时间戳的切点（容差 50ms）
    const cutIdx = this.cuts.findIndex((c) => Math.abs(c - rounded) < 50);
    if (cutIdx === -1) {
      return false;
    }

    return this.mergeAdjacentIntervals(cutIdx);
  }

  /**
   * 按分段 ID 将其与上一分段安全合并（段落级操作，消除外部字符串解析）
   */
  public mergeSegmentWithPrevious(segmentId: string): boolean {
    const idx = this.parseSegmentIndex(segmentId);
    if (idx <= 0 || idx >= this.intervals.length) {
      return false;
    }
    // 待移除的切点索引为 idx - 1
    return this.mergeAdjacentIntervals(idx - 1);
  }

  private mergeAdjacentIntervals(cutIdx: number): boolean {
    const left = this.intervals[cutIdx];
    const right = this.intervals[cutIdx + 1];

    if (!left || !right) {
      return false;
    }

    // 安全合并规则：只要有一段为 keep，整体判定为 keep
    const mergedDecision: RetentionDecision =
      left.decision === 'keep' || right.decision === 'keep' ? 'keep' : 'discard';

    const mergedInterval = {
      startMs: left.startMs,
      endMs: right.endMs,
      decision: mergedDecision,
    };

    this.intervals.splice(cutIdx, 2, mergedInterval);
    this.rebuildCuts();
    return true;
  }

  /**
   * 切换或设置指定分段的保留决策
   */
  public setDecision(segmentId: string, decision: RetentionDecision): boolean {
    const idx = this.parseSegmentIndex(segmentId);
    if (idx >= 0 && idx < this.intervals.length) {
      this.intervals[idx].decision = decision;
      return true;
    }
    return false;
  }

  /**
   * 微调指定分段的起点边界
   */
  public nudgeSegmentStart(segmentId: string, deltaMs: number): boolean {
    const idx = this.parseSegmentIndex(segmentId);
    if (idx <= 0 || idx >= this.intervals.length) return false;
    return this.nudgeBoundary(idx - 1, deltaMs);
  }

  /**
   * 微调指定分段的终点边界
   */
  public nudgeSegmentEnd(segmentId: string, deltaMs: number): boolean {
    const idx = this.parseSegmentIndex(segmentId);
    if (idx < 0 || idx >= this.cuts.length) return false;
    return this.nudgeBoundary(idx, deltaMs);
  }

  /**
   * 将指定切点直接移动至目标绝对时间戳（ms）
   * 严格执行碰撞防护屏障：必须与前后相邻切点及视频首尾保持至少 200ms 安全物理间距
   */
  public moveCut(cutIndex: number, newTimeMs: number): boolean {
    if (cutIndex < 0 || cutIndex >= this.cuts.length) return false;
    const rounded = Math.round(newTimeMs);

    const prevBound = cutIndex === 0 ? 0 : this.cuts[cutIndex - 1];
    const nextBound = cutIndex === this.cuts.length - 1 ? this.totalDurationMs : this.cuts[cutIndex + 1];

    // 严格碰撞屏障：与前后边界保持至少 200ms
    if (rounded < prevBound + 200 || rounded > nextBound - 200) {
      return false;
    }

    this.intervals[cutIndex].endMs = rounded;
    this.intervals[cutIndex + 1].startMs = rounded;
    this.rebuildCuts();
    return true;
  }

  /**
   * 微调切点边界（切点索引 cutIndex）
   */
  public nudgeBoundary(cutIndex: number, deltaMs: number): boolean {
    if (cutIndex < 0 || cutIndex >= this.cuts.length) return false;
    return this.moveCut(cutIndex, this.cuts[cutIndex] + deltaMs);
  }

  // 兼容别名
  public nudgeCut(cutIndex: number, deltaMs: number): boolean {
    return this.nudgeBoundary(cutIndex, deltaMs);
  }

  /**
   * 获取只读的切点数组
   */
  public getCuts(): ReadonlyArray<number> {
    return [...this.cuts];
  }

  /**
   * 获取当前所有分段列表（带有确定性的统一结构与 ID）
   */
  public getSegments(): Segment[] {
    return this.intervals.map((it, idx) => ({
      id: `seg_${idx}`,
      index: idx + 1,
      startMs: it.startMs,
      endMs: it.endMs,
      durationMs: it.endMs - it.startMs,
      decision: it.decision,
    }));
  }

  /**
   * 获取保留分段的总时长
   */
  public getKeptDurationMs(): number {
    return this.intervals
      .filter((it) => it.decision === 'keep')
      .reduce((acc, it) => acc + (it.endMs - it.startMs), 0);
  }

  /**
   * 获取丢弃分段的总时长
   */
  public getDiscardedDurationMs(): number {
    return this.intervals
      .filter((it) => it.decision === 'discard')
      .reduce((acc, it) => acc + (it.endMs - it.startMs), 0);
  }

  /**
   * 生成对齐关键帧的不可变物理切片计划 (MediaRetentionPlan)
   */
  public toPlan(
    keyframes: number[],
    options: {
      outputPath: string;
      concatSingleFile?: boolean;
      concatToSingleFile?: boolean;
      stripOriginalCover?: boolean;
      title?: string;
    }
  ): MediaRetentionPlan {
    const isConcat = options.concatSingleFile ?? options.concatToSingleFile ?? this.concatSingleFile;
    const stripCover = options.stripOriginalCover ?? this.stripOriginalCover;

    const plan = planRetention(
      this.mediaPath,
      this.totalDurationMs,
      this.getSegments(),
      keyframes,
      options.outputPath,
      isConcat,
      stripCover
    );
    if (options.title) {
      plan.title = options.title;
    }
    return plan;
  }

  /**
   * 序列化为持久化方案记录 (PlanRecord)
   */
  public toRecord(options?: {
    id?: string;
    title?: string;
    outputPath?: string;
  }): PlanRecord {
    const segments = this.getSegments();
    const decisions: Record<string, RetentionDecision> = {};
    for (const seg of segments) {
      decisions[seg.id] = seg.decision;
    }

    const title = options?.title || this.mediaPath.split(/[\\/]/).pop() || '未命名剪辑方案';
    const planId = options?.id || `plan_${Date.now()}`;

    return {
      id: planId,
      title,
      sourcePath: this.mediaPath,
      outputPath: options?.outputPath || '',
      totalDurationMs: this.totalDurationMs,
      keptDurationMs: this.getKeptDurationMs(),
      cutsCount: this.cuts.length,
      status: 'ready',
      updatedAt: new Date().toISOString(),
      completedAt: null,
      cuts: [...this.cuts],
      decisions,
      concatSingleFile: this.concatSingleFile,
      stripOriginalCover: this.stripOriginalCover,
    };
  }

  /**
   * 从持久化记录还原草稿
   */
  public static fromRecord(record: PlanRecord, totalDurationMs: number): RetentionDraft {
    const draft = new RetentionDraft(record.sourcePath, totalDurationMs);
    draft.concatSingleFile = record.concatSingleFile ?? true;
    draft.stripOriginalCover = record.stripOriginalCover ?? true;

    draft.rebuildFromCutsAndDecisions(record.cuts || [], record.decisions || {});
    return draft;
  }

  /**
   * 导出当前草稿快照（用于撤销/重做栈）
   */
  public snapshot(): DraftSnapshot {
    const decisions: Record<string, RetentionDecision> = {};
    this.intervals.forEach((it, idx) => {
      decisions[`seg_${idx}`] = it.decision;
    });
    return {
      cuts: [...this.cuts],
      decisions,
      concatSingleFile: this.concatSingleFile,
      stripOriginalCover: this.stripOriginalCover,
    };
  }

  /**
   * 从快照原子化恢复
   */
  public restore(snapshot: DraftSnapshot): void {
    this.concatSingleFile = snapshot.concatSingleFile;
    this.stripOriginalCover = snapshot.stripOriginalCover;
    this.rebuildFromCutsAndDecisions(snapshot.cuts || [], snapshot.decisions || {});
  }

  /**
   * 统一根据切点列表和决策字典重建区间（消除重复代码）
   */
  private rebuildFromCutsAndDecisions(cuts: number[], decisions: Record<string, RetentionDecision>): void {
    if (!cuts || cuts.length === 0) {
      this.intervals = [
        {
          startMs: 0,
          endMs: this.totalDurationMs,
          decision: decisions['seg_0'] || 'keep',
        },
      ];
      this.rebuildCuts();
      return;
    }

    const sortedCuts = Array.from(new Set(cuts)).sort((a, b) => a - b);
    const allPoints = [0, ...sortedCuts, this.totalDurationMs];
    const intervals: Array<{ startMs: number; endMs: number; decision: RetentionDecision }> = [];

    for (let i = 0; i < allPoints.length - 1; i++) {
      const segId = `seg_${i}`;
      const decision = decisions[segId] || 'keep';
      intervals.push({
        startMs: allPoints[i],
        endMs: allPoints[i + 1],
        decision,
      });
    }

    this.intervals = intervals;
    this.rebuildCuts();
  }

  private rebuildCuts(): void {
    this.cuts = [];
    for (let i = 0; i < this.intervals.length - 1; i++) {
      this.cuts.push(this.intervals[i].endMs);
    }
  }

  private parseSegmentIndex(segmentId: string): number {
    const match = /^seg_(\d+)$/.exec(segmentId);
    return match ? parseInt(match[1], 10) : -1;
  }
}
