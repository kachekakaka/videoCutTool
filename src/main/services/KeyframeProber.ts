import path from 'path';
import fs from 'fs';
import { PreviewCache } from './PreviewCache';
import { CacheMaintenanceService, externalTemporaryDirectory } from './CacheMaintenanceService';
import { KeyframePoint, MediaMetadata, MediaTime } from '../../shared/types';
import { ceilMicroseconds, compareTime, formatMicroseconds, frameTime, millisecondsTime, rational, timeMs } from '../../shared/mediaTime';
import { abortError, consumeJob, fileIdentityAsync, MediaLimiter, probeFile, ProbedFile, resolveTool, runMediaTool, SharedJob } from './MediaTools';

interface FrameIndex { version: 5; identity: string; points: KeyframePoint[] }
export class KeyframeProber {
  private ffprobePath: string;
  private cache: PreviewCache;
  private pending = new Map<string, SharedJob<FrameIndex>>();
  private limiter = new MediaLimiter(() => 1);
  private frameWindows = new Map<string, { points: number[]; center: number }>();
  private closing = false;
  constructor(preferredPath?: string, baseDir = process.cwd(), maintenance?: CacheMaintenanceService) {
    this.ffprobePath = resolveTool('ffprobe', preferredPath);
    const external = externalTemporaryDirectory(baseDir);
    this.cache = new PreviewCache(path.join(external, 'cache'), 'index', maintenance);
  }
  updateTool(preferredPath?: string) { this.ffprobePath = resolveTool('ffprobe', preferredPath); this.frameWindows.clear(); }
  async shutdown() { this.closing = true; await Promise.all([...this.pending.values()].map(job => { job.controller.abort(); return job.promise.catch(() => {}); })); }
  private async readIndex(identity: string): Promise<FrameIndex | null> {
    const use = await this.cache.lookup(identity);
    if (!use) return null;
    try {
      const file = use.file;
      if ((await fs.promises.stat(file)).size > 64 * 1024 ** 2) return null;
      const data = JSON.parse(await fs.promises.readFile(file, 'utf8')) as FrameIndex;
      if (data.version !== 5 || data.identity !== identity || !data.points.length || data.points.length > 500000) return null;
      for (const point of data.points) {
        if (!Number.isFinite(point.timeMs) || BigInt(point.time.denominator) <= 0n || !Number.isFinite(timeMs(point.time)) || Math.abs(timeMs(point.time) - point.timeMs) > 0.000001) return null;
      }
      if (data.points.some((point, index) => index > 0 && compareTime(data.points[index - 1].time, point.time) >= 0)) return null;
      return data;
    } catch { return null; } finally { use.release(); }
  }
  private async scan(file: string, info: ProbedFile, tool: string, signal: AbortSignal, full = false): Promise<{ points: KeyframePoint[]; missing: boolean }> {
    let tail = '', missing = false;
    const frames: Array<Record<string, string>> = [];
    const line = (text: string) => {
      if (!/(?:^|\|)key_frame=1(?:\||$)/.test(text)) return;
      const frame = Object.fromEntries([...text.matchAll(/(?:^|\|)(pts|best_effort_timestamp)=(-?\d+)/g)].map(match => [match[1], match[2]]));
      if (!frame.pts || !frame.best_effort_timestamp) missing = true;
      frames.push(frame);
      if (frames.length > 500000) throw new Error('关键帧数量超过安全上限，请使用较短素材');
    };
    await runMediaTool(tool, ['-v', 'error', '-select_streams', String(info.videoIndex), ...(!full ? ['-skip_frame', 'nokey'] : []), '-show_frames', '-show_entries', 'frame=key_frame,best_effort_timestamp,pts', '-of', 'compact=p=0', file], {
      signal, captureOutput: false, onOutput: chunk => {
        const lines = (tail + chunk).split(/\r?\n/); tail = lines.pop() || '';
        if (tail.length > 16384) throw new Error('媒体扫描输出格式异常');
        lines.forEach(line);
      },
    });
    if (tail) line(tail);
    return { points: this.parseFrames(frames, info), missing };
  }
  private async getIndex(file: string, info: ProbedFile, tool: string, signal?: AbortSignal): Promise<FrameIndex> {
    if (this.closing || signal?.aborted) throw abortError();
    const sourceIdentity = await fileIdentityAsync(file), identity = `${tool}:${sourceIdentity}`;
    const cached = await this.readIndex(identity);
    if (this.closing || signal?.aborted) throw abortError();
    if (cached) return cached;
    let job = this.pending.get(identity);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      const created: SharedJob<FrameIndex> = { controller, consumers: new Set(), promise: Promise.resolve(null as any) };
      created.promise = this.limiter.run(async () => {
        if (this.closing) throw abortError();
        let result = await this.scan(file, info, tool, controller.signal);
        if (!result.points.length || result.missing) result = await this.scan(file, info, tool, controller.signal, true);
        if (!result.points.length) throw new Error('没有取得有效关键帧时间戳，请检查素材或媒体工具后重试');
        if (await fileIdentityAsync(file) !== sourceIdentity) throw new Error('扫描期间源视频发生变化，请重新载入');
        const index: FrameIndex = { version: 5, identity, points: result.points };
        if (controller.signal.aborted || this.closing) throw abortError();
        const use = await this.cache.acquire(identity, '.json');
        try { if (use.fresh) { await fs.promises.writeFile(use.file, JSON.stringify(index), { flag: 'wx' }); await this.cache.maintenance.ready(use.file); } }
        catch (error) { await this.cache.fail(use); throw error; }
        finally { use.release(); this.cache.maintenance.schedule(); }
        return index;
      }, controller.signal).finally(() => { if (this.pending.get(identity) === created) this.pending.delete(identity); });
      job = created; this.pending.set(identity, job);
    }
    return consumeJob(job, signal);
  }
  private parseFrames(frames: any[], info: ProbedFile): KeyframePoint[] {
    const unique = new Map<string, KeyframePoint>();
    for (const frame of frames || []) {
      const ticks = frame.best_effort_timestamp ?? frame.pts;
      if (typeof ticks === 'number' && !Number.isSafeInteger(ticks)) throw new Error('素材时间戳超出无损整数范围，无法精确寻址');
      if (ticks === undefined || !/^-?\d+$/.test(String(ticks))) continue;
      const time = frameTime(ticks, info.timeBase, info.origin), ms = timeMs(time);
      if (!Number.isFinite(ms) || ms > info.durationMs + 1000) continue;
      unique.set(`${time.numerator}/${time.denominator}`, { time, timeMs: ms });
    }
    return [...unique.values()].sort((a, b) => compareTime(a.time, b.time));
  }
  async probeBasic(file: string, signal?: AbortSignal): Promise<MediaMetadata> {
    this.cache.maintenance.protect(file);
    if (this.closing) throw abortError();
    const tool = this.ffprobePath, info = await probeFile(file, tool, signal);
    const index = await this.readIndex(`${tool}:${await fileIdentityAsync(file)}`);
    if (this.closing || signal?.aborted) throw abortError();
    return this.toMetadata(file, info, index?.points);
  }
  async probeKeyframes(file: string, signal?: AbortSignal): Promise<number[]> {
    this.cache.maintenance.protect(file);
    if (this.closing || signal?.aborted) throw abortError();
    const tool = this.ffprobePath, info = await probeFile(file, tool, signal);
    return (await this.getIndex(file, info, tool, signal)).points.map(point => Math.max(0, point.timeMs));
  }
  async probe(file: string, signal?: AbortSignal): Promise<MediaMetadata> {
    this.cache.maintenance.protect(file);
    if (this.closing || signal?.aborted) throw abortError();
    const tool = this.ffprobePath, info = await probeFile(file, tool, signal);
    return this.toMetadata(file, info, (await this.getIndex(file, info, tool, signal)).points);
  }
  private toMetadata(file: string, info: ProbedFile, points?: KeyframePoint[]): MediaMetadata {
    return { filePath: file, fileName: path.basename(file), durationMs: info.durationMs, width: info.width, height: info.height, displayAspectRatio: info.displayAspectRatio, fps: info.fps, keyframes: points?.map(point => Math.max(0, point.timeMs)) || [0], keyframePoints: points, timeOrigin: info.origin, streams: info.streams };
  }
  async adjacentFrame(file: string, currentMs: number, direction: number): Promise<number> {
    this.cache.maintenance.protect(file);
    if (this.closing || !Number.isFinite(currentMs) || currentMs < 0 || ![-1, 1].includes(direction)) throw new Error('逐帧参数无效');
    const tool = this.ffprobePath, identity = `${tool}:${await fileIdentityAsync(file)}`;
    const cached = this.frameWindows.get(identity);
    const nextFrom = (points: number[]) => direction > 0 ? points.find(point => point > currentMs + 0.01) : [...points].reverse().find(point => point < currentMs - 0.01);
    if (cached && Math.abs(cached.center - currentMs) < 1800) { const target = nextFrom(cached.points); if (target !== undefined) return target; }
    const info = await probeFile(file, tool);
    const relative = millisecondsTime(Math.max(0, currentMs - 2000));
    const absolute: MediaTime = rational(BigInt(relative.numerator) * BigInt(info.origin.denominator) + BigInt(info.origin.numerator) * BigInt(relative.denominator), BigInt(relative.denominator) * BigInt(info.origin.denominator));
    const end = millisecondsTime(Math.min(info.durationMs + 1000, currentMs + 3000));
    const absoluteEnd = rational(BigInt(end.numerator) * BigInt(info.origin.denominator) + BigInt(info.origin.numerator) * BigInt(end.denominator), BigInt(end.denominator) * BigInt(info.origin.denominator));
    const output = await runMediaTool(tool, ['-v', 'error', '-select_streams', String(info.videoIndex), '-read_intervals', `${formatMicroseconds(ceilMicroseconds(absolute))}%${formatMicroseconds(ceilMicroseconds(absoluteEnd))}`, '-show_frames', '-show_entries', 'frame=best_effort_timestamp,pts', '-of', 'json', file], { timeoutMs: 30000 });
    const points = this.parseFrames(JSON.parse(output).frames, info).map(point => Math.max(0, point.timeMs));
    this.frameWindows.set(identity, { center: currentMs, points });
    if (this.frameWindows.size > 3) this.frameWindows.delete(this.frameWindows.keys().next().value!);
    if (!points.length) throw new Error('未能读取当前位置附近的展示帧');
    return nextFrom(points) ?? (direction > 0 ? Math.max(currentMs, points[points.length - 1]) : points[0]);
  }
}
