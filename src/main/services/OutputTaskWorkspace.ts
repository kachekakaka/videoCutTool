import fs from 'fs';
import path from 'path';
import { CacheMaintenanceService } from './CacheMaintenanceService';
import { abortError } from './MediaTools';
import { publishOutput } from './OutputPublisher';

/** 拒绝链接、联接点及跨卷挂载；不以盘符文本判断卷。 */
async function checkDirectory(directory: string, create: boolean) {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) await fs.promises.mkdir(current).catch((error: any) => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.promises.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('导出路径包含链接、联接点或非目录位置');
    const real = await fs.promises.realpath(current);
    if (path.relative(current, real)) throw new Error('导出真实路径发生重定向');
  }
}

export async function createOutputWorkspace(destination: string, maintenance: CacheMaintenanceService, signal?: AbortSignal) {
  const check = () => { if (signal?.aborted) throw abortError(); };
  check();
  await checkDirectory(destination, true);
  const root = path.join(destination, 'videoCutTool_tmp', 'slices', 'managed');
  await checkDirectory(root, true);
  const volume = (await fs.promises.stat(destination)).dev;
  for (const directory of [path.dirname(path.dirname(root)), path.dirname(root), root]) {
    if ((await fs.promises.stat(directory)).dev !== volume) throw new Error('导出临时目录被重定向到其他卷');
  }
  const releaseRoot = await maintenance.acquireOutputRoot(root);
  let directory: string | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (directory) {
        try { await maintenance.abandon(directory); }
        finally { await maintenance.release(directory); }
        await maintenance.sweep();
      }
    } finally { await releaseRoot(); }
  };
  try {
    check();
    directory = await maintenance.create(root, 'task', '');
    const probe = path.join(directory, 'probe.bin'), linked = path.join(directory, 'probe-link.bin');
    await maintenance.allowTaskFile(directory, probe);
    await maintenance.allowTaskFile(directory, linked);
    await fs.promises.writeFile(probe, 'probe', { flag: 'wx' });
    await publishOutput(probe, linked, signal);
    await fs.promises.unlink(linked); await fs.promises.unlink(probe);
    check();
    return { directory, close };
  } catch (error) { await close(); throw error; }
}
