import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanManager } from '../src/main/services/PlanManager';
import { RetentionDraft } from '../src/shared/RetentionDraft';
import { fileIdentityAsync } from '../src/main/services/MediaTools';
import { MediaCuttingEngine } from '../src/main/services/MediaCuttingEngine';
import { KeyframeProber } from '../src/main/services/KeyframeProber';

afterEach(() => vi.restoreAllMocks());
async function setup() {
  const base = path.resolve('../videoCutTool_tmp/shared-index-review-20261024/unit');
  await fs.promises.mkdir(base, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(base, 'plans-'));
  const source = path.join(directory, 'source.mp4'); await fs.promises.writeFile(source, '原片保留');
  const identity = await fileIdentityAsync(source);
  const indexes = { find: vi.fn().mockRejectedValue(new Error('索引损坏，文件保留')), issues: [] as string[], onPublished: undefined as undefined | (() => void) };
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
    x.indexes.find.mockResolvedValue({ id: 'shared', identity: x.identity, usable: true });
    const saved = await x.manager.savePlan(x.record);
    await x.manager.savePlan({ ...saved, title: '新修订', cuts: [2000, 6000] });
    await fs.promises.writeFile(path.join(x.directory, 'plans', 'saved.json'), '{模拟中断');
    const restarted = new PlanManager(x.directory, x.engine, x.prober); await restarted.ready;
    const recovered = await restarted.getPlan('saved');
    expect(recovered?.contentRevision).toBe(saved.contentRevision);
    expect(recovered?.cuts).toEqual(saved.cuts);
    expect(recovered?.sourceIdentity).toBe(x.identity);
    expect(recovered?.mediaIndexId).toBe('shared');
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
    expect((await x.manager.details()).issues.some(issue => issue.includes('关联'))).toBe(true);
    expect(x.indexes.find.mock.calls.every(call => call[1]?.waitForPublication === false)).toBe(true);
    const restarted = new PlanManager(x.directory, x.engine, x.prober); await restarted.ready;
    expect((await restarted.getPlan('saved'))?.cuts).toEqual(x.record.cuts);
    expect((await restarted.sourceBinding('saved')).token).toBeUndefined();
    await expect(restarted.savePlan(saved)).rejects.toThrow(/方案已被修改/);
    expect(await fileIdentityAsync(x.source)).toBe(x.identity);
  });
  it('旧方案可在索引损坏时确认源关系；索引错误不覆盖切点', async () => {
    const x = await setup();
    const { sourceIdentity: _identity, ...legacy } = x.record;
    await fs.promises.writeFile(path.join(x.directory, 'plans', 'saved.json'), JSON.stringify(legacy));
    await x.manager.refreshPlans();
    const binding = await x.manager.sourceBinding('saved'); expect(binding.token).toBeTruthy();
    const confirmed = await x.manager.confirmSource('saved', binding.token!);
    expect(confirmed.cuts).toEqual(legacy.cuts); expect(confirmed.sourceIdentity).toBe(x.identity);
    expect(confirmed.mediaIndexId).toBeUndefined();
  });
  it('索引查找期间原片发生变化仍拒绝保存，不能被待关联降级掩盖', async () => {
    const x = await setup();
    const saved = await x.manager.savePlan(x.record);
    const location = path.join(x.directory, 'plans', 'saved.json'), original = await fs.promises.readFile(location);
    x.indexes.find.mockImplementationOnce(async () => { await fs.promises.appendFile(x.source, '模拟修改'); throw new Error('索引不可用'); });
    await expect(x.manager.savePlan({ ...saved, title: '不得保存' })).rejects.toThrow(/素材.*变化/);
    expect(await fs.promises.readFile(location)).toEqual(original);
  });
});
