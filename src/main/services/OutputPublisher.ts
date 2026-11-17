import fs from 'fs';
import { abortError } from './MediaTools';

/** 只为完整成品增加排他名称，不复制内容，不覆盖目标。 */
export async function publishOutput(source: string, target: string, signal?: AbortSignal): Promise<fs.Stats> {
  if (signal?.aborted) throw abortError();
  const identity = await fs.promises.stat(source);
  if (signal?.aborted) throw abortError();
  try { await fs.promises.link(source, target); }
  catch (error: any) {
    if (['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw Object.assign(new Error('目标位置不支持同卷安全发布或没有写入权限，请选择可写的 NTFS 目录。不会改用复制。'), { code: error.code });
    if (error.code === 'ENOSPC') throw Object.assign(new Error('目标磁盘空间不足，未发布成品'), { code: error.code });
    throw error;
  }
  return identity;
}

export async function removePublished(file: string, identity: fs.Stats) {
  try { const current = await fs.promises.lstat(file); if (current.ino === identity.ino && current.dev === identity.dev) await fs.promises.unlink(file); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
}
