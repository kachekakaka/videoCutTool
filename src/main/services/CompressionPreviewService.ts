import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { CompressConfig, PreviewSample } from '../../shared/types';
import { buildCompressArgs } from '../../shared/compressPresets';
import { abortError, fileIdentity, MediaLimiter, probeFile, removeOwnedDirectory, resolveTool, runMediaTool } from './MediaTools';
import { cacheKey, mediaUrl, PreviewCache } from './PreviewCache';

export type CompressionPreviewSample = PreviewSample;
type Encoder = 'cpu' | 'nvenc' | 'qsv';
export class CompressionPreviewService {
  private ffmpegPath: string;
  private ffprobePath: string;
  private cache: PreviewCache;
  private requests = new Map<string, { controller: AbortController; promise: Promise<PreviewSample[]> }>();
  constructor(preferredPath?: string, directory = path.resolve('../videoCutTool_tmp/preview_cache'), private encoder: (config: CompressConfig, signal?: AbortSignal) => Promise<Encoder> = async () => 'cpu', private limiter = new MediaLimiter(() => 2)) {
    this.ffmpegPath = resolveTool('ffmpeg', preferredPath); this.ffprobePath = resolveTool('ffprobe', preferredPath && path.join(path.dirname(preferredPath), 'ffprobe.exe')); this.cache = new PreviewCache(directory);
  }
  updateTools(ffmpeg?: string, ffprobe?: string) { this.ffmpegPath = resolveTool('ffmpeg', ffmpeg); this.ffprobePath = resolveTool('ffprobe', ffprobe); }
  async cancel(id: string) { const request = this.requests.get(id); if (request) { request.controller.abort(); await request.promise.catch(() => {}); } }
  async shutdown() { await Promise.all([...this.requests.keys()].map(id => this.cancel(id))); }
  generatePreviewSamples(video: string, timestamps: number[], config: CompressConfig, requestId: string = randomUUID()): Promise<PreviewSample[]> {
    if (this.requests.has(requestId)) return this.requests.get(requestId)!.promise;
    const controller = new AbortController();
    const promise = this.generate(video, timestamps, config, controller.signal).finally(() => this.requests.delete(requestId));
    this.requests.set(requestId, { controller, promise }); return promise;
  }
  private async generate(video: string, timestamps: number[], config: CompressConfig, signal: AbortSignal): Promise<PreviewSample[]> {
    const identity = fileIdentity(video), directory = path.join(this.cache.directory, `request_${randomUUID()}`);
    await fs.promises.mkdir(directory, { recursive: true });
    try {
      const info = await this.limiter.run(() => probeFile(video, this.ffprobePath, signal), signal);
      const encoder = await this.limiter.run(() => this.encoder(config, signal), signal);
      if (signal.aborted) throw abortError();
      const targets = [...new Set(timestamps)].filter(value => Number.isFinite(value) && value >= 0 && value < info.durationMs).slice(0, 5);
      if (!targets.length) throw new Error('没有有效的抽样时间点');
      const results = await Promise.allSettled(targets.map((time, index) => this.limiter.run(async () => {
        const original = this.cache.file(cacheKey([identity, time, 'original-png-v1']));
        const compressed = this.cache.file(cacheKey([identity, time, config, encoder, this.ffmpegPath, 'window-png-v1']));
        const run = (args: string[]) => runMediaTool(this.ffmpegPath, args, { signal, timeoutMs: 120000 });
        const publish = async (temporary: string, target: string) => { await fs.promises.link(temporary, target).catch((error: any) => { if (error.code !== 'EEXIST') throw error; }); };
        if (!await this.cache.hit(original)) {
          const temporary = path.join(directory, `original_${index}.png`);
          await run(['-n', '-ss', (time / 1000).toFixed(6), '-i', video, '-map', `0:${info.videoIndex}`, '-frames:v', '1', '-c:v', 'png', temporary]); await publish(temporary, original);
        }
        if (!await this.cache.hit(compressed)) {
          const start = Math.max(0, time / 1000 - 1), duration = Math.min(2.5, info.durationMs / 1000 - start);
          const encoded = path.join(directory, `window_${index}.mp4`), temporary = path.join(directory, `compressed_${index}.png`);
          await run(buildCompressArgs(video, encoded, config, encoder, { streams: info.streams.filter(stream => stream.index === info.videoIndex), videoOnly: true, startSeconds: start.toFixed(6), durationSeconds: duration.toFixed(6) }));
          await run(['-n', '-ss', (time / 1000 - start).toFixed(6), '-i', encoded, '-frames:v', '1', '-c:v', 'png', temporary]); await publish(temporary, compressed);
        }
        return { index, timestampMs: time, originalBase64: '', compressedBase64: '', originalUrl: mediaUrl(original), compressedUrl: mediaUrl(compressed), originalSizeBytes: (await fs.promises.stat(original)).size, compressedSizeBytes: (await fs.promises.stat(compressed)).size, resolvedEncoder: encoder };
      }, signal)));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (fileIdentity(video) !== identity) throw new Error('原视频已变更，请重新载入');
      const samples = results.map(result => (result as PromiseFulfilledResult<PreviewSample>).value);
      await this.cache.trim(samples.flatMap(sample => [sample.originalUrl!, sample.compressedUrl!].map(url => new URL(url).searchParams.get('path')!)));
      return samples;
    } finally { await removeOwnedDirectory(this.cache.directory, directory); }
  }
}
