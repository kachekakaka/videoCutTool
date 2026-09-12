import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { PreviewProgress } from '../../shared/types';
import { fileIdentity, MediaLimiter, presentationStart, probeFile, removeOwnedDirectory, resolveTool, runMediaTool } from './MediaTools';
import { cacheKey, PreviewCache } from './PreviewCache';

export interface PlaybackPreview { path?: string; needsConversion?: boolean; timeOffsetMs?: number }
export class PlaybackPreviewService {
  private cache: PreviewCache;
  private requests = new Map<string, { controller: AbortController; promise: Promise<PlaybackPreview> }>();
  private ffmpeg: string; private ffprobe: string;
  constructor(directory: string, ffmpeg?: string, ffprobe?: string, private limiter = new MediaLimiter(() => 2)) { this.cache = new PreviewCache(directory, 3, 2 * 1024 ** 3); this.ffmpeg = resolveTool('ffmpeg', ffmpeg); this.ffprobe = resolveTool('ffprobe', ffprobe); }
  updateTools(ffmpeg?: string, ffprobe?: string) { this.ffmpeg = resolveTool('ffmpeg', ffmpeg); this.ffprobe = resolveTool('ffprobe', ffprobe); }
  async cancel(id: string) { const request = this.requests.get(id); if (request) { request.controller.abort(); await request.promise.catch(() => {}); } }
  async shutdown() { await Promise.all([...this.requests.keys()].map(id => this.cancel(id))); }
  prepare(video: string, convert: boolean, id: string, progress: (event: PreviewProgress) => void): Promise<PlaybackPreview> {
    if (this.requests.has(id)) return this.requests.get(id)!.promise;
    const controller = new AbortController();
    const promise = this.generate(video, convert, id, progress, controller.signal).finally(() => this.requests.delete(id));
    this.requests.set(id, { controller, promise }); return promise;
  }
  private async generate(video: string, convert: boolean, id: string, progress: (event: PreviewProgress) => void, signal: AbortSignal): Promise<PlaybackPreview> {
    return this.limiter.run(async () => {
      const identity = fileIdentity(video), info = await probeFile(video, this.ffprobe, signal);
      const stream = info.streams.find(stream => stream.index === info.videoIndex)!, audio = info.streams.find(stream => stream.type === 'audio');
      if (!convert && (!['h264', 'vp9', 'av1'].includes(stream.codec) || (audio && !['aac', 'mp3'].includes(audio.codec)))) return { needsConversion: true };
      const output = this.cache.file(cacheKey([identity, convert, this.ffmpeg, 'playback-v1']), '.mp4');
      const directory = path.join(this.cache.directory, `request_${randomUUID()}`);
      await fs.promises.mkdir(directory, { recursive: true });
      try {
        if (!await this.cache.hit(output)) {
          const temporary = path.join(directory, 'preview.mp4');
          await runMediaTool(this.ffmpeg, ['-n', '-copyts', '-start_at_zero', '-i', video, '-map', `0:${info.videoIndex}`, ...(audio ? ['-map', `0:${audio.index}`] : []), ...(convert ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-vf', "scale='max(2,trunc(iw/2)*2)':'max(2,trunc(ih/2)*2)'", '-pix_fmt', 'yuv420p', '-c:a', 'aac'] : ['-c', 'copy']), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', temporary], { signal, onOutput: chunk => {
            const matches = [...chunk.matchAll(/out_time_us=(\d+)/g)]; const last = matches.at(-1); if (last) progress({ requestId: id, percent: Math.min(99, Number(last[1]) / (info.durationMs * 10)), message: convert ? '正在生成兼容预览' : '正在改封装预览' });
          } });
          if ((await fs.promises.stat(temporary)).size > 2 * 1024 ** 3) throw new Error('兼容预览超过 2 GB 缓存上限，请使用较短素材');
          await fs.promises.link(temporary, output).catch((error: any) => { if (error.code !== 'EEXIST') throw error; });
        }
        const preview = await probeFile(output, this.ffprobe, signal);
        if (Math.abs(preview.durationMs - info.durationMs) > Math.max(250, 2000 / info.fps)) throw new Error('兼容预览时长与原片不一致，无法保证切点对应');
        if (fileIdentity(video) !== identity) throw new Error('原视频已变更，请重新载入');
        await this.cache.trim([output]);
        progress({ requestId: id, percent: 100, message: '兼容预览已就绪' });
        const sourceStart = await presentationStart(video, info, this.ffprobe, signal), previewStart = await presentationStart(output, preview, this.ffprobe, signal);
        return { path: output, timeOffsetMs: previewStart - sourceStart };
      } catch (error) { if (!convert && !signal.aborted) return { needsConversion: true }; throw error; }
      finally { await removeOwnedDirectory(this.cache.directory, directory); }
    }, signal);
  }
}
