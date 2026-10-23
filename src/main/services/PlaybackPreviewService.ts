import path from 'path';
import { PreviewProgress } from '../../shared/types';
import { abortError, fileIdentity, MediaLimiter, presentationStart, probeFile, resolveTool, runMediaTool } from './MediaTools';
import { cacheKey, CacheUse, PreviewCache } from './PreviewCache';
import { CacheMaintenanceService } from './CacheMaintenanceService';
import { timeMs } from '../../shared/mediaTime';

export interface PlaybackPreview { path?: string; needsConversion?: boolean; timeOffsetMs?: number }
export class PlaybackPreviewService {
  private cache: PreviewCache;
  private requests = new Map<string, { controller: AbortController; promise: Promise<PlaybackPreview> }>();
  private closing = false;
  private leases = new Map<string, () => void>();
  private ffmpeg: string; private ffprobe: string;
  constructor(directory: string, ffmpeg?: string, ffprobe?: string, private limiter = new MediaLimiter(() => 2), maintenance?: CacheMaintenanceService) { this.cache = new PreviewCache(directory, 'playback', maintenance); this.ffmpeg = resolveTool('ffmpeg', ffmpeg); this.ffprobe = resolveTool('ffprobe', ffprobe); }
  updateTools(ffmpeg?: string, ffprobe?: string) { this.ffmpeg = resolveTool('ffmpeg', ffmpeg); this.ffprobe = resolveTool('ffprobe', ffprobe); this.closing = false; }
  async cancel(id: string) { const request = this.requests.get(id); if (request) { request.controller.abort(); await request.promise.catch(() => {}); } }
  release(id: string) { this.leases.get(id)?.(); this.leases.delete(id); }
  async releaseOwner(prefix: string) { await Promise.all([...this.requests.keys()].filter(id => id.startsWith(prefix)).map(id => this.cancel(id))); for (const id of this.leases.keys()) if (id.startsWith(prefix)) this.release(id); }
  async shutdown() { this.closing = true; await Promise.all([...this.requests.keys()].map(id => this.cancel(id))); for (const id of this.leases.keys()) this.release(id); }
  prepare(video: string, convert: boolean, id: string, progress: (event: PreviewProgress) => void): Promise<PlaybackPreview> {
    if (this.closing) return Promise.reject(abortError());
    if (this.requests.has(id)) return this.requests.get(id)!.promise;
    const controller = new AbortController();
    const promise = this.generate(video, convert, id, progress, controller.signal).finally(() => this.requests.delete(id));
    this.requests.set(id, { controller, promise }); return promise;
  }
  private async generate(video: string, convert: boolean, id: string, progress: (event: PreviewProgress) => void, signal: AbortSignal): Promise<PlaybackPreview> {
    this.cache.maintenance.protect(video);
    return this.limiter.run(async () => {
      const identity = fileIdentity(video), info = await probeFile(video, this.ffprobe, signal);
      const stream = info.streams.find(stream => stream.index === info.videoIndex)!, audio = info.streams.find(stream => stream.type === 'audio');
      if (!convert && (!['h264', 'vp9', 'av1'].includes(stream.codec) || (audio && !['aac', 'mp3'].includes(audio.codec)))) return { needsConversion: true };
      const use = await this.cache.acquire(cacheKey([identity, convert, this.ffmpeg, 'playback-v1']), '.mp4');
      const output = use.file;
      let directory: string | undefined;
      let transferred = false;
      try {
        let checked = output;
        if (use.fresh) {
          directory = await this.cache.request();
          const temporary = path.join(directory, 'preview.mp4'); checked = temporary;
          await this.cache.maintenance.task(directory, () => runMediaTool(this.ffmpeg, ['-n', '-copyts', '-start_at_zero', '-i', video, '-map', `0:${info.videoIndex}`, ...(audio ? ['-map', `0:${audio.index}`] : []), ...(convert ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-vf', "scale='max(2,trunc(iw/2)*2)':'max(2,trunc(ih/2)*2)'", '-pix_fmt', 'yuv420p', '-c:a', 'aac'] : ['-c', 'copy']), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', temporary], { signal, captureOutput: false, onOutput: chunk => {
            const matches = [...chunk.matchAll(/out_time_us=(\d+)/g)]; const last = matches.at(-1); if (last) progress({ requestId: id, percent: Math.min(99, Number(last[1]) / (info.durationMs * 10)), message: convert ? '正在生成兼容预览' : '正在改封装预览' });
          } }));
        }
        const preview = await probeFile(checked, this.ffprobe, signal);
        if (Math.abs(preview.durationMs - info.durationMs) > Math.max(250, 2000 / info.fps)) throw new Error('兼容预览时长与原片不一致，无法保证切点对应');
        if (fileIdentity(video) !== identity) throw new Error('原视频已变更，请重新载入');
        const sourceStart = await presentationStart(video, info, this.ffprobe, signal), previewStart = await presentationStart(checked, preview, this.ffprobe, signal);
        if (signal.aborted) throw abortError();
        if (use.fresh) await this.cache.publish(use, checked);
        if (signal.aborted) throw abortError();
        this.release(id); this.leases.set(id, use.release); transferred = true;
        progress({ requestId: id, percent: 100, message: '兼容预览已就绪' });
        return { path: output, timeOffsetMs: timeMs(preview.origin) + previewStart - sourceStart };
      } catch (error) { if (!convert && !signal.aborted) return { needsConversion: true }; throw error; }
      finally { if (!transferred) await this.finishFailed(use); if (directory) await this.cache.finish(directory); this.cache.maintenance.schedule(); }
    }, signal);
  }
  private async finishFailed(use: CacheUse) { try { await this.cache.fail(use); } catch (error) { console.warn('播放缓存收尾失败：', error); use.release(); } }
}
