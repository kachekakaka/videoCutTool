import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { MediaStreamInfo, MediaTime } from '../../shared/types';
import { frameTime, secondsTime, timeMs } from '../../shared/mediaTime';

const children = new Set<ChildProcess>();
export const abortError = () => Object.assign(new Error('操作已取消'), { name: 'AbortError' });
export function resolveTool(name: 'ffmpeg' | 'ffprobe', preferred?: string): string {
  const resources = (process as any).resourcesPath;
  const candidates = [preferred, resources && path.join(resources, 'bin', `${name}.exe`), resources && path.join(resources, 'tools', `${name}.exe`), path.resolve('tools', `${name}.exe`), `D:/Tools/ffmpeg/${name}.exe`].filter(Boolean) as string[];
  return candidates.find(file => fs.existsSync(file)) || name;
}
export async function stopMediaProcesses(): Promise<void> {
  await Promise.all([...children].map(child => new Promise<void>(resolve => {
    child.once('close', () => resolve());
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.kill();
  })));
}
export function runMediaTool(executable: string, args: string[], options: { signal?: AbortSignal; timeoutMs?: number; onOutput?: (text: string) => void; maxOutputBytes?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(abortError());
    const proc = spawn(executable, args, { windowsHide: true });
    children.add(proc);
    let stdout = '', stderr = '', failure: Error | undefined;
    const cancel = () => { failure = abortError(); proc.kill(); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => { failure = new Error('媒体处理超时'); proc.kill(); }, options.timeoutMs) : undefined;
    proc.stdout.on('data', chunk => {
      stdout += chunk.toString();
      options.onOutput?.(chunk.toString());
      if (stdout.length > (options.maxOutputBytes ?? 64 * 1024 * 1024)) { failure = new Error('媒体探测结果超过可处理大小'); proc.kill(); }
    });
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-24000); });
    proc.on('error', error => { failure = error; });
    proc.on('close', code => {
      children.delete(proc);
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`媒体处理失败 (${code}): ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}
export interface ProbedFile {
  durationMs: number; width: number; height: number; fps: number; origin: MediaTime;
  videoIndex: number; timeBase: string; streams: MediaStreamInfo[]; videoStartMs: number;
}
export async function probeFile(file: string, ffprobe: string, signal?: AbortSignal): Promise<ProbedFile> {
  const data = JSON.parse(await runMediaTool(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal, timeoutMs: 30000 }));
  const rawStreams = data.streams || [];
  const video = rawStreams.find((stream: any) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video) throw new Error('素材不包含可剪辑的视频流');
  const duration = Number(data.format?.duration || video.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确定视频时长，不能安全生成剪辑方案');
  const rate = String(video.avg_frame_rate || video.r_frame_rate || '0/1').split('/').map(Number);
  const fallback = String(video.r_frame_rate || '0/1').split('/').map(Number);
  const fps = rate[0] / rate[1] || fallback[0] / fallback[1] || 30;
  const rotation = Number(video.side_data_list?.find((item: any) => item.rotation !== undefined)?.rotation || video.tags?.rotate || 0);
  const rotated = Math.abs(rotation) % 180 === 90;
  return {
    durationMs: Math.round(duration * 1000), width: rotated ? video.height : video.width, height: rotated ? video.width : video.height,
    fps, videoIndex: video.index, timeBase: video.time_base, videoStartMs: (Number(video.start_time || 0) - Number(data.format?.start_time || 0)) * 1000,
    origin: secondsTime(String(data.format?.start_time ?? '0')),
    streams: rawStreams.map((stream: any) => ({ index: stream.index, type: stream.codec_type, codec: stream.codec_name, language: stream.tags?.language, attachedPicture: Boolean(stream.disposition?.attached_pic), default: Boolean(stream.disposition?.default) })),
  };
}
export function fileIdentity(file: string): string {
  const stat = fs.statSync(file);
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
export async function removeOwnedDirectory(root: string, directory: string): Promise<void> {
  const base = path.resolve(root), target = path.resolve(directory);
  if (target === base || !target.startsWith(base + path.sep)) throw new Error('临时目录不在本次任务的受控范围内');
  await fs.promises.rm(target, { recursive: true, force: true });
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
