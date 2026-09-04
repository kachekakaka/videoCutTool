import { describe, it, expect } from 'vitest';
import { planRetention } from '../src/shared/RetentionPlanner';

describe('RetentionPlanner 关键帧保全数学不变量', () => {
  const keyframes = [0, 2000, 5000, 8000, 11000];
  const totalMs = 15000;

  it('保留段起点必然向左吸附关键帧，且 safeRange 完整包含 userRange (绝不多删一帧)', () => {
    const segments = [
      { id: '1', index: 1, startMs: 3200, endMs: 6500, durationMs: 3300, decision: 'keep' as const },
    ];
    const plan = planRetention('test.mp4', totalMs, segments, keyframes, 'out.mp4');
    const seg = plan.planSegments[0];

    // 数学不变量：安全起点 <= 用户起点，安全终点 >= 用户终点
    expect(seg.safeRange.startMs).toBeLessThanOrEqual(seg.userRange.startMs);
    expect(seg.safeRange.endMs).toBeGreaterThanOrEqual(seg.userRange.endMs);
    expect(seg.safeRange.startMs).toBe(2000); // 向左吸附到最近关键帧 2000ms
    expect(seg.safeRange.endMs).toBe(6500);
  });

  it('连续保留区间在向左吸附导致重叠时自动合并', () => {
    const segments = [
      { id: '1', index: 1, startMs: 1000, endMs: 2500, durationMs: 1500, decision: 'keep' as const },
      { id: '2', index: 2, startMs: 2600, endMs: 4000, durationMs: 1400, decision: 'keep' as const },
    ];
    const plan = planRetention('test.mp4', totalMs, segments, keyframes, 'out.mp4');
    expect(plan.planSegments.length).toBe(1); // 合并为 1 个连续段
    expect(plan.planSegments[0].safeRange.startMs).toBe(0);
    expect(plan.planSegments[0].safeRange.endMs).toBe(4000);
  });
});
