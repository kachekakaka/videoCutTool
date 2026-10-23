import { describe, expect, it } from 'vitest';
import { REPAIR_CLOCK as C, RepairPacket, repairTimeline } from '../src/main/services/RepairTimeline';

const packets = (count: number, step: number): RepairPacket[] => Array.from({ length: count }, (_, i) => ({ pts: i * step, dts: i * step, duration: step, position: i * step, key: true }));
describe('断点统一修复时间轴', () => {
  it('按同一个偏移修复两路回退，保留包数量和片内同步关系', () => {
    const video = packets(100, C / 25), audio = packets(188, 15360);
    for (const p of video.slice(50)) { p.pts -= C * 20; p.dts -= C * 20; }
    for (const p of audio.slice(94)) { p.pts -= C * 20; p.dts -= C * 20; }
    const result = repairTimeline(video, audio), offset = result.boundaries[1].offset;
    expect(result.boundaries).toHaveLength(2);
    expect(result.video).toHaveLength(video.length); expect(result.audio).toHaveLength(audio.length);
    expect(result.video[60].pts - video[60].pts).toBe(offset);
    expect(result.audio[110].pts - audio[110].pts).toBe(offset);
    expect(result.audio.every((p, i) => !i || p.pts >= result.audio[i - 1].pts + 15360)).toBe(true);
  });
  it('无法配对的回退必须失败，不猜测另一轨的偏移', () => {
    const video = packets(100, C / 25), audio = packets(188, 15360);
    for (const p of video.slice(50)) { p.pts -= C * 20; p.dts -= C * 20; }
    expect(() => repairTimeline(video, audio)).toThrow('无法配对');
  });
  it('重复展示时刻平分下一帧间隔，不删除帧，也不留下微秒长帧', () => {
    const video = packets(100, C / 25), audio = packets(188, 15360);
    video[51].pts = video[50].pts;
    const result = repairTimeline(video, audio);
    expect(result.adjustedDuplicates).toBe(1); expect(result.video[51].pts - result.video[50].pts).toBe(C / 25);
    expect(new Set(result.video.map(p => p.pts)).size).toBe(100);
    expect(result.video.every((p, i) => p.pts >= p.dts && (!i || p.dts > result.video[i - 1].dts))).toBe(true);
  });
  it('拒绝大片音频重叠，不能把无法确认的同步关系当作修复成功', () => {
    const video = packets(100, C / 25), audio = packets(188, 15360);
    for (let i = 1; i < 20; i++) { audio[i].pts = 0; audio[i].dts = 0; }
    expect(() => repairTimeline(video, audio)).toThrow();
  });
});
