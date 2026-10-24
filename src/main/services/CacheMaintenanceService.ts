import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { ChildProcess } from 'child_process';

export type CacheKind = 'playback' | 'picture' | 'index' | 'task';
type Stamp = { ino: number; dev: number; size: number; mtimeMs: number };
type Entry = { id: string; name: string; kind: CacheKind; state: 'building' | 'ready' | 'abandoned'; used: number; released: number; files: Record<string, Stamp | null>; children: number[]; spawning?: number; retry?: number; failures?: number };
interface SpawnRegistration { started: (child: ChildProcess) => Promise<void>; cancel: () => Promise<void> }
type Root = { directory: string; id: string; entries: Map<string, Entry>; owned: boolean; token: string };
export type CachePolicy = { bytes: number; count: number; ttl: number; grace: number };
const hour = 3600000;
export const CACHE_POLICIES: Record<Exclude<CacheKind, 'task'>, CachePolicy> = {
  playback: { bytes: 8 * 1024 ** 3, count: 3, ttl: 24 * hour, grace: hour / 6 },
  picture: { bytes: 512 * 1024 ** 2, count: 128, ttl: 24 * hour, grace: hour / 6 },
  index: { bytes: 256 * 1024 ** 2, count: 512, ttl: 7 * 24 * hour, grace: 0 },
};
const context = new AsyncLocalStorage<{ maintenance: CacheMaintenanceService; directory: string }>();
const instances = new Set<CacheMaintenanceService>();
const marker = '.vct-root.json', lockName = '.vct-owner.json';
const protectedName = /^(config\.json|workspace\.json|plans|walkthrough\.md|.*(?:result|report|验收|报告).*|.*\.(?:md|html|zip))$/i;
const stamp = (s: fs.Stats): Stamp => ({ ino: s.ino, dev: s.dev, size: s.size, mtimeMs: s.mtimeMs });
const same = (a: Stamp, b: Stamp) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs;
const alive = (pid: number) => { if (!Number.isSafeInteger(pid) || pid <= 0) return true; try { process.kill(pid, 0); return true; } catch (e: any) { return e.code !== 'ESRCH'; } };
const key = (s: string) => process.platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s);

/** 开发发布目录及其版本子目录统一使用仓库同级临时空间。 */
export function externalTemporaryDirectory(baseDir: string): string {
  const base = path.resolve(baseDir), parent = path.dirname(base);
  const release = path.basename(base).toLowerCase() === 'release' ? base : path.basename(parent).toLowerCase() === 'release' ? parent : undefined;
  if (release) {
    try { if (JSON.parse(fs.readFileSync(path.join(path.dirname(release), 'package.json'), 'utf8')).name === 'videocuttool') return path.resolve(release, '../../videoCutTool_tmp'); }
    catch { /* 普通便携安装位置没有源码目录，使用宿主同级临时空间。 */ }
  }
  return path.resolve(base, '../videoCutTool_tmp');
}

/** 只管理登记过的专用容器；未知文件永远不是自动清理候选。 */
export class CacheMaintenanceService {
  private roots = new Map<string, Root>();
  private references = new Map<string, number>();
  private persisted = new Map<string, { json: string; time: number }>();
  private protectedPaths = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private sweepPromise?: Promise<unknown>;
  private timer?: ReturnType<typeof setInterval>;
  private scheduled?: ReturnType<typeof setTimeout>;
  private closed = false;
  readonly issues: Array<{ path: string; reason: string }> = [];
  lastSweep = { checked: 0, deleted: 0, logicalBytes: 0, protected: 0, active: 0, delayed: 0, errors: 0, durationMs: 0 };
  constructor(readonly registryDirectory: string, private options: { now?: () => number; policies?: Partial<Record<Exclude<CacheKind, 'task'>, CachePolicy>>; busy?: () => boolean } = {}) { instances.add(this); }
  private now() { return (this.options.now ?? Date.now)(); }
  protect(...files: string[]) { files.forEach(file => this.protectedPaths.add(key(file))); }
  private guarded(file: string) { const target = key(file); return [...this.protectedPaths].some(item => target === item || target.startsWith(item + path.sep) || item.startsWith(target + path.sep)); }
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.then(work); this.queue = next.catch(() => {}); return next; }
  private report(file: string, error: unknown) { const reason = error instanceof Error ? error.message : String(error); this.issues.push({ path: file, reason }); if (this.issues.length > 128) this.issues.shift(); console.warn('缓存维护暂缓：', file, reason); }
  private async safePath(file: string) {
    const absolute = path.resolve(file), parsed = path.parse(absolute);
    let current = parsed.root;
    for (const part of absolute.slice(parsed.root.length).split(path.sep)) {
      current = path.join(current, part);
      const s = await fs.promises.lstat(current).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
      if (s?.isSymbolicLink()) throw new Error('路径含链接或联接点');
    }
    const real = await fs.promises.realpath(absolute).catch((e: any) => { if (e.code === 'ENOENT') return absolute; throw e; });
    if (key(real) !== key(absolute)) throw new Error('真实路径与登记路径不一致');
  }
  private async write(file: string, value: unknown) {
    await this.safePath(path.dirname(file));
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.promises.writeFile(temporary, JSON.stringify(value), { flag: 'wx' }); await fs.promises.rename(temporary, file); }
    finally { await fs.promises.unlink(temporary).catch((e: any) => { if (e.code !== 'ENOENT') this.report(temporary, e); }); }
  }
  private recordPath(root: Root, entry: Entry) { return path.join(root.directory, `.vct-entry-${entry.id}.json`); }
  private remembered(root: Root, entry: Entry) { this.persisted.set(key(this.recordPath(root, entry)), { json: JSON.stringify(entry), time: this.now() }); }
  private async save(root: Root, entry: Entry) { await this.write(this.recordPath(root, entry), entry); this.remembered(root, entry); }
  private async claim(directory: string, id?: string): Promise<Root> {
    const absolute = path.resolve(directory);
    await this.safePath(absolute);
    await fs.promises.mkdir(absolute, { recursive: true });
    const rootMarker = path.join(absolute, marker);
    await this.safePath(rootMarker);
    let identity: { id: string; version: number };
    try { identity = JSON.parse(await fs.promises.readFile(rootMarker, 'utf8')); }
    catch (e: any) {
      if (e.code !== 'ENOENT' || id) throw new Error('受控根登记缺失或损坏');
      identity = { version: 1, id: randomUUID() };
      await fs.promises.writeFile(rootMarker, JSON.stringify(identity), { flag: 'wx' });
    }
    if (identity.version !== 1 || !/^[a-f0-9-]{36}$/.test(identity.id) || (id && id !== identity.id)) throw new Error('受控根身份不匹配');
    const root: Root = { directory: absolute, id: identity.id, entries: new Map(), owned: false, token: randomUUID() };
    const lock = path.join(absolute, lockName);
    await this.safePath(lock);
    try {
      const previous = JSON.parse(await fs.promises.readFile(lock, 'utf8'));
      if (alive(previous.pid)) return root;
      const before = await fs.promises.stat(lock);
      const current = JSON.parse(await fs.promises.readFile(lock, 'utf8'));
      if (!previous.token || current.token !== previous.token || !same(stamp(before), stamp(await fs.promises.stat(lock)))) return root;
      await fs.promises.unlink(lock);
    } catch (e: any) { if (e.code !== 'ENOENT') { this.report(lock, e); return root; } }
    try { await fs.promises.writeFile(lock, JSON.stringify({ pid: process.pid, token: root.token }), { flag: 'wx' }); root.owned = true; }
    catch (e: any) { if (e.code !== 'EEXIST') this.report(lock, e); return root; }
    for (const name of await fs.promises.readdir(absolute)) {
      if (!/^\.vct-entry-[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const file = path.join(absolute, name); await this.safePath(file);
        const entry = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Entry;
        if (name !== `.vct-entry-${entry.id}.json` || !/^asset_[a-f0-9-]{36}(\.(mp4|png|json))?$/.test(entry.name) || !['playback', 'picture', 'index', 'task'].includes(entry.kind) || !['building', 'ready', 'abandoned'].includes(entry.state) || !Number.isFinite(entry.used) || !Number.isFinite(entry.released) || !entry.files || !Array.isArray(entry.children)) throw new Error('资产登记不合法');
        if (typeof entry.files !== 'object' || Array.isArray(entry.files) || entry.children.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('资产文件或进程登记不合法');
        if (entry.spawning !== undefined && (!Number.isSafeInteger(entry.spawning) || entry.spawning < 0)) throw new Error('待启动进程登记不合法');
        if (entry.kind === 'task') {
          if (path.extname(entry.name) || Object.keys(entry.files).some(file => path.basename(file) !== file || protectedName.test(file))) throw new Error('任务文件登记不合法');
        } else if (entry.state === 'ready') {
          const identity = entry.files[''];
          if (!identity || Object.keys(entry.files).length !== 1 || !['ino','dev','size','mtimeMs'].every(field => Number.isFinite(identity[field as keyof Stamp]))) throw new Error('已就绪缓存缺少文件身份');
        }
        root.entries.set(entry.name, entry);
        this.remembered(root, entry);
      } catch (e) { this.report(path.join(absolute, name), e); }
    }
    return root;
  }
  /** 现有未登记文件不认领，所有新资产使用 UUID 容器。 */
  async registerRoot(directory: string) {
    await this.serial(async () => {
      if (this.roots.has(key(directory))) return;
      const root = await this.claim(directory);
      if (!root.owned) throw new Error('缓存根正由其他进程使用或无法确认归属');
      this.roots.set(key(directory), root);
      await fs.promises.mkdir(this.registryDirectory, { recursive: true });
      const pointer = path.join(this.registryDirectory, `${root.id}.json`);
      await this.write(pointer, { version: 1, id: root.id, directory: root.directory });
    });
  }
  async discover() {
    await fs.promises.mkdir(this.registryDirectory, { recursive: true });
    for (const name of await fs.promises.readdir(this.registryDirectory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const pointer = path.join(this.registryDirectory, name); await this.safePath(pointer);
        const item = JSON.parse(await fs.promises.readFile(pointer, 'utf8'));
        if (item.version !== 1 || name !== `${item.id}.json` || !path.isAbsolute(item.directory) || path.basename(item.directory) !== 'managed' || !['playback_cache', 'preview_cache', 'cache', 'slices', 'stream_indexes', 'index-staging'].includes(path.basename(path.dirname(item.directory)))) throw new Error('历史根登记不合法');
        await this.serial(async () => { if (!this.roots.has(key(item.directory))) { const root = await this.claim(item.directory, item.id); if (root.owned) this.roots.set(key(item.directory), root); } });
      } catch (e) { this.report(name, e); }
    }
  }
  private root(directory: string) { const root = this.roots.get(key(directory)); if (!root?.owned) throw new Error('缓存根未取得所有权'); return root; }
  async find(directory: string, cacheId: string, kind: CacheKind) {
    return this.serial(async () => {
      const root = this.root(directory);
      for (const entry of [...root.entries.values()].sort((a, b) => b.used - a.used)) {
        if (entry.kind !== kind || entry.state !== 'ready' || (entry as Entry & { cacheId?: string }).cacheId !== cacheId) continue;
        const file = path.join(directory, entry.name);
        try { await this.safePath(file); if (entry.files[''] && same(entry.files['']!, stamp(await fs.promises.stat(file)))) return entry.name; }
        catch (e) { this.report(file, e); }
      }
    });
  }
  async create(directory: string, kind: CacheKind, extension: string, cacheId?: string) {
    if (!(kind === 'task' ? extension === '' : /^\.(mp4|png|json)$/.test(extension))) throw new Error('缓存扩展名不合法');
    return this.serial(async () => {
      const root = this.root(directory), id = randomUUID(), name = `asset_${id}${extension}`;
      const entry: Entry & { cacheId?: string } = { id, name, kind, state: 'building', used: this.now(), released: this.now(), files: {}, children: [], cacheId };
      await this.save(root, entry); root.entries.set(name, entry);
      const target = path.join(directory, name);
      this.references.set(key(target), 1);
      if (kind === 'task') await fs.promises.mkdir(target);
      return target;
    });
  }
  async pin(file: string): Promise<() => void> {
    if (this.closed) throw new Error('缓存维护已关闭');
    await this.serial(async () => { this.references.set(key(file), (this.references.get(key(file)) ?? 0) + 1); });
    let released = false;
    return () => { if (!released) { released = true; this.release(file); } };
  }
  release(file: string) {
    if (this.closed) { const count = this.references.get(key(file)) ?? 0; if (count > 1) this.references.set(key(file), count - 1); else this.references.delete(key(file)); return; }
    void this.serial(async () => {
      const count = this.references.get(key(file)) ?? 0;
      if (count > 1) this.references.set(key(file), count - 1); else this.references.delete(key(file));
      const root = this.roots.get(key(path.dirname(file))), entry = root?.entries.get(path.basename(file));
      if (root && entry) {
        entry.used = this.now();
        if (count <= 1) { entry.released = this.now(); await this.save(root, entry); }
        else if (this.now() - (this.persisted.get(key(this.recordPath(root, entry)))?.time ?? 0) >= 30000) await this.save(root, entry);
      }
    }).catch(e => this.report(file, e));
    this.schedule();
  }
  async touch(file: string) {
    await this.serial(async () => { const root = this.root(path.dirname(file)), entry = root.entries.get(path.basename(file)); if (entry) { entry.used = this.now(); if (this.now() - (this.persisted.get(key(this.recordPath(root, entry)))?.time ?? 0) >= 30000) await this.save(root, entry); } });
  }
  async valid(file: string) {
    return this.serial(async () => { const root = this.root(path.dirname(file)), entry = root.entries.get(path.basename(file)); await this.safePath(file); return Boolean(entry?.state === 'ready' && entry.files[''] && same(entry.files['']!, stamp(await fs.promises.stat(file)))); });
  }
  async ready(file: string) {
    await this.serial(async () => {
      const root = this.root(path.dirname(file)), entry = root.entries.get(path.basename(file))!;
      await this.safePath(file);
      entry.files[''] = stamp(await fs.promises.stat(file)); entry.state = 'ready'; entry.used = this.now();
      await this.save(root, entry);
    });
  }
  async abandon(file: string) {
    await this.serial(async () => { const root = this.root(path.dirname(file)), entry = root.entries.get(path.basename(file)); if (entry) { entry.state = 'abandoned'; await this.save(root, entry); } });
    this.schedule();
  }
  async allowTaskFile(directory: string, file: string) {
    await this.serial(async () => {
      const root = this.root(path.dirname(directory)), entry = root.entries.get(path.basename(directory));
      if (!entry || entry.kind !== 'task' || key(path.dirname(file)) !== key(directory) || protectedName.test(path.basename(file))) throw new Error('任务产物不在允许范围');
      entry.files[path.basename(file)] = null; await this.save(root, entry);
    });
  }
  async task<T>(directory: string, work: () => Promise<T>) { return context.run({ maintenance: this, directory }, work); }
  /** spawn 前先写不确定状态；中途崩溃时宁可保留，不能漏掉孤立媒体进程。 */
  async trackSpawn(directory: string, args: string[]): Promise<SpawnRegistration> {
    const root = this.root(path.dirname(directory)), entry = root.entries.get(path.basename(directory))!;
    const output = args.at(-1);
    let settled = false;
    const settle = (child?: ChildProcess) => {
      if (settled) return Promise.resolve();
      settled = true;
      if (child) child.once('close', () => { void this.serial(async () => { entry.children = entry.children.filter(pid => pid !== child.pid); await this.save(root, entry); }).catch(e => this.report(directory, e)); });
      return this.serial(async () => {
        if (child?.pid) entry.children.push(child.pid);
        entry.spawning = Math.max(0, (entry.spawning ?? 0) - 1);
        await this.save(root, entry);
      });
    };
    await this.serial(async () => {
      if (entry.kind === 'task' && output && key(path.dirname(output)) === key(directory) && !protectedName.test(path.basename(output))) entry.files[path.basename(output)] = null;
      entry.spawning = (entry.spawning ?? 0) + 1; await this.save(root, entry);
    }).catch(async error => { await settle().catch(e => this.report(directory, e)); throw error; });
    return { started: child => settle(child), cancel: () => settle() };
  }
  related(args: string[]) {
    const targets = new Set<string>();
    for (const arg of args) if (path.isAbsolute(arg)) for (const root of this.roots.values()) {
      const relative = path.relative(root.directory, arg), name = relative.split(path.sep)[0];
      if (!relative.startsWith('..') && root.entries.has(name)) targets.add(path.join(root.directory, name));
    }
    return targets;
  }
  schedule() { if (this.closed || this.scheduled) return; this.scheduled = setTimeout(() => { this.scheduled = undefined; void this.sweep(); }, 250); this.scheduled.unref(); }
  start() { this.schedule(); this.timer = setInterval(() => this.schedule(), 5 * 60000); this.timer.unref(); }
  async sweep() {
    if (this.closed) return;
    if (this.sweepPromise) return this.sweepPromise;
    this.sweepPromise = this.sweepOnce().catch(e => this.report(this.registryDirectory, e)).finally(() => { this.sweepPromise = undefined; });
    return this.sweepPromise;
  }
  private async sweepOnce() {
    const started = performance.now();
    const statistics = { checked: 0, deleted: 0, logicalBytes: 0, protected: 0, active: 0, delayed: 0, errors: 0, durationMs: 0 };
    const totals = new Map<CacheKind, { bytes: number; count: number }>();
    const entries = [...this.roots.values()].flatMap(root => [...root.entries.values()].map(entry => ({ root, entry }))).sort((a, b) => a.entry.used - b.entry.used);
    for (const { entry } of entries) if (entry.kind !== 'task' && entry.state === 'ready') { const total = totals.get(entry.kind) ?? { bytes: 0, count: 0 }; total.bytes += entry.files['']?.size ?? 0; total.count++; totals.set(entry.kind, total); }
    let checked = 0;
    for (const { root, entry } of entries) {
      if (this.closed) break;
      if (++checked % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      await this.serial(async () => {
        const file = path.join(root.directory, entry.name), now = this.now();
        statistics.checked++;
        if (!root.entries.has(entry.name)) return;
        if (this.guarded(file)) { statistics.protected++; return; }
        if (this.references.has(key(file)) || entry.children.some(alive)) { statistics.active++; return; }
        if (entry.spawning || (entry.retry ?? 0) > now) {
          statistics.delayed++;
          if (entry.spawning && !this.issues.some(issue => issue.path === file)) this.report(file, '媒体进程登记未闭环，不能确认无人使用');
          return;
        }
        if (entry.state === 'ready' && entry.kind !== 'task') {
          if (entry.kind === 'index') { statistics.protected++; return; }
          if (this.options.busy?.()) { statistics.delayed++; return; }
          const policy = this.options.policies?.[entry.kind] ?? CACHE_POLICIES[entry.kind], total = totals.get(entry.kind)!;
          if (now - entry.released < policy.grace || (now - entry.used < policy.ttl && total.bytes <= policy.bytes && total.count <= policy.count)) { statistics.delayed++; return; }
        }
        try {
          let removedBytes = 0;
          await this.safePath(file); await this.safePath(this.recordPath(root, entry));
          await this.safePath(path.join(root.directory, lockName)); await this.safePath(path.join(root.directory, marker));
          const owner = JSON.parse(await fs.promises.readFile(path.join(root.directory, lockName), 'utf8'));
          const identity = JSON.parse(await fs.promises.readFile(path.join(root.directory, marker), 'utf8'));
          if (owner.token !== root.token || identity.id !== root.id) throw new Error('受控根所有权发生变化');
          const disk = JSON.parse(await fs.promises.readFile(this.recordPath(root, entry), 'utf8'));
          if (JSON.stringify(disk) !== this.persisted.get(key(this.recordPath(root, entry)))?.json) throw new Error('资产登记已变化');
          const s = await fs.promises.lstat(file).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
          if (s && entry.kind === 'task') {
            if (!s.isDirectory()) throw new Error('任务目录类型发生变化');
            const files = await fs.promises.readdir(file);
            for (const name of files) { const target = path.join(file, name); await this.safePath(target); const item = await fs.promises.lstat(target); if (protectedName.test(name) || this.guarded(target) || !Object.prototype.hasOwnProperty.call(entry.files, name) || !item.isFile() || item.isSymbolicLink()) throw new Error('任务目录含未登记或受保护内容'); }
            const snapshots = new Map<string, Stamp>();
            for (const name of files) snapshots.set(name, stamp(await fs.promises.stat(path.join(file, name))));
            removedBytes = [...snapshots.values()].reduce((total, item) => total + item.size, 0);
            for (const name of files) { const target = path.join(file, name); await this.safePath(target); if (!same(snapshots.get(name)!, stamp(await fs.promises.stat(target)))) throw new Error('中间文件已变化'); await fs.promises.unlink(target); }
            await fs.promises.rmdir(file);
          } else if (s) {
            if (!s.isFile() || (entry.files[''] && !same(entry.files['']!, stamp(s)))) throw new Error('缓存身份发生变化');
            await fs.promises.unlink(file);
            removedBytes = s.size;
          }
          await fs.promises.unlink(this.recordPath(root, entry)); root.entries.delete(entry.name);
          this.persisted.delete(key(this.recordPath(root, entry)));
          statistics.deleted++; statistics.logicalBytes += removedBytes;
          const total = totals.get(entry.kind); if (total) { total.bytes -= entry.files['']?.size ?? 0; total.count--; }
        } catch (e) { statistics.errors++; entry.failures = (entry.failures ?? 0) + 1; entry.retry = now + Math.min(hour, 30000 * 2 ** Math.min(entry.failures, 7)); this.report(file, e); await this.save(root, entry); }
      });
    }
    statistics.durationMs = performance.now() - started;
    this.lastSweep = statistics;
    if (statistics.deleted || statistics.errors) console.info('缓存维护完成（字节数为逻辑大小）：', statistics);
  }
  async close() {
    instances.delete(this);
    this.closed = true; if (this.timer) clearInterval(this.timer); if (this.scheduled) clearTimeout(this.scheduled);
    await this.sweepPromise; await this.queue;
    for (const root of this.roots.values()) if (root.owned) {
      for (const entry of root.entries.values()) if (JSON.stringify(entry) !== this.persisted.get(key(this.recordPath(root, entry)))?.json) await this.save(root, entry).catch(e => this.report(root.directory, e));
      // 退出中的媒体流可能仍持有句柄，保留进程锁直到进程真正结束。
      if ([...this.references].some(([file, count]) => count > 0 && file.startsWith(key(root.directory) + path.sep)) || [...root.entries.values()].some(entry => entry.spawning || entry.children.some(alive))) continue;
      const lock = path.join(root.directory, lockName);
      try { await this.safePath(lock); const owner = JSON.parse(await fs.promises.readFile(lock, 'utf8')); if (owner.token === root.token) await fs.promises.unlink(lock); } catch (e: any) { if (e.code !== 'ENOENT') this.report(lock, e); }
    }
  }
}

export async function registerMediaSpawn(args: string[]): Promise<SpawnRegistration> {
  const owner = context.getStore(), registrations: SpawnRegistration[] = [];
  try {
    for (const maintenance of instances) {
      const targets = maintenance.related(args);
      if (owner?.maintenance === maintenance) targets.add(owner.directory);
      for (const target of targets) registrations.push(await maintenance.trackSpawn(target, args));
    }
  } catch (error) {
    await Promise.allSettled(registrations.map(registration => registration.cancel()));
    throw error;
  }
  return {
    started: async child => { await Promise.all(registrations.map(registration => registration.started(child))); },
    cancel: async () => { await Promise.all(registrations.map(registration => registration.cancel())); },
  };
}
