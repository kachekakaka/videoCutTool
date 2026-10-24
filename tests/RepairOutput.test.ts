import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheMaintenanceService, externalTemporaryDirectory } from '../src/main/services/CacheMaintenanceService';
import { publishRepairOutput } from '../src/main/services/RepairOutput';

const managers: CacheMaintenanceService[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const m of managers.splice(0)) await m.close(); });
async function setup() {
  const base = path.resolve('../videoCutTool_tmp/timeline-repair-20261024/unit');
  await fs.promises.mkdir(base, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(base, 'publish-'));
  const destination = path.join(directory, 'destination'); await fs.promises.mkdir(destination);
  const source = path.join(directory, 'source.bin'), output = path.join(destination, 'repaired.mp4');
  await fs.promises.writeFile(source, Buffer.alloc(3 * 1024 ** 2, 31));
  const maintenance = new CacheMaintenanceService(path.join(directory, 'registry')); managers.push(maintenance);
  const root = path.join(externalTemporaryDirectory(destination), 'slices', 'managed');
  return { directory, source, output, maintenance, root };
}
function crossVolume() { vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(Object.assign(new Error('跨盘'), { code: 'EXDEV' })); }
describe('修复副本的排他发布与回收', () => {
  it('已有输出和原片不覆盖', async () => {
    const x = await setup(); await fs.promises.writeFile(x.output, '原文件');
    await expect(publishRepairOutput(x.source, x.output, x.maintenance)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.promises.readFile(x.output, 'utf8')).toBe('原文件');
    expect((await fs.promises.stat(x.source)).size).toBe(3 * 1024 ** 2);
  });
  it('跨盘复制完成才出现成品，清理不会删除成品和未知附件', async () => {
    const x = await setup(); await x.maintenance.registerRoot(x.root);
    const evidence = path.join(x.root, 'attachment.png'); await fs.promises.writeFile(evidence, '验收附件');
    crossVolume();
    await publishRepairOutput(x.source, x.output, x.maintenance, undefined, () => expect(fs.existsSync(x.output)).toBe(false));
    await x.maintenance.sweep();
    expect((await fs.promises.readFile(x.output)).equals(await fs.promises.readFile(x.source))).toBe(true);
    expect(await fs.promises.readFile(evidence, 'utf8')).toBe('验收附件');
    expect((await fs.promises.readdir(x.root)).some(name => name.startsWith('asset_'))).toBe(false);
  });
  it('复制中取消只回收登记半成品，原片和配置方案不受影响', async () => {
    const x = await setup(), controller = new AbortController();
    const sentinel = path.join(x.directory, 'config.json'); await fs.promises.writeFile(sentinel, '配置与方案');
    crossVolume();
    await expect(publishRepairOutput(x.source, x.output, x.maintenance, controller.signal, () => controller.abort())).rejects.toMatchObject({ name: 'AbortError' });
    await x.maintenance.sweep();
    expect(fs.existsSync(x.output)).toBe(false);
    expect((await fs.promises.readdir(x.root)).some(name => name.startsWith('asset_'))).toBe(false);
    expect(await fs.promises.readFile(sentinel, 'utf8')).toBe('配置与方案');
    expect((await fs.promises.stat(x.source)).size).toBe(3 * 1024 ** 2);
  });
  it('复制期间出现同名文件，发布拒绝且不删除竞争者文件', async () => {
    const x = await setup(); crossVolume();
    await expect(publishRepairOutput(x.source, x.output, x.maintenance, undefined, () => { if (!fs.existsSync(x.output)) fs.writeFileSync(x.output, '其他文件'); })).rejects.toMatchObject({ code: 'EEXIST' });
    await x.maintenance.sweep();
    expect(await fs.promises.readFile(x.output, 'utf8')).toBe('其他文件');
    expect((await fs.promises.readdir(x.root)).some(name => name.startsWith('asset_'))).toBe(false);
  });
  it('不支持排他发布的文件系统直接拒绝，不退回可能留下半成品的复制', async () => {
    const x = await setup(); vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(Object.assign(new Error('不支持'), { code: 'ENOTSUP' }));
    await expect(publishRepairOutput(x.source, x.output, x.maintenance)).rejects.toMatchObject({ code: 'ENOTSUP' });
    expect(fs.existsSync(x.output)).toBe(false);
  });
});
