import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaIndexStore, MediaIndexRecord } from '../src/main/services/MediaIndexStore';
import { CacheMaintenanceService } from '../src/main/services/CacheMaintenanceService';
import { fileIdentityAsync, ProbedFile } from '../src/main/services/MediaTools';

const managers: CacheMaintenanceService[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const manager of managers.splice(0)) await manager.close(); });
const info: ProbedFile = {
  durationMs: 1000, containerDurationMs: 1000, width: 32, height: 32, fps: 25,
  displayAspectRatio: 1, videoIndex: 0, videoStartMs: 0, timeBase: '1/1000',
  origin: { numerator: '0', denominator: '1' }, streams: [{ index: 0, type: 'video', codec: 'h264', attachedPicture: false, default: true }],
};
async function setup() {
  const base = path.resolve('../videoCutTool_tmp/20261029-方案索引关联简化/unit');
  await fs.promises.mkdir(base, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(base, 'store-'));
  const source = path.join(directory, 'source.mp4'); await fs.promises.writeFile(source, '只读原片哨兵');
  const data = path.join(directory, 'data');
  const maintenance = new CacheMaintenanceService(path.join(directory, 'maintenance')); managers.push(maintenance);
  const store = new MediaIndexStore(data, maintenance); await store.ready;
  const identity = await fileIdentityAsync(source);
  return { directory, source, data, store, maintenance, identity };
}
async function seed(x: Awaited<ReturnType<typeof setup>>, payload?: string) {
  const record: MediaIndexRecord = { version: 1, id: randomUUID(), identity: x.identity, source: x.source, kind: 'frames', info, usable: true };
  const directory = path.join(x.store.directory, record.id); await fs.promises.mkdir(directory);
  await fs.promises.writeFile(path.join(directory, 'record.json'), JSON.stringify(record));
  if (payload !== undefined) await fs.promises.writeFile(path.join(directory, 'data.json'), payload);
  return { record, directory };
}

describe('共享索引异常不退回重复扫描', () => {
  it('发布尚未完成时媒体使用者等待同一结果', async () => {
    const x = await setup();
    let reached!: () => void, release!: () => void;
    const arrived = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to).startsWith(x.store.directory + path.sep)) { reached(); await gate; }
      return rename(from, to);
    });
    const publishing = x.store.publish(x.source, x.identity, 'frames', info, { points: [0] });
    try {
      await arrived;
      let finished = false;
      const reading = x.store.find(x.source).then(record => { finished = true; return record; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(finished).toBe(false);
      release();
      expect((await reading)?.id).toBe((await publishing).id);
    } finally { release(); await publishing; }
  });
  it('索引目录初始化失败时保留诊断，查询和发布不能当作未命中继续', async () => {
    const x = await setup(), blocked = path.join(x.directory, 'blocked');
    await fs.promises.mkdir(blocked);
    const file = path.join(blocked, 'media-index'); await fs.promises.writeFile(file, '保留目录冲突文件');
    const store = new MediaIndexStore(blocked, x.maintenance);
    await expect(store.ready).rejects.toThrow();
    await expect(store.find(x.source)).rejects.toThrow();
    await expect(store.publish(x.source, x.identity, 'frames', info, {})).rejects.toThrow();
    expect(store.issues).toHaveLength(1); expect(store.issues[0]).toMatch(/索引目录.*不自动重新扫描/);
    expect(await fs.promises.readFile(file, 'utf8')).toBe('保留目录冲突文件');
  });
  it('结构合法的 JSON 若语义校验失败也停止复用并报告', async () => {
    const x = await setup(), seeded = await seed(x, '{"points":[]}');
    const restarted = new MediaIndexStore(x.data, x.maintenance);
    const record = await restarted.find(x.source);
    await expect(restarted.read<{ points: number[] }>(record!, value => value.points.length > 0)).rejects.toThrow(/索引.*保留/);
    await expect(restarted.find(x.source)).rejects.toThrow(/索引.*保留/);
    expect(await fs.promises.readFile(path.join(seeded.directory, 'data.json'), 'utf8')).toBe('{"points":[]}');
    expect(restarted.issues).toHaveLength(1);
  });
  it('完整结果并发发布只保留一份，重启后仍复用', async () => {
    const x = await setup();
    const records = await Promise.all([x.store.publish(x.source, x.identity, 'frames', info, { points: [0] }), x.store.publish(x.source, x.identity, 'frames', info, { points: [0] })]);
    expect(records[0].id).toBe(records[1].id);
    const restarted = new MediaIndexStore(x.data, x.maintenance);
    expect((await restarted.find(x.source))?.id).toBe(records[0].id);
    expect(await restarted.read(records[0])).toEqual({ points: [0] });
    expect(await fs.promises.readdir(x.store.directory)).toEqual([records[0].id]);
  });
  it('数据文件缺失时明确失败，不能当作未建索引或发布重复结果', async () => {
    const x = await setup(), seeded = await seed(x);
    const restarted = new MediaIndexStore(x.data, x.maintenance);
    await expect(restarted.find(x.source)).rejects.toThrow(/索引.*保留/);
    await expect(restarted.publish(x.source, x.identity, 'frames', info, {})).rejects.toThrow(/索引.*保留/);
    expect(restarted.issues).toHaveLength(1);
    expect(await fs.promises.readdir(x.store.directory)).toEqual([seeded.record.id]);
    expect(await fileIdentityAsync(x.source)).toBe(x.identity);
  });
  it('记录无法解析时不猜测归属，不自动重建；其他有效索引仍可复用', async () => {
    const x = await setup(), seeded = await seed(x, '{"points":[0]}');
    const broken = path.join(x.store.directory, randomUUID()); await fs.promises.mkdir(broken);
    await fs.promises.writeFile(path.join(broken, 'record.json'), '{损坏记录');
    const other = path.join(x.directory, 'other.mp4'); await fs.promises.writeFile(other, '其他原片');
    const restarted = new MediaIndexStore(x.data, x.maintenance);
    expect((await restarted.find(x.source))?.id).toBe(seeded.record.id);
    await expect(restarted.find(other)).rejects.toThrow(/无法确认.*不.*扫描/);
    await expect(restarted.publish(other, await fileIdentityAsync(other), 'frames', info, {})).rejects.toThrow(/无法确认/);
    expect(await fs.promises.readFile(path.join(broken, 'record.json'), 'utf8')).toBe('{损坏记录');
  });
  it('数据损坏时保留原文件并给出可理解错误，不产生新索引', async () => {
    const x = await setup(), seeded = await seed(x, '{损坏数据');
    const restarted = new MediaIndexStore(x.data, x.maintenance), record = await restarted.find(x.source);
    await expect(restarted.read(record!)).rejects.toThrow(/索引.*保留/);
    await expect(restarted.find(x.source)).rejects.toThrow(/索引.*保留/);
    expect(await fs.promises.readFile(path.join(seeded.directory, 'data.json'), 'utf8')).toBe('{损坏数据');
    expect(await fs.promises.readdir(x.store.directory)).toEqual([seeded.record.id]);
  });
  it('完整记录目录丢失完成标记时也报告，不能静默略过', async () => {
    const x = await setup(), directory = path.join(x.store.directory, randomUUID());
    await fs.promises.mkdir(directory); await fs.promises.writeFile(path.join(directory, 'data.json'), '{}');
    const restarted = new MediaIndexStore(x.data, x.maintenance);
    await expect(restarted.find(x.source)).rejects.toThrow(/无法确认/);
    expect(restarted.issues).toHaveLength(1);
    expect(await fs.promises.readFile(path.join(directory, 'data.json'), 'utf8')).toBe('{}');
  });
});
