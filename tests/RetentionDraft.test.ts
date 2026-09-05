import { describe, it, expect } from 'vitest';
import { RetentionDraft } from '../src/shared/RetentionDraft';

describe('RetentionDraft 核心领域深模块不变量验证', () => {
  it('应当正确阻断首尾小于 200ms 或切点间距过近的非法插点', () => {
    const draft = new RetentionDraft('/test/sample.mp4', 10000);
    expect(draft.addCut(100)).toBe(false);
    expect(draft.addCut(9900)).toBe(false);
    expect(draft.addCut(3000)).toBe(true);
    expect(draft.addCut(3100)).toBe(false);
    expect(draft.addCut(3500)).toBe(true);
    expect(draft.getCuts()).toEqual([3000, 3500]);
    expect(draft.getSegments().length).toBe(3);
  });

  it('删除切点合并时必须坚决执行 keep 优先保全铁律（丢弃 + 保留 => 保留）', () => {
    const draft = new RetentionDraft('/test/sample.mp4', 10000);
    draft.addCut(2000);
    draft.addCut(5000);

    draft.setDecision('seg_0', 'discard');
    draft.setDecision('seg_1', 'keep');
    draft.setDecision('seg_2', 'discard');

    expect(draft.removeCut(2000)).toBe(true);
    const segments = draft.getSegments();
    expect(segments.length).toBe(2);
    expect(segments[0].startMs).toBe(0);
    expect(segments[0].endMs).toBe(5000);
    expect(segments[0].decision).toBe('keep');
  });

  it('段落级合并方法 mergeSegmentWithPrevious 应当正确合并分段', () => {
    const draft = new RetentionDraft('/test/sample.mp4', 10000);
    draft.addCut(3000);
    draft.setDecision('seg_0', 'discard');
    draft.setDecision('seg_1', 'keep');

    expect(draft.mergeSegmentWithPrevious('seg_1')).toBe(true);
    const segments = draft.getSegments();
    expect(segments.length).toBe(1);
    expect(segments[0].decision).toBe('keep');
  });

  it('微调段落起点与终点边界不应突破安全距离', () => {
    const draft = new RetentionDraft('/test/sample.mp4', 10000);
    draft.addCut(2000);
    draft.addCut(5000);

    expect(draft.nudgeSegmentStart('seg_1', -100)).toBe(true);
    expect(draft.getCuts()[0]).toBe(1900);

    expect(draft.nudgeSegmentEnd('seg_0', 200)).toBe(true);
    expect(draft.getCuts()[0]).toBe(2100);

    expect(draft.nudgeSegmentStart('seg_1', -2000)).toBe(false);
  });

  it('快照导出与原子化恢复应当精确无损保持所有区间与决策', () => {
    const draft = new RetentionDraft('/test/sample.mp4', 10000);
    draft.addCut(2500);
    draft.addCut(6000);
    draft.setDecision('seg_1', 'discard');
    draft.concatSingleFile = false;

    const snap = draft.snapshot();
    draft.addCut(8000);
    draft.setDecision('seg_0', 'discard');

    draft.restore(snap);
    expect(draft.getCuts()).toEqual([2500, 6000]);
    const segments = draft.getSegments();
    expect(segments[0].decision).toBe('keep');
    expect(segments[1].decision).toBe('discard');
    expect(draft.concatSingleFile).toBe(false);
  });

  it('toRecord 与 fromRecord 序列化双向还原应保持完全一致', () => {
    const draft = new RetentionDraft('D:/sample.mp4', 12000);
    draft.addCut(3000);
    draft.addCut(7000);
    draft.setDecision('seg_1', 'discard');

    const record = draft.toRecord({ id: 'plan_test_01', outputPath: 'D:/sample_cut.mp4' });
    expect(record.cutsCount).toBe(2);

    const restored = RetentionDraft.fromRecord(record, 12000);
    expect(restored.getCuts()).toEqual([3000, 7000]);
    expect(restored.getKeptDurationMs()).toBe(8000);
    expect(restored.getSegments()[1].decision).toBe('discard');
  });

  it('toPlan 应生成严格向左吸附关键帧的不可变切片计划', () => {
    const draft = new RetentionDraft('/test/video.mp4', 10000);
    draft.addCut(3000);
    draft.addCut(7000);
    draft.setDecision('seg_0', 'discard');
    draft.setDecision('seg_1', 'keep'); // 3000-7000
    draft.setDecision('seg_2', 'discard');

    // 假设关键帧在 0, 2000, 4000, 6000, 8000
    const keyframes = [0, 2000, 4000, 6000, 8000];
    const plan = draft.toPlan(keyframes, { outputPath: '/test/out.mp4' });

    expect(plan.planSegments.length).toBe(1);
    const planSeg = plan.planSegments[0];
    // userRange: 3000-7000; 向左吸附前向 I-Frame 应吸附到 2000!
    expect(planSeg.userRange.startMs).toBe(3000);
    expect(planSeg.safeRange.startMs).toBe(2000);
    expect(planSeg.sourceKeyframeMs).toBe(2000);
    expect(planSeg.safeRange.endMs).toBe(7000);
  });

  it('moveCut 应允许在合法安全边界内移动切点并保持原有保留决策', () => {
    const draft = new RetentionDraft('/test/video.mp4', 10000);
    draft.addCut(3000); // cutIndex 0: 3000
    draft.addCut(7000); // cutIndex 1: 7000
    draft.setDecision('seg_0', 'keep');
    draft.setDecision('seg_1', 'discard');
    draft.setDecision('seg_2', 'keep');

    // 1. 合法右移 cut 0 到 4500
    const ok = draft.moveCut(0, 4500);
    expect(ok).toBe(true);
    expect(draft.getCuts()).toEqual([4500, 7000]);

    const segs = draft.getSegments();
    expect(segs[0].endMs).toBe(4500);
    expect(segs[1].startMs).toBe(4500);
    // 决策保全不变性
    expect(segs[0].decision).toBe('keep');
    expect(segs[1].decision).toBe('discard');
    expect(segs[2].decision).toBe('keep');

    // 2. 碰撞防护：试图移动 cut 0 超过 cut 1 (距离 7000 小于 200ms，例如 6900)
    const collisionOk = draft.moveCut(0, 6900);
    expect(collisionOk).toBe(false);
    expect(draft.getCuts()[0]).toBe(4500); // 维持原值

    // 3. 首部碰撞防护：试图移动 cut 0 距离开头 < 200ms (例如 100)
    const headCollisionOk = draft.moveCut(0, 100);
    expect(headCollisionOk).toBe(false);
    expect(draft.getCuts()[0]).toBe(4500); // 维持原值
  });
});
