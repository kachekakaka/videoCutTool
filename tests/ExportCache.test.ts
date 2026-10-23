import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { CacheMaintenanceService } from '../src/main/services/CacheMaintenanceService';
import { MediaCuttingEngine } from '../src/main/services/MediaCuttingEngine';
import { RetentionDraft } from '../src/shared/RetentionDraft';

describe('导出快照的缓存归属', () => {
  it('同一引擎连续失败后仍复用可发现的登记根，关闭引擎不关闭外部维护服务', async () => {
    const base = path.resolve('../videoCutTool_tmp/precise-review-20261023/unit');
    await fs.promises.mkdir(base, { recursive: true });
    const directory = await fs.promises.mkdtemp(path.join(base, 'case-'));
    const registry = path.join(directory, 'registry'), slices = path.join(directory, 'slices'), root = path.join(slices, 'managed');
    const manager = new CacheMaintenanceService(registry);
    const engine = new MediaCuttingEngine(undefined, slices, undefined, undefined, manager);
    const draft = new RetentionDraft(path.join(directory, 'source.mp4'), 1000);
    draft.setDecision('seg_0', 'discard');
    const plan = draft.toPlan([], { outputPath: directory });
    try {
      for (let i = 0; i < 3; i++) expect((await engine.executeRawPlan(plan)).error).toBe('未选择任何保留片段');
      expect(fs.existsSync(path.join(root, 'managed'))).toBe(false);
      expect((await fs.promises.readdir(registry)).filter(name => name.endsWith('.json'))).toHaveLength(1);
      expect((await fs.promises.readdir(root)).filter(name => name.startsWith('asset_'))).toEqual([]);
      await engine.shutdown();
      const task = await manager.create(root, 'task', '');
      const partial = path.join(task, 'precise_0_0.nut');
      await manager.allowTaskFile(task, partial); await fs.promises.writeFile(partial, '未完成的媒体');
      manager.release(task);
      await manager.close();
      const recovered = new CacheMaintenanceService(registry);
      try { await recovered.discover(); await recovered.sweep(); expect(fs.existsSync(task)).toBe(false); expect(recovered.issues).toEqual([]); }
      finally { await recovered.close(); }
    } finally { await engine.shutdown(); await manager.close(); }
  });
  it('引擎自建的维护服务在关闭后释放所有权，可以在同进程重新打开', async () => {
    const base = path.resolve('../videoCutTool_tmp/precise-review-20261023/unit');
    await fs.promises.mkdir(base, { recursive: true });
    const directory = await fs.promises.mkdtemp(path.join(base, 'owned-')), slices = path.join(directory, 'slices');
    const draft = new RetentionDraft(path.join(directory, 'source.mp4'), 1000); draft.setDecision('seg_0', 'discard');
    for (let i = 0; i < 2; i++) {
      const engine = new MediaCuttingEngine(undefined, slices);
      try { expect((await engine.executeRawPlan(draft.toPlan([], { outputPath: directory }))).success).toBe(false); }
      finally { await engine.shutdown(); }
      expect(fs.existsSync(path.join(slices, 'managed/.vct-owner.json'))).toBe(false);
    }
  });
});
