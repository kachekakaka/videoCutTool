import fs from 'fs';
import path from 'path';
import { CacheMaintenanceService, externalTemporaryDirectory } from './CacheMaintenanceService';
import { abortError } from './MediaTools';

/** 跨盘也只发布完整文件；最终路径从不用于写半成品。成功发布后取消不得删除成品。 */
export async function publishRepairOutput(carrier: string, output: string, maintenance: CacheMaintenanceService, signal?: AbortSignal, copying?: (percent: number) => void) {
  const check = () => { if (signal?.aborted) throw abortError(); };
  const link = async (file: string) => {
    try { await fs.promises.link(file, output); }
    catch (error: any) {
      if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw Object.assign(new Error('目标磁盘不支持安全另存或没有写入权限，请选择可写的 NTFS 磁盘。原片保持不变。'), { code: error.code });
      throw error;
    }
  };
  check();
  try { await link(carrier); return; }
  catch (error: any) { if (error.code !== 'EXDEV') throw error; }
  // 目标盘上的临时空间也登记到同一维护服务，重启后可发现；不扫描用户输出目录。
  const root = path.join(externalTemporaryDirectory(path.dirname(output)), 'slices', 'managed');
  await maintenance.registerRoot(root);
  const directory = await maintenance.create(root, 'task', '');
  const staged = path.join(directory, 'repair.mp4');
  try {
    await maintenance.allowTaskFile(directory, staged);
    const source = await fs.promises.open(carrier, 'r');
    try {
      const target = await fs.promises.open(staged, 'wx');
      try {
        const total = (await source.stat()).size, buffer = Buffer.alloc(1024 * 1024);
        let copied = 0, lastReport = 0;
        while (copied < total) {
          check();
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, total - copied), copied);
          if (!bytesRead) throw new Error('修复副本读取不完整');
          for (let at = 0; at < bytesRead;) {
            check(); const { bytesWritten } = await target.write(buffer, at, bytesRead - at);
            if (!bytesWritten) throw new Error('修复副本写入不完整');
            at += bytesWritten;
          }
          copied += bytesRead;
          if (Date.now() - lastReport >= 200 || copied === total) { lastReport = Date.now(); copying?.(copied / total * 100); }
        }
        await target.sync();
        if ((await target.stat()).size !== total) throw new Error('修复副本大小不一致');
      } finally { await target.close(); }
    } finally { await source.close(); }
    check();
    // 排他硬链接只增加完整文件的名称；EEXIST、权限或文件系统不支持均拒绝发布。
    await link(staged);
  } finally {
    await maintenance.abandon(directory); maintenance.release(directory); await maintenance.sweep();
  }
}
