import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export const cacheKey = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const mediaUrl = (file: string) => `media://video?path=${encodeURIComponent(file)}`;

/** 只清理本服务命名的缓存文件；最近显示的画格优先保留。 */
export class PreviewCache {
  constructor(readonly directory: string, private maxFiles = 128, private maxBytes = 512 * 1024 * 1024) { fs.mkdirSync(directory, { recursive: true }); }
  file(key: string, extension = '.png') { return path.join(this.directory, `cache_${key}${extension}`); }
  async hit(file: string) { try { const stat = await fs.promises.stat(file); if (!stat.size) return false; const now = new Date(); await fs.promises.utimes(file, now, now); return true; } catch { return false; } }
  async trim(protectedFiles: string[] = []) {
    const files = await fs.promises.readdir(this.directory);
    const entries = (await Promise.all(files.filter(name => /^cache_[a-f0-9]+\.(png|mp4)$/.test(name)).map(async name => {
      const file = path.join(this.directory, name); const stat = await fs.promises.stat(file).catch(() => null); return stat ? { file, size: stat.size, time: stat.mtimeMs } : null;
    }))).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).sort((a, b) => b.time - a.time);
    const current = entries.filter(entry => protectedFiles.includes(entry.file));
    const oversized = current.length > this.maxFiles || current.reduce((sum, entry) => sum + entry.size, 0) > this.maxBytes;
    if (oversized) protectedFiles = [];
    let bytes = oversized ? 0 : current.reduce((sum, entry) => sum + entry.size, 0), count = oversized ? 0 : current.length;
    for (const entry of entries) {
      if (protectedFiles.includes(entry.file)) continue;
      if (count >= this.maxFiles || bytes + entry.size > this.maxBytes || Date.now() - entry.time > 24 * 3600000) await fs.promises.unlink(entry.file).catch(() => {});
      else { bytes += entry.size; count++; }
    }
    if (oversized) throw new Error('本次预览超出缓存容量，请减少对比场景或使用较短素材');
  }
}
