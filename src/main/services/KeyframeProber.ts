import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { KeyframePoint, MediaMetadata, MediaTime } from '../../shared/types';
import { ceilMicroseconds, compareTime, formatMicroseconds, frameTime, millisecondsTime, rational, timeMs } from '../../shared/mediaTime';
import { fileIdentity, probeFile, ProbedFile, resolveTool, runMediaTool } from './MediaTools';

interface FrameIndex { version: 4; identity: string; points: KeyframePoint[] }
export class KeyframeProber {
  private ffprobePath: string;
  private cacheDir: string;
  private pending = new Map<string, Promise<FrameIndex>>();
  private frameWindows = new Map<string, { points: number[]; center: number }>();
  constructor(preferredPath?: string, baseDir = process.cwd()) {
    this.ffprobePath = resolveTool('ffprobe', preferredPath);
    const external = path.basename(baseDir).toLowerCase() === 'release' ? path.resolve(baseDir, '../../videoCutTool_tmp') : path.resolve(baseDir, '../videoCutTool_tmp');
    this.cacheDir = path.join(external, 'cache');
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }
  updateTool(preferredPath?: string) { this.ffprobePath = resolveTool('ffprobe', preferredPath); this.frameWindows.clear(); }
  private cachePath(identity: string) { return path.join(this.cacheDir, `kfs_v4_${crypto.createHash('sha256').update(identity).digest('hex')}.json`); }
  private readIndex(identity: string): FrameIndex | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.cachePath(identity), 'utf8')) as FrameIndex;
      if (data.version !== 4 || data.identity !== identity || !data.points.length) return null;
      for (const point of data.points) {
        if (!Number.isFinite(point.timeMs) || BigInt(point.time.denominator) <= 0n || !Number.isFinite(timeMs(point.time)) || Math.abs(timeMs(point.time) - point.timeMs) > 0.000001) return null;
      }
      if (data.points.some((point, index) => index > 0 && compareTime(data.points[index - 1].time, point.time) >= 0)) return null;
      return data;
    } catch { return null; }
  }
  private async getIndex(file: string, info?: ProbedFile): Promise<FrameIndex> {
    const identity = fileIdentity(file), cached = this.readIndex(identity);
    if (cached) return cached;
    const inFlight = this.pending.get(identity);
    if (inFlight) return inFlight;
    const task = (async () => {
      const metadata = info || await probeFile(file, this.ffprobePath);
      const output = await runMediaTool(this.ffprobePath, ['-v', 'error', '-select_streams', String(metadata.videoIndex), '-skip_frame', 'nokey', '-show_frames', '-show_entries', 'frame=best_effort_timestamp,pts', '-of', 'json', file]);
      let frames = JSON.parse(output).frames || [];
      // AVI 等素材没有 PTS 时，跳帧解码会把较晚的 DTS 当作展示时间，必须完整解码恢复顺序。
      if (!frames.length || frames.some((frame: any) => frame.pts === undefined || frame.best_effort_timestamp === undefined)) {
        const decoded = await runMediaTool(this.ffprobePath, ['-v', 'error', '-select_streams', String(metadata.videoIndex), '-show_frames', '-show_entries', 'frame=key_frame,best_effort_timestamp,pts', '-of', 'compact=p=0', file]);
        frames = decoded.split(/\r?\n/).filter(line => /(?:^|\|)key_frame=1(?:\||$)/.test(line)).map(line => Object.fromEntries([...line.matchAll(/(?:^|\|)(pts|best_effort_timestamp)=(-?\d+)/g)].map(match => [match[1], match[2]])));
      }
      const points = this.parseFrames(frames, metadata);
      if (!points.length) throw new Error('没有取得有效关键帧时间戳，请检查素材或媒体工具后重试');
      const result: FrameIndex = { version: 4, identity, points };
      if (fileIdentity(file) !== identity) throw new Error('扫描期间源视频发生变化，请重新载入');
      await fs.promises.writeFile(this.cachePath(identity), JSON.stringify(result), 'utf8');
      return result;
    })();
    this.pending.set(identity, task);
    try { return await task; } finally { this.pending.delete(identity); }
  }
  private parseFrames(frames: any[], info: ProbedFile): KeyframePoint[] {
    const unique = new Map<string, KeyframePoint>();
    for (const frame of frames || []) {
      const ticks = frame.best_effort_timestamp ?? frame.pts;
      if (typeof ticks === 'number' && !Number.isSafeInteger(ticks)) throw new Error('素材时间戳超出无损整数范围，无法精确寻址');
      if (ticks === undefined || !/^-?\d+$/.test(String(ticks))) continue;
      const time = frameTime(ticks, info.timeBase, info.origin);
      const ms = timeMs(time);
      if (!Number.isFinite(ms) || ms > info.durationMs + 1000) continue;
      unique.set(`${time.numerator}/${time.denominator}`, { time, timeMs: ms });
    }
    return [...unique.values()].sort((a, b) => compareTime(a.time, b.time));
  }
  async probeBasic(file: string): Promise<MediaMetadata> {
    const info = await probeFile(file, this.ffprobePath);
    const index = this.readIndex(fileIdentity(file));
    return this.toMetadata(file, info, index?.points);
  }
  async probeKeyframes(file: string): Promise<number[]> { return (await this.getIndex(file)).points.map(point => Math.max(0, point.timeMs)); }
  async probe(file: string): Promise<MediaMetadata> {
    const info = await probeFile(file, this.ffprobePath);
    return this.toMetadata(file, info, (await this.getIndex(file, info)).points);
  }
  private toMetadata(file: string, info: ProbedFile, points?: KeyframePoint[]): MediaMetadata {
    return { filePath: file, fileName: path.basename(file), durationMs: info.durationMs, width: info.width, height: info.height, fps: info.fps, keyframes: points?.map(point => Math.max(0, point.timeMs)) || [0], keyframePoints: points, timeOrigin: info.origin, streams: info.streams };
  }
  async adjacentFrame(file: string, currentMs: number, direction: number): Promise<number> {
    const identity = fileIdentity(file);
    const cached = this.frameWindows.get(identity);
    const nextFrom = (points: number[]) => direction > 0 ? points.find(point => point > currentMs + 0.01) : [...points].reverse().find(point => point < currentMs - 0.01);
    if (cached && Math.abs(cached.center - currentMs) < 1800) {
      const target = nextFrom(cached.points);
      if (target !== undefined) return target;
    }
    const info = await probeFile(file, this.ffprobePath);
    const relative = millisecondsTime(Math.max(0, currentMs - 2000));
    const absolute: MediaTime = rational(BigInt(relative.numerator) * BigInt(info.origin.denominator) + BigInt(info.origin.numerator) * BigInt(relative.denominator), BigInt(relative.denominator) * BigInt(info.origin.denominator));
    const end = millisecondsTime(Math.min(info.durationMs + 1000, currentMs + 3000));
    const absoluteEnd = rational(BigInt(end.numerator) * BigInt(info.origin.denominator) + BigInt(info.origin.numerator) * BigInt(end.denominator), BigInt(end.denominator) * BigInt(info.origin.denominator));
    const output = await runMediaTool(this.ffprobePath, ['-v', 'error', '-select_streams', String(info.videoIndex), '-read_intervals', `${formatMicroseconds(ceilMicroseconds(absolute))}%${formatMicroseconds(ceilMicroseconds(absoluteEnd))}`, '-show_frames', '-show_entries', 'frame=best_effort_timestamp,pts', '-of', 'json', file], { timeoutMs: 30000 });
    const points = this.parseFrames(JSON.parse(output).frames, info).map(point => Math.max(0, point.timeMs));
    this.frameWindows.set(identity, { center: currentMs, points });
    if (this.frameWindows.size > 3) this.frameWindows.delete(this.frameWindows.keys().next().value!);
    if (!points.length) throw new Error('未能读取当前位置附近的展示帧');
    return nextFrom(points) ?? (direction > 0 ? Math.max(currentMs, points[points.length - 1]) : 0);
  }
}
