import { describe, expect, it } from 'vitest';
import { RetentionDraft } from '../src/shared/RetentionDraft';
import { selectFrameBoundary } from '../src/main/services/PreciseExport';
import { validateRecord } from '../src/main/services/IpcSecurity';

describe('精确导出边界与方案持久化', () => {
  function draft() {
    const value = new RetentionDraft('D:/media/sample.mp4', 10000);
    [1133, 2311, 4117, 5663].forEach(time => value.addCut(time));
    ['seg_0', 'seg_2', 'seg_4'].forEach(id => value.setDecision(id, 'discard'));
    return value;
  }
  it('精确模式不吞入同一关键帧组中的丢弃区间', () => {
    const value = draft(); value.exportPrecision = 'frame';
    const result = value.toPlan([0, 5000], { outputPath: 'D:/out.mp4' });
    expect(result.outputs[0].planSegments.map(segment => segment.safeRange)).toEqual([{ startMs: 1133, endMs: 2311 }, { startMs: 4117, endMs: 5663 }]);
    expect(result.totalKeptDurationMs).toBe(2724);
    value.exportPrecision = 'keyframe';
    expect(value.toPlan([0, 5000], { outputPath: 'D:/out.mp4' }).outputs[0].planSegments).toHaveLength(1);
  });
  it('保存载入、快照撤销及自定义输出组合保留精确模式', () => {
    const value = draft(); value.exportPrecision = 'frame'; value.combineSegments(['seg_1', 'seg_3']);
    const record = value.toRecord({ title: '精确方案', outputPath: 'D:/out.mp4' });
    expect(() => validateRecord(record)).not.toThrow();
    const restored = RetentionDraft.fromRecord(record, 10000);
    expect(restored.exportPrecision).toBe('frame');
    expect(restored.getOutputs()).toEqual(value.getOutputs());
    const snapshot = restored.snapshot(); restored.exportPrecision = 'keyframe'; restored.restore(snapshot);
    expect(restored.toPlan([], { outputPath: 'D:/out.mp4' }).exportPrecision).toBe('frame');
  });
  it('拒绝把精确模式与降码设置同时持久化', () => {
    const value = draft(); value.exportPrecision = 'frame'; value.compress = { enabled: true, preset: 'balanced' };
    expect(() => validateRecord(value.toRecord({ title: '冲突', outputPath: 'D:/out.mp4' }))).toThrow('精确导出');
  });
  it('毫秒舍入仍选中原始帧，帧间手输边界向后一帧对齐', () => {
    const points = [1000, 1033.333333, 1066.666667, 1100];
    expect(selectFrameBoundary(points, 1033)).toBe(points[1]);
    expect(selectFrameBoundary(points, 1067)).toBe(points[2]);
    expect(selectFrameBoundary(points, 1040)).toBe(points[2]);
    expect(selectFrameBoundary(points, 1200)).toBeUndefined();
  });
});
