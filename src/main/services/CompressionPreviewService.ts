import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { CompressConfig, PreviewSample } from '../../shared/types';
import { buildCompressArgs } from '../../shared/compressPresets';
import { abortError, fileIdentity, MediaLimiter, probeFile, resolveTool, runMediaTool } from './MediaTools';
import { cacheKey, CacheUse, mediaUrl, PreviewCache } from './PreviewCache';
import { CacheMaintenanceService } from './CacheMaintenanceService';

export type CompressionPreviewSample = PreviewSample;
type Encoder = 'cpu' | 'nvenc' | 'qsv';
export class CompressionPreviewService {
  private ffmpegPath: string;
  private ffprobePath: string;
  private cache: PreviewCache;
  private requests = new Map<string, { controller: AbortController; promise: Promise<PreviewSample[]> }>();
  private closing = false;
  private leases = new Map<string, () => void>();
  constructor(preferredPath?: string, directory = path.resolve('../videoCutTool_tmp/preview_cache'), private encoder: (config: CompressConfig, signal?: AbortSignal) => Promise<Encoder> = async () => 'cpu', private limiter = new MediaLimiter(() => 2), maintenance?: CacheMaintenanceService) {
    this.ffmpegPath = resolveTool('ffmpeg', preferredPath); this.ffprobePath = resolveTool('ffprobe', preferredPath && path.join(path.dirname(preferredPath), 'ffprobe.exe')); this.cache = new PreviewCache(directory, 'picture', maintenance);
  }
  updateTools(ffmpeg?: string, ffprobe?: string) { this.ffmpegPath = resolveTool('ffmpeg', ffmpeg); this.ffprobePath = resolveTool('ffprobe', ffprobe); this.closing = false; }
  async cancel(id: string) { const request = this.requests.get(id); if (request) { request.controller.abort(); await request.promise.catch(() => {}); } }
  release(id: string) { this.leases.get(id)?.(); this.leases.delete(id); }
  async releaseOwner(prefix: string) { await Promise.all([...this.requests.keys()].filter(id => id.startsWith(prefix)).map(id => this.cancel(id))); for (const id of this.leases.keys()) if (id.startsWith(prefix)) this.release(id); }
  async shutdown() { this.closing = true; await Promise.all([...this.requests.keys()].map(id => this.cancel(id))); for (const id of this.leases.keys()) this.release(id); }
  generatePreviewSamples(video: string, timestamps: number[], config: CompressConfig, requestId: string = randomUUID()): Promise<PreviewSample[]> {
    if (this.closing) return Promise.reject(abortError());
    if (this.requests.has(requestId)) return this.requests.get(requestId)!.promise;
    const controller = new AbortController();
    const promise = this.generate(video, timestamps, config, controller.signal, requestId).finally(() => this.requests.delete(requestId));
    this.requests.set(requestId, { controller, promise }); return promise;
  }
  private async generate(video: string, timestamps: number[], config: CompressConfig, signal: AbortSignal, requestId: string): Promise<PreviewSample[]> {
    this.cache.maintenance.protect(video);
    const identity = fileIdentity(video), directory = await this.cache.request();
    const uses: CacheUse[] = []; let transferred = false;
    try {
      const info = await this.limiter.run(() => probeFile(video, this.ffprobePath, signal), signal);
      const encoder = await this.limiter.run(() => this.encoder(config, signal), signal);
      if (signal.aborted) throw abortError();
      const targets = [...new Set(timestamps)].filter(value => Number.isFinite(value) && value >= 0 && value < info.durationMs).slice(0, 5);
      if (!targets.length) throw new Error('没有有效的抽样时间点');
      const results = await Promise.allSettled(targets.map((time, index) => this.limiter.run(async () => {
        const originalUse = await this.cache.acquire(cacheKey([identity, time, 'original-png-v1'])); uses.push(originalUse);
        const compressedUse = await this.cache.acquire(cacheKey([identity, time, config, encoder, this.ffmpegPath, 'window-png-v1'])); uses.push(compressedUse);
        const original = originalUse.file, compressed = compressedUse.file;
        const run = (args: string[]) => this.cache.maintenance.task(directory, () => runMediaTool(this.ffmpegPath, args, { signal, timeoutMs: 120000 }));
        if (originalUse.fresh) {
          const temporary = path.join(directory, `original_${index}.png`);
          await run(['-n', '-ss', (time / 1000).toFixed(6), '-i', video, '-map', `0:${info.videoIndex}`, '-frames:v', '1', '-c:v', 'png', temporary]); await this.cache.publish(originalUse, temporary);
        }
        if (compressedUse.fresh) {
          const start = Math.max(0, time / 1000 - 1), duration = Math.min(2.5, info.durationMs / 1000 - start);
          const encoded = path.join(directory, `window_${index}.mp4`), temporary = path.join(directory, `compressed_${index}.png`);
          await run(buildCompressArgs(video, encoded, config, encoder, { streams: info.streams.filter(stream => stream.index === info.videoIndex), videoOnly: true, startSeconds: start.toFixed(6), durationSeconds: duration.toFixed(6) }));
          await run(['-n', '-ss', (time / 1000 - start).toFixed(6), '-i', encoded, '-frames:v', '1', '-c:v', 'png', temporary]); await this.cache.publish(compressedUse, temporary);
        }
        return { index, timestampMs: time, originalBase64: '', compressedBase64: '', originalUrl: mediaUrl(original), compressedUrl: mediaUrl(compressed), originalSizeBytes: (await fs.promises.stat(original)).size, compressedSizeBytes: (await fs.promises.stat(compressed)).size, resolvedEncoder: encoder };
      }, signal)));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (fileIdentity(video) !== identity) throw new Error('原视频已变更，请重新载入');
      const samples = results.map(result => (result as PromiseFulfilledResult<PreviewSample>).value);
      if (signal.aborted) throw abortError();
      this.release(requestId); this.leases.set(requestId, () => uses.forEach(use => use.release())); transferred = true;
      return samples;
    } finally {
      if (!transferred) for (const use of uses) { try { await this.cache.fail(use); } catch (error) { console.warn('图片缓存收尾失败：', error); use.release(); } }
      await this.cache.finish(directory); this.cache.maintenance.schedule();
    }
  }
}
