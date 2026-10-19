import { spawn, ChildProcess, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CompressionFile, MediaStreamInfo, MediaTime } from '../../shared/types';
import { frameTime, secondsTime, timeMs } from '../../shared/mediaTime';
import { registerMediaSpawn } from './CacheMaintenanceService';

const children = new Set<ChildProcess>();
export const hasActiveMediaProcesses = () => children.size > 0;
let closing = false;
export interface SharedJob<T> { promise: Promise<T>; controller: AbortController; consumers: Set<symbol> }
export function consumeJob<T>(job: SharedJob<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  const consumer = Symbol(); job.consumers.add(consumer);
  return new Promise((resolve, reject) => {
    const cleanup = () => { job.consumers.delete(consumer); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); if (!job.consumers.size) job.controller.abort(); reject(abortError()); };
    signal?.addEventListener('abort', cancel, { once: true });
    job.promise.then(value => { cleanup(); if (signal?.aborted) reject(abortError()); else resolve(value); }, error => { cleanup(); reject(error); });
  });
}
export const abortError = () => Object.assign(new Error('操作已取消'), { name: 'AbortError' });

/** 批量创建只读有限的格式／流摘要，绝不计算精确时长。 */
export async function probeCompressionFile(file: string, ffprobe: string, signal?: AbortSignal): Promise<Pick<CompressionFile, 'width' | 'height' | 'check' | 'message'>> {
  try {
    const data = JSON.parse(await runMediaTool(ffprobe, ['-v', 'error', '-probesize', '1048576', '-analyzeduration', '1000000', '-show_entries', 'format=format_name:stream=codec_type,width,height:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation', '-of', 'json', file], { signal, timeoutMs: 3000, maxOutputBytes: 1024 * 1024 }));
    const video = data.streams?.find((stream: any) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    if (!video) {
      // 有限探测未发现视频不等于证明不存在；纯音频容器可以明确排除。
      const audioOnly = ['mp3', 'wav', 'flac', 'aac', 'aiff', 'amr'].includes(data.format?.format_name);
      return { width: null, height: null, check: audioOnly ? 'invalid' : 'pending', message: audioOnly ? '素材不包含视频流' : '尚未确认视频流，执行时检查' };
    }
    const rotation = Number(video.side_data_list?.find((item: any) => item.rotation !== undefined)?.rotation || video.tags?.rotate || 0);
    const rotated = Math.abs(rotation) % 180 === 90;
    return { width: (rotated ? video.height : video.width) || null, height: (rotated ? video.width : video.height) || null, check: 'ready' };
  } catch (error: any) {
    if (signal?.aborted || error.name === 'AbortError') throw error;
    const message = error.code === 'ENOENT' ? '未找到媒体检查工具，执行前请检查工具设置' : error.code === 'EACCES' || error.code === 'EPERM' ? '媒体检查工具无运行权限' : /超时/.test(error.message) ? '快速检查超时，执行时确认' : '暂未读到完整媒体信息，执行时确认';
    return { width: null, height: null, check: 'pending', message };
  }
}
export function resolveTool(name: 'ffmpeg' | 'ffprobe', preferred?: string): string {
  const resources = (process as any).resourcesPath;
  const candidates = [preferred, resources && path.join(resources, 'bin', `${name}.exe`), resources && path.join(resources, 'tools', `${name}.exe`), path.resolve('tools', `${name}.exe`), `D:/Tools/ffmpeg/${name}.exe`].filter(Boolean) as string[];
  return candidates.find(file => fs.existsSync(file)) || name;
}
export async function stopMediaProcesses(): Promise<void> {
  closing = true;
  await Promise.all([...children].map(child => new Promise<void>(resolve => {
    child.once('close', () => resolve());
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.kill();
  })));
}
export async function runMediaTool(executable: string, args: string[], options: { signal?: AbortSignal; timeoutMs?: number; onOutput?: (text: string) => void; maxOutputBytes?: number; captureOutput?: boolean } = {}): Promise<string> {
  if (closing || options.signal?.aborted) throw abortError();
  const track = await registerMediaSpawn(args);
  let proc: ChildProcessWithoutNullStreams;
  try {
    if (closing || options.signal?.aborted) throw abortError();
    proc = spawn(executable, args, { windowsHide: true });
  } catch (error) {
    await track.cancel().catch(reason => console.warn('媒体启动登记撤销失败：', reason));
    throw error;
  }
  return new Promise((resolve, reject) => {
    children.add(proc);
    let stdout = '', stderr = '', failure: Error | undefined;
    const tracked = track.started(proc).catch(error => { failure = error instanceof Error ? error : new Error(String(error)); proc.kill(); });
    const cancel = () => { failure = abortError(); proc.kill(); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => { failure = new Error('媒体处理超时'); proc.kill(); }, options.timeoutMs) : undefined;
    proc.stdout.on('data', chunk => {
      if (options.captureOutput !== false) stdout += chunk.toString();
      try { options.onOutput?.(chunk.toString()); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); proc.kill(); }
      if (stdout.length > (options.maxOutputBytes ?? 64 * 1024 * 1024)) { failure = new Error('媒体探测结果超过可处理大小'); proc.kill(); }
    });
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-24000); });
    proc.on('error', error => { failure = error; });
    proc.on('close', async code => {
      children.delete(proc);
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      await tracked;
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`媒体处理失败 (${code}): ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}
export interface ProbedFile {
  durationMs: number; width: number; height: number; fps: number; origin: MediaTime;
  containerDurationMs: number;
  displayAspectRatio: number;
  videoIndex: number; timeBase: string; streams: MediaStreamInfo[]; videoStartMs: number;
}
const basicJobs = new Map<string, SharedJob<ProbedFile>>();
const basicCache = new Map<string, { time: number; value: ProbedFile }>();
export async function probeFile(file: string, ffprobe: string, signal?: AbortSignal): Promise<ProbedFile> {
  if (closing || signal?.aborted) throw abortError();
  const key = `${ffprobe}:${await fileIdentityAsync(file)}`;
  if (signal?.aborted) throw abortError();
  const cached = basicCache.get(key);
  if (cached && Date.now() - cached.time < 30000) return structuredClone(cached.value);
  let job = basicJobs.get(key);
  if (!job || job.controller.signal.aborted) {
    const controller = new AbortController();
    const created: SharedJob<ProbedFile> = { controller, consumers: new Set(), promise: Promise.resolve(null as any) };
    created.promise = probeUncached(file, ffprobe, controller.signal).then(value => {
      if (!controller.signal.aborted) {
        basicCache.set(key, { time: Date.now(), value });
        if (basicCache.size > 64) basicCache.delete(basicCache.keys().next().value!);
      }
      return value;
    }).finally(() => { if (basicJobs.get(key) === created) basicJobs.delete(key); });
    job = created; basicJobs.set(key, job);
  }
  return structuredClone(await consumeJob(job, signal));
}
export function clearProbeCache() { basicCache.clear(); }
async function probeUncached(file: string, ffprobe: string, signal?: AbortSignal): Promise<ProbedFile> {
  const data = JSON.parse(await runMediaTool(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal, timeoutMs: 30000 }));
  const rawStreams = data.streams || [];
  const video = rawStreams.find((stream: any) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video) throw new Error('素材不包含可剪辑的视频流');
  const startTime = Number(data.format?.start_time || 0);
  let duration = Number(data.format?.duration || video.duration);
  // FLV 的 duration 可能是末尾绝对时间戳，也可能来自元数据，不能直接减去起点。
  // 非零起点时以实际音视频包的结束时间为准，与关键帧及播放预览统一到同一时间轴。
  if (startTime !== 0 && ['flv', 'live_flv'].includes(data.format?.format_name)) {
    const streams = new Set<number>(rawStreams
      .filter((stream: any) => (stream.codec_type === 'video' && !stream.disposition?.attached_pic) || stream.codec_type === 'audio')
      .map((stream: any) => stream.index));
    let tail = '', end = -Infinity;
    const consume = (line: string) => {
      const packet = Object.fromEntries(line.split('|').map(field => field.split('=')));
      if (!streams.has(Number(packet.stream_index))) return;
      const pts = Number(packet.pts_time);
      if (!Number.isFinite(pts)) return;
      const packetDuration = Number(packet.duration_time);
      end = Math.max(end, pts + (Number.isFinite(packetDuration) && packetDuration > 0 ? packetDuration : 0));
    };
    await runMediaTool(ffprobe, ['-v', 'error', '-show_packets', '-show_entries', 'packet=stream_index,pts_time,duration_time', '-of', 'compact=p=0', file], {
      signal, captureOutput: false, onOutput: chunk => {
        const lines = (tail + chunk).split(/\r?\n/); tail = lines.pop() || '';
        if (tail.length > 16384) throw new Error('媒体时间戳输出格式异常');
        lines.forEach(consume);
      },
    });
    if (tail) consume(tail);
    duration = end - startTime;
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确定视频时长，不能安全生成剪辑方案');
  const rate = String(video.avg_frame_rate || video.r_frame_rate || '0/1').split('/').map(Number);
  const fallback = String(video.r_frame_rate || '0/1').split('/').map(Number);
  const fps = rate[0] / rate[1] || fallback[0] / fallback[1] || 30;
  const rotation = Number(video.side_data_list?.find((item: any) => item.rotation !== undefined)?.rotation || video.tags?.rotate || 0);
  const rotated = Math.abs(rotation) % 180 === 90;
  const sarParts = String(video.sample_aspect_ratio || '1:1').split(':').map(Number);
  const sar = sarParts[0] / sarParts[1] || 1;
  const displayRatio = video.width * sar / video.height;
  return {
    durationMs: Math.round(duration * 1000), containerDurationMs: duration * 1000, width: rotated ? video.height : video.width, height: rotated ? video.width : video.height,
    fps, videoIndex: video.index, timeBase: video.time_base, videoStartMs: (Number(video.start_time || 0) - Number(data.format?.start_time || 0)) * 1000,
    displayAspectRatio: rotated ? 1 / displayRatio : displayRatio,
    origin: secondsTime(String(data.format?.start_time ?? '0')),
    streams: rawStreams.map((stream: any) => ({ index: stream.index, type: stream.codec_type, codec: stream.codec_name, language: stream.tags?.language, attachedPicture: Boolean(stream.disposition?.attached_pic), default: Boolean(stream.disposition?.default) })),
  };
}
export function fileIdentity(file: string): string {
  const stat = fs.statSync(file);
  return `${path.resolve(file)}:${stat.size}:${stat.mtimeMs}`;
}
export async function fileIdentityAsync(file: string): Promise<string> {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new Error('素材路径不是普通文件');
  return `${path.resolve(file)}:${stat.size}:${stat.mtimeMs}`;
}
/** 用解码后的首个展示帧校准播放副本，兼容缺少包 PTS 的 AVI。 */
export async function presentationStartTime(file: string, info: ProbedFile, ffprobe: string, signal?: AbortSignal): Promise<MediaTime> {
  const result = JSON.parse(await runMediaTool(ffprobe, ['-v', 'error', '-select_streams', String(info.videoIndex), '-read_intervals', '%+#64', '-show_frames', '-show_entries', 'frame=best_effort_timestamp,pts', '-of', 'json', file], { signal, timeoutMs: 30000 }));
  const first = result.frames?.find((frame: any) => Number.isSafeInteger(frame.best_effort_timestamp ?? frame.pts));
  if (!first) throw new Error('无法确定首个展示帧时间，不能校准媒体时间');
  return frameTime(first.best_effort_timestamp ?? first.pts, info.timeBase, info.origin);
}
export async function presentationStart(file: string, info: ProbedFile, ffprobe: string, signal?: AbortSignal): Promise<number> {
  return timeMs(await presentationStartTime(file, info, ffprobe, signal));
}
export async function needsTimestampRepair(file: string, info: ProbedFile, ffprobe: string, signal?: AbortSignal): Promise<boolean> {
  const result = JSON.parse(await runMediaTool(ffprobe, ['-v', 'error', '-select_streams', String(info.videoIndex), '-read_intervals', '%+#64', '-show_packets', '-show_entries', 'packet=pts', '-of', 'json', file], { signal, timeoutMs: 30000 }));
  if (!result.packets?.length) throw new Error('素材没有可读取的视频包');
  return result.packets.some((packet: any) => !Number.isSafeInteger(packet.pts));
}
/** 只在有空闲名额时启动；取消等待项不会再派生子进程。 */
export class MediaLimiter {
  private active = 0;
  private queue: Array<{ start: () => void; signal?: AbortSignal }> = [];
  constructor(private budget: () => number) {}
  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const item = { signal, start: () => {
        signal?.removeEventListener('abort', cancel);
        this.active++;
        Promise.resolve().then(() => { if (signal?.aborted) throw abortError(); return work(); }).then(resolve, reject).finally(() => { this.active--; this.pump(); });
      } };
      const cancel = () => { this.queue = this.queue.filter(entry => entry !== item); reject(abortError()); };
      signal?.addEventListener('abort', cancel, { once: true });
      this.queue.push(item); this.pump();
    });
  }
  private pump() { while (this.active < this.budget() && this.queue.length) this.queue.shift()!.start(); }
}
