import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { PlanRecord, CutResult, MediaRetentionPlan, CompressConfig, ExecutionStatus, EngineState, PlanSegment, MediaStreamInfo, MediaTime } from '../../shared/types';
import { RetentionDraft } from '../../shared/RetentionDraft';
import { formatTaskTimestamp } from '../../shared/timeUtils';
import { buildCompressArgs } from '../../shared/compressPresets';
import { addTime, subtractTime, ceilMicroseconds, formatMicroseconds, millisecondsTime } from '../../shared/mediaTime';
import { KeyframeProber } from './KeyframeProber';
import { abortError, needsTimestampRepair, presentationStartTime, probeFile, removeOwnedDirectory, resolveTool, runMediaTool } from './MediaTools';
import { resolveFormats, resolveNormalizationExtension, retainedStreams } from './MediaFormatResolver';
import { resolveOutputBatch } from './OutputPathResolver';

type Encoder = 'cpu' | 'nvenc' | 'qsv';
type Job = { record: PlanRecord; prober: KeyframeProber };
export type PlanStatusListener = (event: { planId: string; status: ExecutionStatus; outputPath?: string; error?: string; record?: PlanRecord }) => void;

export class MediaCuttingEngine {
  private ffmpegPath: string;
  private ffprobePath: string;
  private tmpDir: string;
  private queue: Job[] = [];
  private accepted = new Map<string, Job>();
  private submitting = new Map<string, Promise<{ queued: boolean; active: boolean }>>();
  private submissionChain: Promise<unknown> = Promise.resolve();
  private running = false;
  private active: Job | null = null;
  private controller: AbortController | null = null;
  private savePlanFn?: (record: PlanRecord) => Promise<PlanRecord | void> | PlanRecord | void;
  private onStatusChange?: PlanStatusListener;
  private onStateChange?: (state: EngineState) => void;
  private storageError: string | null = null;
  private pendingFinal: PlanRecord | null = null;
  private closing = false;
  private cachedEncoders = new Map<string, Encoder>();
  private encoderJobs = new Map<string, { promise: Promise<Encoder>; controller: AbortController; consumers: Set<symbol> }>();
  private drainPromise: Promise<void> = Promise.resolve();

  constructor(preferredPath?: string, customSlicesDir?: string, saver?: (record: PlanRecord) => any, listener?: PlanStatusListener) {
    this.ffmpegPath = resolveTool('ffmpeg', preferredPath);
    this.ffprobePath = resolveTool('ffprobe', preferredPath ? path.join(path.dirname(preferredPath), 'ffprobe.exe') : undefined);
    const base = process.cwd();
    this.tmpDir = customSlicesDir || path.resolve(base, path.basename(base).toLowerCase() === 'release' ? '../../videoCutTool_tmp/slices' : '../videoCutTool_tmp/slices');
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.savePlanFn = saver; this.onStatusChange = listener;
  }
  updateTools(ffmpeg?: string, ffprobe?: string) { this.ffmpegPath = resolveTool('ffmpeg', ffmpeg); this.ffprobePath = resolveTool('ffprobe', ffprobe); this.cachedEncoders.clear(); }
  setStatusListener(listener: PlanStatusListener) { this.onStatusChange = listener; }
  setStateListener(listener: (state: EngineState) => void) { this.onStateChange = listener; }
  setPlanSaver(saver: (record: PlanRecord) => Promise<PlanRecord | void> | PlanRecord | void) { this.savePlanFn = saver; }
  getActivePlanId() { return this.active?.record.id || null; }
  getQueueLength() { return this.queue.length; }
  isAccepted(id: string) { return this.accepted.has(id) || this.submitting.has(id); }
  getState(): EngineState { return { activePlanId: this.getActivePlanId(), queuedIds: this.queue.map(job => job.record.id), storageError: this.storageError }; }
  private stateChanged() { this.onStateChange?.(this.getState()); }
  private async persist(record: PlanRecord) { await this.savePlanFn?.(record); }
  private notify(record: PlanRecord) { this.onStatusChange?.({ planId: record.id, status: record.status, record: structuredClone(record), outputPath: record.outputPath, error: record.error }); }
  submitPlan(record: PlanRecord, prober: KeyframeProber): Promise<{ queued: boolean; active: boolean }> {
    const pending = this.submitting.get(record.id); if (pending) return pending;
    if (this.accepted.has(record.id)) return Promise.resolve({ queued: this.getActivePlanId() !== record.id, active: this.getActivePlanId() === record.id });
    const task = this.submissionChain.then(async () => {
      if (this.closing) throw new Error('应用正在退出，未接受新任务');
      if (this.storageError) throw new Error('方案保存尚未恢复，请在方案中心重试保存后再提交');
      const snapshot = structuredClone(record); snapshot.status = 'queued'; delete snapshot.error;
      await this.persist(snapshot);
      const job = { record: snapshot, prober };
      this.accepted.set(record.id, job); this.queue.push(job); this.notify(snapshot); this.stateChanged(); this.startDrain();
      return { queued: this.getActivePlanId() !== record.id, active: this.getActivePlanId() === record.id };
    });
    this.submitting.set(record.id, task);
    this.submissionChain = task.catch(() => {});
    void task.finally(() => this.submitting.delete(record.id)).catch(() => {});
    return task;
  }
  /** 删除与派发在同一事件循环同步检查、移出；调用方随后持久化删除。 */
  removeQueued(id: string): Job | undefined {
    if (this.active?.record.id === id || this.pendingFinal?.id === id || this.submitting.has(id)) throw new Error('方案正在处理或保存，完成后可删除');
    const index = this.queue.findIndex(job => job.record.id === id);
    if (index < 0) return undefined;
    const [job] = this.queue.splice(index, 1); this.accepted.delete(id); this.stateChanged(); return job;
  }
  restoreQueued(job: Job) { this.accepted.set(job.record.id, job); this.queue.push(job); this.stateChanged(); this.startDrain(); }
  private startDrain() {
    if (this.running || this.storageError || this.closing) return;
    this.running = true;
    this.drainPromise = this.drain().finally(() => { this.running = false; this.stateChanged(); if (this.queue.length && !this.storageError && !this.closing) this.startDrain(); });
  }
  private blockStorage(error: unknown) { this.storageError = `方案持久化失败：${error instanceof Error ? error.message : String(error)}。已有完整记录保留，请重试保存。`; this.stateChanged(); }
  private async drain(): Promise<void> {
    while (this.queue.length && !this.closing && !this.storageError) {
      const job = this.queue.shift()!; this.active = job; this.controller = new AbortController(); this.stateChanged();
      const processing = { ...job.record, status: 'processing' as const };
      try { await this.persist(processing); } catch (error) { this.queue.unshift(job); this.active = null; this.controller = null; this.blockStorage(error); return; }
      job.record = processing; this.notify(processing);
      let final: PlanRecord;
      try {
        const meta = await job.prober.probe(processing.sourcePath);
        if (this.controller.signal.aborted) throw new Error('上次执行中断，可重试');
        const draft = RetentionDraft.fromRecord(processing, meta.durationMs);
        const plan = draft.toPlan(meta.keyframes, { outputPath: processing.outputPath || processing.sourcePath, concatToSingleFile: processing.concatSingleFile !== false, stripOriginalCover: processing.stripOriginalCover !== false, title: processing.title, keyframePoints: meta.keyframePoints });
        const result = await this.executeRawPlan(plan, this.controller.signal);
        final = result.success
          ? { ...processing, status: 'completed', outputPath: result.outputPath, outputPaths: result.outputPaths, resolvedEncoder: result.resolvedEncoder, completedAt: new Date().toISOString(), error: undefined }
          : { ...processing, status: 'failed', outputPath: result.outputPath, outputPaths: result.outputPaths, error: result.error || '剪辑失败' };
      } catch (error) { final = { ...processing, status: 'failed', error: error instanceof Error ? error.message : String(error) }; }
      try { await this.persist(final); this.accepted.delete(final.id); this.notify(final); }
      catch (error) { this.pendingFinal = final; this.blockStorage(error); }
      finally { this.active = null; this.controller = null; this.stateChanged(); }
    }
  }
  async retryPendingWrites() {
    if (this.pendingFinal) { await this.persist(this.pendingFinal); this.accepted.delete(this.pendingFinal.id); this.notify(this.pendingFinal); this.pendingFinal = null; }
    this.storageError = null; this.stateChanged(); this.startDrain();
  }
  async shutdown() {
    this.closing = true; this.controller?.abort();
    const probes = [...this.encoderJobs.values()].map(job => { job.controller.abort(); return job.promise.catch(() => {}); });
    await this.submissionChain; await this.drainPromise; await Promise.all(probes);
  }

  async probeEncoderSupport(config: CompressConfig = { enabled: true, preset: 'balanced' }, signal?: AbortSignal): Promise<Encoder> {
    if (signal?.aborted) throw abortError();
    if (config.hardwareAcceleration === false || config.encoder === 'cpu') return 'cpu';
    const target = config.preset === 'high_compression' ? 'hevc' : 'h264';
    const requested = config.encoder || 'auto';
    const key = `${this.ffmpegPath}:${target}:${requested}`;
    const existing = this.cachedEncoders.get(key); if (existing) return existing;
    let job = this.encoderJobs.get(key);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController(), executable = this.ffmpegPath;
      const promise = (async (): Promise<Encoder> => {
      const choices: Encoder[] = requested === 'auto' ? ['nvenc', 'qsv'] : [requested as Encoder];
      for (const encoder of choices) {
        try {
          await runMediaTool(executable, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=25:d=0.12', '-c:v', `${target}_${encoder}`, '-f', 'null', '-'], { timeoutMs: 12000, signal: controller.signal });
          return encoder;
        } catch { if (controller.signal.aborted) throw abortError(); if (requested !== 'auto') throw new Error(`指定的 ${encoder.toUpperCase()} ${target.toUpperCase()} 编码器不可用，请选择自动或 CPU`); }
      }
      return 'cpu';
      })().then(encoder => { if (!controller.signal.aborted) this.cachedEncoders.set(key, encoder); return encoder; }).finally(() => { if (this.encoderJobs.get(key)?.controller === controller) this.encoderJobs.delete(key); });
      job = { promise, controller, consumers: new Set() }; this.encoderJobs.set(key, job);
    }
    const currentJob = job, consumer = Symbol(); currentJob.consumers.add(consumer);
    return new Promise<Encoder>((resolve, reject) => {
      const cleanup = () => { currentJob.consumers.delete(consumer); signal?.removeEventListener('abort', cancel); };
      const cancel = () => {
        currentJob.consumers.delete(consumer);
        if (!currentJob.consumers.size) currentJob.controller.abort();
        else { cleanup(); reject(abortError()); }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      currentJob.promise.then(encoder => { cleanup(); if (signal?.aborted) reject(abortError()); else resolve(encoder); }, error => { cleanup(); reject(error); });
    });
  }
  async compressFile(input: string, output: string, config: CompressConfig, encoder: Encoder = 'cpu', signal?: AbortSignal): Promise<void> {
    const info = await probeFile(input, this.ffprobePath, signal);
    await runMediaTool(this.ffmpegPath, buildCompressArgs(input, output, config, encoder, { streams: info.streams, stripCover: false }), { signal });
  }
  private async cut(source: string, segment: PlanSegment, output: string, streams: MediaStreamInfo[], signal?: AbortSignal, offset = millisecondsTime(0)) {
    let startUs = ceilMicroseconds(addTime(segment.seekTime || millisecondsTime(segment.safeRange.startMs), offset));
    if (startUs < 0n) startUs = 0n;
    const endUs = ceilMicroseconds(addTime(millisecondsTime(segment.safeRange.endMs), offset));
    if (endUs <= startUs) throw new Error('保留区间没有有效时长');
    await runMediaTool(this.ffmpegPath, ['-n', '-ss', formatMicroseconds(startUs), '-i', source, '-t', formatMicroseconds(endUs - startUs), '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...streams.flatMap(stream => ['-map', `0:${stream.index}`]), ...this.audioDispositions(streams), output], { signal });
  }
  private async concat(files: string[], output: string, directory: string, signal?: AbortSignal) {
    const list = path.join(directory, 'concat.txt');
    await fs.promises.writeFile(list, files.map(file => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const info = await probeFile(files[0], this.ffprobePath, signal);
    await runMediaTool(this.ffmpegPath, ['-n', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', ...this.audioDispositions(info.streams), output], { signal });
  }
  private audioDispositions(streams: MediaStreamInfo[]) { return streams.filter(stream => stream.type === 'audio').flatMap((stream, index) => [`-disposition:a:${index}`, stream.default ? 'default' : '0']); }
  private async verify(file: string, expected: MediaStreamInfo[], signal?: AbortSignal) {
    const info = await probeFile(file, this.ffprobePath, signal);
    const original = expected.filter(stream => stream.type === 'audio'), actual = info.streams.filter(stream => stream.type === 'audio');
    if (original.length !== actual.length || original.some((stream, index) => stream.codec !== actual[index].codec || (stream.language && stream.language !== actual[index].language))) throw new Error('导出音轨数量、编码或语言与原片不一致，产物未发布');
    if (expected.filter(stream => stream.type === 'video' && !stream.attachedPicture).length !== info.streams.filter(stream => stream.type === 'video' && !stream.attachedPicture).length) throw new Error('导出视频流数量不一致，产物未发布');
  }
  /** 同卷用排他硬链接避免再次复制；跨卷持有排他创建的文件句柄完成发布。 */
  private async publishOne(source: string, target: string, signal?: AbortSignal): Promise<fs.Stats> {
    if (signal?.aborted) throw new Error('操作已取消');
    try { await fs.promises.link(source, target); return await fs.promises.stat(target); }
    catch (error: any) { if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) throw error; }
    const handle = await fs.promises.open(target, 'wx');
    const identity = await handle.stat();
    try { await handle.writeFile(fs.createReadStream(source), { signal }); await handle.sync(); return identity; }
    catch (error) { await handle.close(); await this.removePublished(target, identity); throw error; }
    finally { await handle.close().catch(() => {}); }
  }
  private async removePublished(file: string, identity: fs.Stats) {
    try { const current = await fs.promises.lstat(file); if (current.ino === identity.ino && current.dev === identity.dev) await fs.promises.unlink(file); } catch {}
  }
  async executeRawPlan(plan: MediaRetentionPlan, signal?: AbortSignal): Promise<CutResult> {
    const directory = path.join(this.tmpDir, `job_${randomUUID()}`);
    await fs.promises.mkdir(directory, { recursive: true });
    try {
      if (!plan.planSegments.length) throw new Error('未选择任何保留片段');
      const info = await probeFile(plan.sourcePath, this.ffprobePath, signal);
      const streams = retainedStreams(info.streams, plan.stripOriginalCover !== false);
      const formats = resolveFormats(plan.sourcePath, info.streams, plan.compress, plan.stripOriginalCover !== false);
      const needCompress = Boolean(plan.compress?.enabled);
      const encoder = needCompress ? await this.probeEncoderSupport(plan.compress!, signal) : undefined;
      let source = plan.sourcePath, sourceStreams = streams, seekOffset: MediaTime = millisecondsTime(0);
      // 缺失包 PTS 的 AVI 等素材，直接跳转可能选到前一个 GOP。先无损整理时间戳与索引。
      if (await needsTimestampRepair(source, info, this.ffprobePath, signal)) {
        const normalized = path.join(directory, `normalized${resolveNormalizationExtension(streams)}`);
        await runMediaTool(this.ffmpegPath, ['-n', '-fflags', '+genpts', '-copyts', '-start_at_zero', '-i', source, ...streams.flatMap(stream => ['-map', `0:${stream.index}`]), '-c', 'copy', ...this.audioDispositions(streams), normalized], { signal });
        const normalizedInfo = await probeFile(normalized, this.ffprobePath, signal);
        seekOffset = subtractTime(await presentationStartTime(normalized, normalizedInfo, this.ffprobePath, signal), await presentationStartTime(source, info, this.ffprobePath, signal));
        source = normalized; sourceStreams = normalizedInfo.streams;
      }
      const pieces: string[] = [];
      for (let i = 0; i < plan.planSegments.length; i++) {
        const piece = path.join(directory, `segment_${i}${formats.intermediateExtension}`);
        await this.cut(source, plan.planSegments[i], piece, sourceStreams, signal, seekOffset); pieces.push(piece);
      }
      let originals = pieces;
      if (plan.concatToSingleFile && pieces.length > 1) { const merged = path.join(directory, `merged${formats.intermediateExtension}`); await this.concat(pieces, merged, directory, signal); originals = [merged]; }
      const finalFiles: string[] = [];
      for (let i = 0; i < originals.length; i++) {
        let output = originals[i];
        if (needCompress) { output = path.join(directory, `encoded_${i}${formats.outputExtension}`); await this.compressFile(originals[i], output, plan.compress!, encoder, signal); }
        await this.verify(output, streams, signal); finalFiles.push(output);
      }
      const destination = path.dirname(plan.outputPath || plan.sourcePath);
      await fs.promises.mkdir(destination, { recursive: true });
      const timestamp = formatTaskTimestamp();
      for (let attempt = 0; attempt < 10; attempt++) {
        if (signal?.aborted) throw new Error('操作已取消');
        const targets = resolveOutputBatch({ directory: destination, source: plan.sourcePath, title: plan.title, extension: formats.outputExtension, count: finalFiles.length, segmented: !plan.concatToSingleFile, timestamp });
        const published: Array<{ file: string; identity: fs.Stats }> = [];
        try {
          for (let i = 0; i < targets.length; i++) published.push({ file: targets[i], identity: await this.publishOne(finalFiles[i], targets[i], signal) });
          return { success: true, outputPath: targets[0], outputPaths: targets, resolvedEncoder: encoder };
        } catch (error: any) {
          if (error.code !== 'EEXIST') return { success: false, outputPath: published[0]?.file || plan.outputPath, outputPaths: published.map(entry => entry.file), error: `${error.message || error}${published.length ? `；已保留 ${published.length} 个完整分段：${published.map(entry => entry.file).join('、')}` : ''}` };
          for (const entry of published) await this.removePublished(entry.file, entry.identity);
        }
      }
      throw new Error('输出目录持续出现同名文件，未覆盖已有文件，请重试');
    } catch (error) { return { success: false, outputPath: plan.outputPath, error: error instanceof Error ? error.message : String(error) }; }
    finally { await removeOwnedDirectory(this.tmpDir, directory).catch(error => console.warn('本次切片缓存清理失败：', error)); }
  }
  resolveSafeSingleOutputPath(candidate: string, source: string, title?: string) { return resolveOutputBatch({ directory: path.dirname(candidate), source, extension: path.extname(candidate) || path.extname(source), title })[0]; }
  resolveSafeSegmentPaths(directory: string, _base: string, extension: string, count: number, source: string, title?: string) { return resolveOutputBatch({ directory, source, extension, count, title, segmented: true }); }
}
