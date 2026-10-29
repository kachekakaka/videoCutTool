import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileIdentityAsync, ProbedFile } from './MediaTools';
import { CacheMaintenanceService, externalTemporaryDirectory } from './CacheMaintenanceService';

export interface MediaIndexRecord { version: 1; id: string; identity: string; source: string; kind: 'stream' | 'frames'; info: ProbedFile; usable: boolean; }
/** 完整索引是用户数据；记录发布是完成标志，目录可重建，没有淘汰或删除入口。 */
export class MediaIndexStore {
  readonly directory: string;
  private entries = new Map<string, MediaIndexRecord>();
  private ambiguous = new Set<string>();
  private unavailable = new Map<string, string>();
  private unidentified = false;
  private writes = new Map<string, Promise<MediaIndexRecord>>();
  readonly ready: Promise<void>;
  readonly issues: string[] = [];
  constructor(dataDirectory: string, private readonly maintenance?: CacheMaintenanceService) {
    this.directory = path.join(dataDirectory, 'media-index');
    this.ready = this.initialize().catch(error => {
      this.issues.push(`索引目录无法读取，文件已保留，不自动重新扫描：${String(error)}`);
      throw error;
    });
  }
  private async initialize() {
    await fs.promises.mkdir(this.directory, { recursive: true });
    const names = (await fs.promises.readdir(this.directory)).filter(name => /^[a-f0-9-]{36}$/.test(name));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, names.length) }, async () => {
      while (cursor < names.length) {
        const id = names[cursor++];
        let identity: string | undefined;
        try {
          const r = JSON.parse(await fs.promises.readFile(path.join(this.directory, id, 'record.json'), 'utf8')) as MediaIndexRecord;
          if (r.version !== 1 || r.id !== id || typeof r.identity !== 'string' || !r.identity || typeof r.source !== 'string' || typeof r.usable !== 'boolean' || !['stream', 'frames'].includes(r.kind) || !Number.isFinite(r.info?.durationMs) || !(r.info.durationMs > 0) || !Array.isArray(r.info.streams) || !r.info.origin || !r.info.timeBase) throw new Error('索引记录无效');
          identity = r.identity;
          await fs.promises.access(path.join(this.directory, id, 'data.json'));
          if (this.entries.has(r.identity) || this.ambiguous.has(r.identity)) { this.entries.delete(r.identity); this.ambiguous.add(r.identity); this.issues.push(`${id} 存在重复源版本，已停止复用，文件保留`); continue; }
          this.entries.set(r.identity, r);
        } catch (error) {
          const message = `索引 ${id} 无法读取，文件已保留，不自动重新扫描：${String(error)}`;
          if (identity) this.unavailable.set(identity, message); else this.unidentified = true;
          this.issues.push(message);
        }
      }
    }));
  }
  private lookup(identity: string) {
    if (this.ambiguous.has(identity)) throw new Error('同一素材存在多个完整索引，无法确认唯一结果；文件均已保留');
    const failure = this.unavailable.get(identity); if (failure) throw new Error(failure);
    const hit = this.entries.get(identity);
    // 损坏记录无法确认归属时，不能把一次查找未命中当成首次分析；有效命中仍可使用。
    if (!hit && this.unidentified) throw new Error('存在无法确认归属的索引记录，文件已保留；不自动重新扫描，请先检查索引读取错误');
    return hit;
  }
  async find(file: string) {
    await this.ready;
    const identity = await fileIdentityAsync(file);
    const pending = this.writes.get(identity);
    if (pending) {
      await pending;
      if (await fileIdentityAsync(file) !== identity) throw new Error('等待索引期间素材发生变化，请重新打开');
    }
    return this.lookup(identity);
  }
  async read<T>(record: MediaIndexRecord, validate?: (value: T) => boolean): Promise<T> {
    try {
      const value = JSON.parse(await fs.promises.readFile(path.join(this.directory, record.id, 'data.json'), 'utf8')) as T;
      if (validate && !validate(value)) throw new Error('索引数据结构或源绑定无效');
      return value;
    }
    catch (error) {
      const message = `索引 ${record.id} 数据无法读取，文件已保留，不自动重新扫描：${String(error)}`;
      if (!this.unavailable.has(record.identity)) this.issues.push(message);
      this.unavailable.set(record.identity, message); throw new Error(message);
    }
  }
  async publish(file: string, identity: string, kind: MediaIndexRecord['kind'], info: ProbedFile, data: unknown): Promise<MediaIndexRecord> {
    await this.ready;
    if (await fileIdentityAsync(file) !== identity) throw new Error('原片变化，索引不能发布');
    const hit = this.lookup(identity); if (hit) return hit;
    const pending = this.writes.get(identity); if (pending) return pending;
    const task = (async () => {
      const record: MediaIndexRecord = { version: 1, id: randomUUID(), identity, source: path.resolve(file), kind, info, usable: !(data as { discontinuity?: string }).discontinuity };
      const temporary = externalTemporaryDirectory(path.dirname(this.directory));
      const maintenance = this.maintenance ?? new CacheMaintenanceService(path.join(temporary, '.index-maintenance'));
      const root = path.join(temporary, 'index-staging', 'managed'); await maintenance.registerRoot(root);
      const directory = await maintenance.create(root, 'task', '');
      try {
        const write = async (name: string, value: unknown) => { const file = path.join(directory, name); await maintenance.allowTaskFile(directory, file); const h = await fs.promises.open(file, 'wx'); try { await h.writeFile(JSON.stringify(value)); await h.sync(); } finally { await h.close(); } };
        await write('data.json', data);
        if (await fileIdentityAsync(file) !== identity) throw new Error('原片变化，索引未发布');
        await write('record.json', record);
        // 同盘目录重命名同时发布数据与完成记录；发布前的半成品留在登记任务目录。
        await fs.promises.rename(directory, path.join(this.directory, record.id));
        this.entries.set(identity, record);
        return record;
      } finally {
        await maintenance.abandon(directory); maintenance.release(directory); await maintenance.sweep();
        if (!this.maintenance) await maintenance.close();
      }
    })().finally(() => this.writes.delete(identity));
    this.writes.set(identity, task); return task;
  }
}
