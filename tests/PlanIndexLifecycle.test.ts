import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanManager } from '../src/main/services/PlanManager';
import { RetentionDraft } from '../src/shared/RetentionDraft';
import { fileIdentityAsync } from '../src/main/services/MediaTools';
import { MediaCuttingEngine } from '../src/main/services/MediaCuttingEngine';
import { KeyframeProber } from '../src/main/services/KeyframeProber';
import { MediaIndexStore } from '../src/main/services/MediaIndexStore';
import { PlanRecordStore } from '../src/main/services/PlanRecordStore';
import { CacheMaintenanceService } from '../src/main/services/CacheMaintenanceService';

afterEach(() => vi.restoreAllMocks());
async function setup() {
  const base = path.resolve('../videoCutTool_tmp/20261029-方案索引关联简化/unit');
  await fs.promises.mkdir(base, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(base, 'plans-'));
  const source = path.join(directory, 'source.mp4'); await fs.promises.writeFile(source, '原片保留');
  const identity = await fileIdentityAsync(source);
  const indexes = { ready: Promise.resolve(), find: vi.fn().mockRejectedValue(new Error('索引损坏，文件保留')), issues: ['索引损坏，文件保留'] };
  const engine = { setPlanSaver: vi.fn(), isAccepted: () => false, removeQueued: vi.fn(), restoreQueued: vi.fn() } as unknown as MediaCuttingEngine;
  const prober = { store: indexes } as unknown as KeyframeProber;
  const manager = new PlanManager(directory, engine, prober); await manager.ready;
  const draft = new RetentionDraft(source, 10000); draft.addCut(2300); draft.addCut(5100);
  const record = { ...draft.toRecord({ id: 'saved', title: '原方案', outputPath: source }), sourceIdentity: identity };
  return { directory, source, identity, indexes, engine, prober, manager, record };
}
describe('索引不可用时的方案保存和恢复', () => {
  it('中断写入后恢复旧修订和切点，不沿用新编辑内容', async () => {
    const x = await setup();
    const saved = await x.manager.savePlan(x.record);
    await x.manager.savePlan({ ...saved, title: '新修订', cuts: [2000, 6000] });
    await fs.promises.writeFile(path.join(x.directory, 'plans', 'saved.json'), '{模拟中断');
    const restarted = new PlanManager(x.directory, x.engine, x.prober); await restarted.ready;
    const recovered = await restarted.getPlan('saved');
    expect(recovered?.contentRevision).toBe(saved.contentRevision);
    expect(recovered?.cuts).toEqual(saved.cuts);
    expect(recovered?.sourceIdentity).toBe(x.identity);
    expect(x.indexes.find).not.toHaveBeenCalled();
  });
  it('恢复到尚未确认的旧方案时不能沿用较新绑定', async () => {
    const x = await setup();
    const { sourceIdentity: _identity, ...legacy } = x.record;
    const location = path.join(x.directory, 'plans', 'saved.json');
    await fs.promises.writeFile(location, JSON.stringify(legacy)); await x.manager.refreshPlans();
    const binding = await x.manager.sourceBinding('saved');
    await x.manager.confirmSource('saved', binding.token!);
    await fs.promises.writeFile(location, '{模拟中断');
    const restarted = new PlanManager(x.directory, x.engine, x.prober); await restarted.ready;
    const restored = await restarted.sourceBinding('saved');
    expect(restored.token).toBeTruthy(); expect(restored.record.sourceIdentity).toBeUndefined();
    expect(restored.record.cuts).toEqual(legacy.cuts);
  });
  it('索引损坏不阻止保存内容或另存，重启回载保持切点和源绑定', async () => {
    const x = await setup();
    const saved = await x.manager.savePlan(x.record);
    const updated = await x.manager.savePlan({ ...saved, title: '编辑已保存' });
    const another = await x.manager.savePlan({ ...saved, id: 'another' });
    expect(updated.cuts).toEqual(x.record.cuts); expect(another.cuts).toEqual(saved.cuts);
    expect(updated.sourceIdentity).toBe(x.identity);
    expect(updated.contentRevision).not.toBe(saved.contentRevision);
    expect((await x.manager.details()).issues).toContain('索引损坏，文件保留');
    const restarted = new PlanManager(x.directory, x.engine, x.prober); await restarted.ready;
    expect((await restarted.getPlan('saved'))?.cuts).toEqual(x.record.cuts);
    expect((await restarted.sourceBinding('saved')).token).toBeUndefined();
    await expect(restarted.savePlan(saved)).rejects.toThrow(/方案已被修改/);
    expect(await fileIdentityAsync(x.source)).toBe(x.identity);
    expect(x.indexes.find).not.toHaveBeenCalled();
  });
  it('旧方案可在索引损坏时确认源关系；索引错误不覆盖切点', async () => {
    const x = await setup();
    const { sourceIdentity: _identity, ...legacy } = x.record;
    await fs.promises.writeFile(path.join(x.directory, 'plans', 'saved.json'), JSON.stringify(legacy));
    await x.manager.refreshPlans();
    const binding = await x.manager.sourceBinding('saved'); expect(binding.token).toBeTruthy();
    const confirmed = await x.manager.confirmSource('saved', binding.token!);
    expect(confirmed.cuts).toEqual(legacy.cuts); expect(confirmed.sourceIdentity).toBe(x.identity);
    expect(x.indexes.find).not.toHaveBeenCalled();
  });
  it('原片变化仍拒绝回载、保存和执行，保留原方案', async () => {
    const x = await setup();
    const saved = await x.manager.savePlan(x.record);
    const location = path.join(x.directory, 'plans', 'saved.json'), original = await fs.promises.readFile(location);
    await fs.promises.appendFile(x.source, '模拟修改');
    await expect(x.manager.sourceBinding(saved.id)).rejects.toThrow(/素材.*变化/);
    await expect(x.manager.savePlan({ ...saved, title: '不得保存' })).rejects.toThrow(/素材.*变化/);
    await expect(x.manager.submitDraft(saved)).rejects.toThrow(/素材.*变化/);
    expect(await fs.promises.readFile(location)).toEqual(original);
  });
  it('未确认的方案不能直接保存或执行，确认期间换片不绑定', async () => {
    const x = await setup(), { sourceIdentity: _identity, ...legacy } = x.record;
    const location = path.join(x.directory, 'plans', 'saved.json');
    await fs.promises.writeFile(location, JSON.stringify(legacy)); await x.manager.refreshPlans();
    await expect(x.manager.savePlan(legacy)).rejects.toThrow(/待确认/);
    await expect(x.manager.submitDraft(legacy)).rejects.toThrow(/待确认/);
    const binding = await x.manager.sourceBinding(legacy.id);
    expect(await fs.promises.readFile(location, 'utf8')).toBe(JSON.stringify(legacy));
    await fs.promises.appendFile(x.source, '确认期间修改');
    await expect(x.manager.confirmSource(legacy.id, binding.token!)).rejects.toThrow(/素材.*变化/);
    expect(await fs.promises.readFile(location, 'utf8')).toBe(JSON.stringify(legacy));
  });
  it.each(['完成', '失败'])('索引初始化%s不阻塞方案，完成后只补送一次诊断', async outcome => {
    const x = await setup();
    await x.manager.savePlan(x.record);
    let finish!: () => void, fail!: (error: Error) => void;
    x.indexes.ready = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    x.indexes.issues.length = 0;
    const manager = new PlanManager(x.directory, x.engine, x.prober), changed = vi.fn();
    manager.setChangeListener(changed);
    try {
      await manager.ready;
      const saved = (await manager.details()).records[0];
      expect((await manager.details()).issues).toEqual([]);
      await manager.savePlan({ ...saved, title: '初始化期间可保存' });
      await manager.refreshPlans();
      expect(x.indexes.find).not.toHaveBeenCalled();
      changed.mockClear();
      x.indexes.issues.push('索引初始化诊断');
      if (outcome === '失败') fail(new Error('索引目录不可读')); else finish();
      await x.indexes.ready.catch(() => {});
      expect(changed).toHaveBeenCalledExactlyOnceWith({ issuesToAdd: ['索引初始化诊断'] });
      expect((await manager.details()).issues).toEqual(['索引初始化诊断']);
    } finally { finish(); }
  });
  it('索引发布不改写同源或无关方案，也不滚动恢复快照', async () => {
    const x = await setup(), maintenance = new CacheMaintenanceService(path.join(x.directory, 'maintenance'));
    try {
      const indexes = new MediaIndexStore(x.directory, maintenance);
      const manager = new PlanManager(x.directory, x.engine, { store: indexes } as KeyframeProber);
      await Promise.all([indexes.ready, manager.ready]);
      const first = await manager.savePlan(x.record);
      await manager.savePlan({ ...first, title: '已有恢复快照' });
      await manager.savePlan({ ...x.record, id: 'same-source' });
      const other = path.join(x.directory, 'other.mp4'); await fs.promises.writeFile(other, '无关原片');
      await manager.savePlan({ ...x.record, id: 'other', sourcePath: other, sourceIdentity: await fileIdentityAsync(other) });
      const before = await manager.listPlans();
      const files = before.flatMap(record => ['plans', 'plans_recovery'].map(dir => path.join(x.directory, dir, `${record.id}.json`)));
      const snapshot = () => Promise.all(files.map(file => fs.promises.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })));
      const contents = await snapshot(), changed = vi.fn(), save = vi.spyOn(PlanRecordStore.prototype, 'save');
      const find = vi.spyOn(indexes, 'find'), stat = vi.spyOn(fs.promises, 'stat');
      manager.setChangeListener(changed);
      await indexes.publish(x.source, x.identity, 'frames', {
        durationMs: 10000, containerDurationMs: 10000, width: 32, height: 32, fps: 25,
        displayAspectRatio: 1, videoIndex: 0, videoStartMs: 0, timeBase: '1/1000',
        origin: { numerator: '0', denominator: '1' }, streams: [{ index: 0, type: 'video', codec: 'h264', attachedPicture: false, default: true }],
      }, { points: [0] });
      expect(await manager.listPlans()).toEqual(before);
      expect(await snapshot()).toEqual(contents);
      expect(save).not.toHaveBeenCalled(); expect(find).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
      // 仅保留发布流程自己的两次源身份复核，没有逐方案检查。
      expect(stat.mock.calls.filter(([file]) => String(file) === x.source)).toHaveLength(2);
      expect(stat.mock.calls.filter(([file]) => String(file) === other)).toHaveLength(0);
    } finally { await maintenance.close(); }
  });
});
