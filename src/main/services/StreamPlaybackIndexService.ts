import fs from 'fs';
import path from 'path';
import { PreviewCache, CacheUse } from './PreviewCache';
import { CacheMaintenanceService } from './CacheMaintenanceService';
import { abortError, fileIdentityAsync, MediaLimiter, resolveTool, runMediaTool } from './MediaTools';
import { rational } from '../../shared/mediaTime';
import { MediaMetadata, MediaStreamInfo } from '../../shared/types';
import { frameAt, StreamContainer, StreamFrameTarget } from '../../shared/streamPlayback';

interface Key { pts: number; position: number }
interface IndexData {
  version: 1; identity: string; container: StreamContainer; size: number;
  originUs: number; baseMs: number; width: number; height: number; fps: number; ratio: number;
  streams: MediaStreamInfo[]; videoIndex: number; audioIndex?: number;
  frames: number[]; keys: Key[]; durationMs: number;
}
interface IndexJob {
  file: string; identity: string; controller: AbortController; refs: number;
  ready: Promise<void>; done: Promise<void>; data?: IndexData; use?: CacheUse;
  complete: boolean; progress: number; error?: string; revision: number;
  sortedRevision: number; sortedFrames: number[];
}
export interface StreamIndexLease { job: IndexJob; release: () => void }
const timestampUs = (value: unknown) => {
  const n = Math.round(Number(value) * 1e6);
  if (value === undefined || value === 'N/A' || !Number.isSafeInteger(n)) throw new Error('媒体缺少可靠时间戳');
  return n;
};

/** 只保存时刻与关键帧位置；媒体负载不写入缓存。后台扫描可取消、同片共享。 */
export class StreamPlaybackIndexService {
  private cache: PreviewCache;
  private jobs = new Map<string, IndexJob>();
  private limiter = new MediaLimiter(() => 1);
  private tool: string;
  private closing = false;
  constructor(directory: string, tool?: string, maintenance?: CacheMaintenanceService) {
    this.cache = new PreviewCache(directory, 'index', maintenance); this.tool = resolveTool('ffprobe', tool);
  }
  updateTool(tool?: string) { this.tool = resolveTool('ffprobe', tool); }
  async identify(file: string): Promise<StreamContainer | null> {
    const handle = await fs.promises.open(file, 'r');
    try {
      const data = Buffer.alloc(1024); const { bytesRead } = await handle.read(data, 0, data.length, 0);
      if (data.toString('ascii', 0, 3) === 'FLV') return 'flv';
      for (const size of [188, 192, 204]) for (let at = 0; at < Math.min(size, bytesRead - size * 2); at++) {
        if (data[at] === 0x47 && data[at + size] === 0x47 && data[at + size * 2] === 0x47) return 'mpegts';
      }
      if (/\.(flv|ts|m2ts)$/i.test(file)) throw new Error('文件内容不是受支持的 FLV 或 MPEG-TS');
      return null;
    } finally { await handle.close(); }
  }
  async acquire(file: string, container: StreamContainer, signal: AbortSignal): Promise<StreamIndexLease> {
    if (this.closing || signal.aborted) throw abortError();
    const identity = await fileIdentityAsync(file);
    if (signal.aborted) throw abortError();
    this.cache.maintenance.protect(file);
    let job = this.jobs.get(identity);
    if (!job || job.controller.signal.aborted || job.error) {
      job = { file, identity, controller: new AbortController(), refs: 0, ready: Promise.resolve(), done: Promise.resolve(), complete: false, progress: 0, revision: 0, sortedRevision: -1, sortedFrames: [] };
      this.jobs.set(identity, job);
      const current = job, tool = this.tool;
      current.ready = this.prepare(current, container, tool);
      current.done = current.ready.then(() => current.complete ? undefined : this.limiter.run(() => this.scan(current, tool), current.controller.signal)).catch(error => {
        current.error = error instanceof Error ? error.message : String(error);
      });
    }
    job.refs++;
    const current = job;
    let released = false;
    const release = () => {
      if (released) return; released = true; signal.removeEventListener('abort', release);
      current.refs--;
      if (!current.refs) {
        current.controller.abort();
        void current.done.finally(() => { current.use?.release(); if (this.jobs.get(identity) === current) this.jobs.delete(identity); this.cache.maintenance.schedule(); });
      }
    };
    signal.addEventListener('abort', release, { once: true });
    try { await current.ready; if (signal.aborted || current.controller.signal.aborted) throw abortError(); return { job: current, release }; }
    catch (error) { release(); throw error; }
  }
  private async prepare(job: IndexJob, container: StreamContainer, tool: string) {
    const key = `stream-index-v1:${job.identity}`;
    const hit = await this.cache.lookup(key);
    if (hit) {
      try {
        const d = JSON.parse(await fs.promises.readFile(hit.file, 'utf8')) as IndexData;
        if (d.version === 1 && d.identity === job.identity && d.container === container && this.valid(d)) {
          job.data = d; job.use = hit; job.complete = true; job.progress = 100; job.revision++; return;
        }
      } catch { /* 已登记但无效的索引不作为可信媒体信息。 */ }
      hit.release();
    }
    const json = JSON.parse(await runMediaTool(tool, ['-v', 'error', '-probesize', '1048576', '-analyzeduration', '1000000', '-read_intervals', '%+#128', '-show_streams', '-show_format', '-show_packets', '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time,pos,flags:format=format_name,start_time:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_aspect_ratio:stream_disposition=attached_pic,default', '-of', 'json', job.file], { signal: job.controller.signal, timeoutMs: 30000 }));
    const streams = json.streams ?? [], videos = streams.filter((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic), audios = streams.filter((s: any) => s.codec_type === 'audio');
    if (videos.length !== 1 || videos[0].codec_name !== 'h264' || audios.length > 1 || audios.some((s: any) => s.codec_name !== 'aac')) throw new Error('流式精确播放目前支持单路 H.264 视频及单路 AAC 音频，不会生成整片兼容副本');
    const video = videos[0], packets = json.packets.filter((p: any) => p.stream_index === video.index || p.stream_index === audios[0]?.index);
    const firstVideo = packets.find((p: any) => p.stream_index === video.index);
    if (!firstVideo || !firstVideo.flags?.includes('K')) throw new Error('素材起点缺少可独立解码的关键帧');
    const rate = String(video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : video.r_frame_rate).split('/').map(Number), sar = String(video.sample_aspect_ratio || '1:1').split(':').map(Number);
    job.data = { version: 1, identity: job.identity, container, size: (await fs.promises.stat(job.file)).size, originUs: timestampUs(json.format.start_time), baseMs: Math.floor(Math.min(...packets.map((p: any) => timestampUs(p.dts_time))) / 1000), width: video.width, height: video.height, ratio: video.width / video.height * (sar[0] / sar[1] || 1), fps: rate[0] / rate[1] || 30, videoIndex: video.index, audioIndex: audios[0]?.index, streams: streams.map((s: any) => ({ index: s.index, type: s.codec_type, codec: s.codec_name, attachedPicture: Boolean(s.disposition?.attached_pic), default: Boolean(s.disposition?.default) })), frames: [], keys: [], durationMs: 0 };
    if (await fileIdentityAsync(job.file) !== job.identity) throw new Error('原视频已变化，请重新打开');
  }
  private valid(d: IndexData) {
    return Number.isFinite(d.durationMs) && d.durationMs > 0 && Number.isSafeInteger(d.originUs) && Number.isSafeInteger(d.baseMs) && d.frames.length > 0 && d.keys.length > 0
      && d.frames.every((p, i) => Number.isSafeInteger(p) && (!i || p > d.frames[i - 1]))
      && d.keys.every((k, i) => Number.isSafeInteger(k.pts) && Number.isSafeInteger(k.position) && k.position >= 0 && k.position < d.size && (!i || k.pts > d.keys[i - 1].pts && k.position > d.keys[i - 1].position));
  }
  private async scan(job: IndexJob, tool: string) {
    const d = job.data!, signal = job.controller.signal;
    let tail = '', maxEndUs = -Infinity, lastVideoUs = -Infinity, lastVideoPosition = -1;
    const lastDts = new Map<number, number>();
    const packet = (line: string) => {
      if (!line.trim()) return;
      const p = Object.fromEntries(line.split('|').map(field => { const at = field.indexOf('='); return [field.slice(0, at), field.slice(at + 1)]; }));
      const stream = Number(p.stream_index); if (stream !== d.videoIndex && stream !== d.audioIndex) return;
      const pts = timestampUs(p.pts_time), dts = timestampUs(p.dts_time), pos = Number(p.pos), duration = Number(p.duration_time);
      const positioned = Number.isSafeInteger(pos) && pos >= 0 && pos < d.size;
      if (stream === d.videoIndex && !positioned) throw new Error('视频包缺少可验证的原文件位置');
      const previous = lastDts.get(stream);
      if (previous !== undefined && (dts < previous - 1000 || dts - previous > 10_000_000)) throw new Error('素材时间戳发生重置或大幅跳变，暂不支持精确流式编辑');
      if (d.container === 'mpegts' && dts >= 95_443_717_688) throw new Error('本次精确播放暂不支持跨 MPEG-TS 时间戳回绕点');
      lastDts.set(stream, dts);
      maxEndUs = Math.max(maxEndUs, pts + (Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1e6) : 0));
      if (stream === d.videoIndex) {
        if (pos === lastVideoPosition) throw new Error('一个媒体包包含多幅画面，暂不支持此素材的精确逐帧');
        lastVideoPosition = pos; lastVideoUs = pts; d.frames.push(pts); job.revision++;
        if (p.flags.includes('K')) {
          if (d.keys.length && pts <= d.keys[d.keys.length - 1].pts) throw new Error('关键帧时间不连续');
          d.keys.push({ pts, position: pos });
        }
      }
      if (positioned) job.progress = Math.max(job.progress, Math.min(99, 100 * pos / d.size));
    };
    // TS 必须解析包边界；过程只持有时间戳与位置，不生成媒体派生文件。
    await runMediaTool(tool, ['-v', 'error', '-show_packets', '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time,pos,flags', '-of', 'compact=p=0', job.file], { signal, captureOutput: false, onOutput: chunk => { const lines = (tail + chunk).split(/\r?\n/); tail = lines.pop() || ''; if (tail.length > 16384) throw new Error('索引输出异常'); lines.forEach(packet); } });
    if (tail) packet(tail);
    if (signal.aborted) throw abortError();
    if (await fileIdentityAsync(job.file) !== job.identity) throw new Error('建立索引时原视频发生变化');
    d.frames.sort((a, b) => a - b);
    if (maxEndUs <= lastVideoUs && d.frames.length > 1) maxEndUs = Math.max(maxEndUs, d.frames.at(-1)! + d.frames.at(-1)! - d.frames.at(-2)!);
    d.durationMs = (maxEndUs - d.originUs) / 1000;
    if (!this.valid(d)) throw new Error('索引时间轴无效，无法保证逐帧准确');
    const use = await this.cache.acquire(`stream-index-v1:${job.identity}`, '.json'); job.use = use;
    try {
      if (use.fresh) { await fs.promises.writeFile(use.file, JSON.stringify(d), { flag: 'wx' }); if (signal.aborted) throw abortError(); await this.cache.maintenance.ready(use.file); }
      if (signal.aborted) throw abortError(); job.complete = true; job.progress = 100; job.revision++;
    } catch (error) { await this.cache.fail(use); job.use = undefined; throw error; }
  }
  snapshot(lease: StreamIndexLease) {
    const job = lease.job, d = job.data!;
    return { container: d.container, originUs: d.originUs, baseMs: d.baseMs, frames: job.complete ? d.frames : undefined, offsetMs: d.originUs / 1000 - d.baseMs, durationMs: d.durationMs, indexedUntilMs: job.complete ? d.durationMs : Math.max(0, ((d.keys.at(-1)?.pts ?? d.originUs) - d.originUs) / 1000), progress: job.progress, complete: job.complete, error: job.error, index: { times: d.keys.map(k => Math.floor(k.pts / 1000) - d.baseMs), filepositions: d.keys.map(k => k.position) }, metadata: job.complete ? this.metadata(job) : undefined };
  }
  metadata(job: IndexJob): MediaMetadata {
    const d = job.data!;
    const points = d.keys.map(k => ({ timeMs: (k.pts - d.originUs) / 1000, time: rational(BigInt(k.pts - d.originUs), 1_000_000n) }));
    return { filePath: job.file, fileName: path.basename(job.file), width: d.width, height: d.height, displayAspectRatio: d.ratio, fps: d.fps, durationMs: d.durationMs, streams: d.streams, timeOrigin: rational(BigInt(d.originUs), 1_000_000n), keyframes: points.map(k => Math.max(0, k.timeMs)), keyframePoints: points };
  }
  frame(lease: StreamIndexLease, timeMs: number, direction: -1 | 0 | 1): StreamFrameTarget {
    const job = lease.job, d = job.data!;
    if (job.error) throw new Error(job.error);
    if (!Number.isFinite(timeMs) || timeMs < 0 || ![-1, 0, 1].includes(direction)) throw new Error('定位参数无效');
    const known = this.snapshot(lease).indexedUntilMs;
    if (!d.frames.length || !job.complete && timeMs + 1 >= known) throw new Error('正在建立该位置的定位索引，请稍后重试');
    if (job.sortedRevision !== job.revision) { job.sortedFrames = job.complete ? d.frames : [...d.frames].sort((a, b) => a - b); job.sortedRevision = job.revision; }
    const frames = job.sortedFrames;
    let at = frameAt(frames, d.originUs + Math.round(timeMs * 1000) + 1);
    if (direction) at += direction;
    const boundary = at < 0 || at >= frames.length;
    at = Math.max(0, Math.min(frames.length - 1, at));
    if (!job.complete && (at + 1 >= frames.length || (frames[at + 1] - d.originUs) / 1000 >= known)) throw new Error('正在建立该位置的定位索引，请稍后重试');
    const pts = Math.floor(frames[at] / 1000) - d.baseMs;
    const next = at + 1 < frames.length ? Math.floor(frames[at + 1] / 1000) - d.baseMs : pts + (at ? (frames[at] - frames[at - 1]) / 1000 : 1000 / d.fps);
    return { sourceMs: Math.max(0, (frames[at] - d.originUs) / 1000), presentationMs: pts, nextPresentationMs: next, atBoundary: boundary };
  }
  async check(lease: StreamIndexLease) { if (await fileIdentityAsync(lease.job.file) !== lease.job.identity) throw new Error('原视频已变化，请重新打开'); }
  async shutdown() { this.closing = true; for (const job of this.jobs.values()) job.controller.abort(); await Promise.allSettled([...this.jobs.values()].map(j => j.done)); for (const job of this.jobs.values()) job.use?.release(); this.jobs.clear(); }
}
