import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { CacheKind, CacheMaintenanceService } from './CacheMaintenanceService';

export const cacheKey = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const mediaUrl = (file: string) => `media://video?path=${encodeURIComponent(file)}`;

export interface CacheUse { file: string; fresh: boolean; release: () => void }
/** 新资产单独登记；容量维护不参与媒体生成的成功判定。 */
export class PreviewCache {
  readonly directory: string;
  readonly maintenance: CacheMaintenanceService;
  readonly ready: Promise<void>;
  constructor(directory: string, private kind: Exclude<CacheKind, 'task'> = 'picture', maintenance?: CacheMaintenanceService) {
    this.directory = path.join(directory, 'managed');
    this.maintenance = maintenance ?? new CacheMaintenanceService(path.join(path.dirname(directory), '.cache-maintenance'));
    this.ready = this.maintenance.registerRoot(this.directory);
  }
  async lookup(cacheId: string): Promise<CacheUse | undefined> {
    await this.ready;
    const name = await this.maintenance.find(this.directory, cacheId, this.kind);
    if (name) {
      const file = path.join(this.directory, name), release = await this.maintenance.pin(file);
      try { if (await this.maintenance.valid(file) && (await fs.promises.stat(file)).size) { await this.maintenance.touch(file); return { file, release, fresh: false }; } }
      catch { /* 无效命中不妨碍重新生成，未知内容留待人工判断。 */ }
      release();
    }
  }
  async acquire(cacheId: string, extension = '.png'): Promise<CacheUse> {
    const hit = await this.lookup(cacheId); if (hit) return hit;
    const file = await this.maintenance.create(this.directory, this.kind, extension, cacheId);
    let released = false;
    return { file, fresh: true, release: () => { if (!released) { released = true; this.maintenance.release(file); } } };
  }
  async publish(use: CacheUse, temporary: string) { await fs.promises.link(temporary, use.file); await this.maintenance.ready(use.file); }
  async fail(use: CacheUse) { if (use.fresh) await this.maintenance.abandon(use.file); use.release(); }
  async request() { await this.ready; return this.maintenance.create(this.directory, 'task', ''); }
  async finish(directory: string) { try { await this.maintenance.abandon(directory); } catch (error) { console.warn('任务收尾登记失败：', error); } finally { this.maintenance.release(directory); await this.maintenance.sweep(); } }
}
