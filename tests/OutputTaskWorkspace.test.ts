import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheMaintenanceService } from '../src/main/services/CacheMaintenanceService';
import { createOutputWorkspace } from '../src/main/services/OutputTaskWorkspace';

const managers: CacheMaintenanceService[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const manager of managers.splice(0)) await manager.close(); });
async function setup() {
  const base = path.resolve('../videoCutTool_tmp/20261117-same-volume/unit');
  await fs.promises.mkdir(base, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(base, 'workspace-'));
  const destination = path.join(directory, 'output'), registry = path.join(directory, 'registry');
  const make = () => { const manager = new CacheMaintenanceService(registry); managers.push(manager); return manager; };
  return { directory, destination, registry, make, root: path.join(destination, 'videoCutTool_tmp/slices/managed') };
}
describe('目标侧任务空间生命周期', () => {
  it('同进程共享根，最后一个任务结束后其他实例可接手；重新取得不复用旧锁', async () => {
    const x = await setup(), a = x.make(), b = x.make();
    const first = await createOutputWorkspace(x.destination, a), second = await createOutputWorkspace(x.destination, a);
    expect(path.dirname(first.directory)).toBe(x.root);
    await first.close();
    await expect(createOutputWorkspace(x.destination, b)).rejects.toThrow('其他进程');
    await second.close();
    const third = await createOutputWorkspace(x.destination, b);
    await expect(createOutputWorkspace(x.destination, a)).rejects.toThrow('其他进程');
    await first.close(); expect(fs.existsSync(path.join(x.root, '.vct-owner.json'))).toBe(true);
    await third.close(); const fourth = await createOutputWorkspace(x.destination, a); await fourth.close();
    expect(fs.existsSync(path.join(x.root, '.vct-owner.json'))).toBe(false);
  });
  it('历史发现不重建删除的成品目录，保留登记；恢复后短暂占用并释放', async () => {
    const x = await setup(), a = x.make(); const task = await createOutputWorkspace(x.destination, a); await task.close();
    const moved = path.join(x.directory, 'offline'); await fs.promises.rename(x.destination, moved);
    const b = x.make(); await b.discover();
    expect(fs.existsSync(x.destination)).toBe(false); expect((await fs.promises.readdir(x.registry)).length).toBe(1);
    await fs.promises.rename(moved, x.destination); await b.discover();
    expect(fs.existsSync(path.join(x.root, '.vct-owner.json'))).toBe(false);
    const next = await createOutputWorkspace(x.destination, a); await next.close();
  });
  it('未知非空目录和 junction 均拒绝接管', async () => {
    const x = await setup(), a = x.make(); await fs.promises.mkdir(x.root, { recursive: true });
    const unknown = path.join(x.root, 'unknown.bin'); await fs.promises.writeFile(unknown, '用户文件');
    await expect(createOutputWorkspace(x.destination, a)).rejects.toThrow('未知非空');
    expect(fs.existsSync(path.join(x.root, '.vct-root.json'))).toBe(false);
    const redirected = path.join(x.directory, 'redirected');
    await fs.promises.symlink(x.destination, redirected, 'junction');
    await expect(createOutputWorkspace(redirected, a)).rejects.toThrow('链接');
    expect(await fs.promises.readFile(unknown, 'utf8')).toBe('用户文件');
  });
  it('探针失败、取消均清理任务并释放占用', async () => {
    const x = await setup(), a = x.make();
    vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(Object.assign(new Error('跨卷'), { code: 'EXDEV' }));
    await expect(createOutputWorkspace(x.destination, a)).rejects.toMatchObject({ code: 'EXDEV' });
    expect((await fs.promises.readdir(x.root)).filter(name => name.startsWith('asset_'))).toEqual([]);
    const controller = new AbortController(), acquire = a.acquireOutputRoot.bind(a);
    vi.spyOn(a, 'acquireOutputRoot').mockImplementation(async directory => { const release = await acquire(directory); controller.abort(); return release; });
    await expect(createOutputWorkspace(x.destination, a, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(path.join(x.root, '.vct-owner.json'))).toBe(false);
  });
  it('待启动进程阻止释放，撤销后维护可释放', async () => {
    const x = await setup(), a = x.make(), b = x.make();
    const task = await createOutputWorkspace(x.destination, a);
    const spawn = await a.trackSpawn(task.directory, []); await task.close();
    await expect(createOutputWorkspace(x.destination, b)).rejects.toThrow('其他进程');
    await spawn.cancel(); await a.sweep();
    const next = await createOutputWorkspace(x.destination, b); await next.close();
  });
  it('登记仍在但根标记丢失时不补写；释放不删除被替换的新锁', async () => {
    const x = await setup(), a = x.make();
    const task = await createOutputWorkspace(x.destination, a); await task.close();
    const marker = path.join(x.root,'.vct-root.json'); await fs.promises.unlink(marker);
    const b = x.make(); await b.discover(); expect(fs.existsSync(marker)).toBe(false);
    const other = await setup(), c = other.make();
    const pending = await createOutputWorkspace(other.destination,c);
    const lock = path.join(other.root,'.vct-owner.json');
    await fs.promises.writeFile(lock,JSON.stringify({ pid:process.pid,token:'replacement' }));
    await expect(pending.close()).rejects.toThrow('所有权');
    expect(JSON.parse(await fs.promises.readFile(lock,'utf8')).token).toBe('replacement');
  });
});
