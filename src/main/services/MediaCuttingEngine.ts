import path from 'path';
import fs from 'fs';
import { CacheMaintenanceService, externalTemporaryDirectory } from './CacheMaintenanceService';
import { PlanRecord, CutResult, MediaRetentionPlan, CompressConfig, ExecutionStatus, EngineState, PlanSegment, MediaStreamInfo, MediaTime, ExecutionProgress, OutputFilePlan, SpatialConfig } from '../../shared/types';
import { ExecutionProgressTracker, ExecutionStep } from './ExecutionProgress';
import { RetentionDraft } from '../../shared/RetentionDraft';
import { formatTaskTimestamp } from '../../shared/timeUtils';
import { buildCompressArgs, buildScaleFilterArgs } from '../../shared/compressPresets';
import { addTime, subtractTime, ceilMicroseconds, formatMicroseconds, millisecondsTime } from '../../shared/mediaTime';
import { KeyframeProber } from './KeyframeProber';
import { abortError, fileIdentityAsync, needsTimestampRepair, presentationStart, presentationStartTime, probeFile, ProbedFile, resolveTool, runMediaTool } from './MediaTools';
import { resolveFormats, resolveNormalizationExtension, retainedStreams } from './MediaFormatResolver';
import { resolveOutputBatch, resolveOutputDirectory } from './OutputPathResolver';
import { buildSpatialFiltergraph, hasSpatialEffects, spatialOutputSize, validateSpatial, Dimension } from '../../shared/spatialFiltergraph';
import { removeMp4Preroll } from './Mp4TimelineRepair';
import { exportPreciseFile, preciseAudioDefaults } from './PreciseExport';

type Encoder = 'cpu' | 'nvenc' | 'qsv';
type InputProvider = (file: string, signal?: AbortSignal) => Promise<{ url: string; close: () => Promise<void> }>;
type Job = { record: PlanRecord; prober: KeyframeProber; prepared?: { identity: string; info: ProbedFile } };
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
  private retryTask: Promise<void> | null = null;
  private closing = false;
  private cachedEncoders = new Map<string, Encoder>();
  private encoderJobs = new Map<string, { promise: Promise<Encoder>; controller: AbortController; consumers: Set<symbol> }>();
  private drainPromise: Promise<void> = Promise.resolve();
  private progress: ExecutionProgress | null = null;
  private progressRun: symbol | null = null;
  private inputProvider?: InputProvider;
  setInputProvider(provider: NonNullable<MediaCuttingEngine['inputProvider']>) { this.inputProvider = provider; }

  private maintenance: CacheMaintenanceService;
  private ownsMaintenance: boolean;
  private tempReady: Promise<void>;
  constructor(preferredPath?: string, customSlicesDir?: string, saver?: (record: PlanRecord) => any, listener?: PlanStatusListener, maintenance?: CacheMaintenanceService) {
    this.ffmpegPath = resolveTool('ffmpeg', preferredPath);
    this.ffprobePath = resolveTool('ffprobe', preferredPath ? path.join(path.dirname(preferredPath), 'ffprobe.exe') : undefined);
    const base = process.cwd();
    this.tmpDir = customSlicesDir || path.join(externalTemporaryDirectory(base), 'slices');
    this.ownsMaintenance = !maintenance;
    this.maintenance = maintenance ?? new CacheMaintenanceService(path.join(path.dirname(this.tmpDir), '.cache-maintenance'));
    this.tmpDir = path.join(this.tmpDir, 'managed');
    this.tempReady = this.maintenance.registerRoot(this.tmpDir);
    this.savePlanFn = saver; this.onStatusChange = listener;
  }
  updateTools(ffmpeg?: string, ffprobe?: string) { this.ffmpegPath = resolveTool('ffmpeg', ffmpeg); this.ffprobePath = resolveTool('ffprobe', ffprobe); this.cachedEncoders.clear(); }
  setStatusListener(listener: PlanStatusListener) { this.onStatusChange = listener; }
  setStateListener(listener: (state: EngineState) => void) { this.onStateChange = listener; }
  setPlanSaver(saver: (record: PlanRecord) => Promise<PlanRecord | void> | PlanRecord | void) { this.savePlanFn = saver; }
  getActivePlanId() { return this.active?.record.id || null; }
  getQueueLength() { return this.queue.length; }
  isAccepted(id: string) { return this.accepted.has(id) || this.submitting.has(id); }
  getState(): EngineState { return { activePlanId: this.getActivePlanId(), queuedIds: this.queue.map(job => job.record.id), storageError: this.storageError, progress: this.progress ? { ...this.progress } : null }; }
  private clearProgress() { this.progressRun = null; this.progress = null; }
  private stateChanged() { this.onStateChange?.(this.getState()); }
  private async persist(record: PlanRecord) { await this.savePlanFn?.(record); }
  private notify(record: PlanRecord) { this.onStatusChange?.({ planId: record.id, status: record.status, record: structuredClone(record), outputPath: record.outputPath || undefined, error: record.error }); }
  submitPlan(record: PlanRecord, prober: KeyframeProber): Promise<{ queued: boolean; active: boolean }> {
    const pending = this.submitting.get(record.id); if (pending) return pending;
    if (this.accepted.has(record.id)) return Promise.resolve({ queued: this.getActivePlanId() !== record.id, active: this.getActivePlanId() === record.id });
    const task = this.submissionChain.then(async () => {
      if (this.closing) throw new Error('应用正在退出，未接受新任务');
      if (this.storageError) throw new Error('方案保存尚未恢复，请在方案中心重试保存后再提交');
      const snapshot = structuredClone(record); snapshot.status = 'queued'; delete snapshot.error;
      if (snapshot.compressionOnly) {
        snapshot.totalDurationMs = null; snapshot.keptDurationMs = null; snapshot.outputPath = null;
        delete snapshot.outputPaths; delete snapshot.resolvedEncoder; snapshot.completedAt = null;
      }
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
      const run = Symbol(); this.progressRun = run;
      const tracker = new ExecutionProgressTracker(processing.id, value => {
        if (this.progressRun === run) { this.progress = value; this.stateChanged(); }
      });
      let final: PlanRecord;
      try {
        if (processing.sourceIdentity && processing.sourceIdentity !== await fileIdentityAsync(processing.sourcePath)) throw new Error('排队期间素材已变化，原方案切点未执行');
        const execution = this.executionSnapshot(tracker);
        let plan: MediaRetentionPlan;
        let prepared: ProbedFile | undefined;
        if (processing.compressionOnly) {
          const identity = await fileIdentityAsync(processing.sourcePath);
          prepared = job.prepared?.identity === identity ? job.prepared.info : await probeFile(processing.sourcePath, execution.ffprobePath, this.controller.signal);
          if (await fileIdentityAsync(processing.sourcePath) !== identity) throw new Error('检查期间素材发生变化，请重试');
          processing.totalDurationMs = prepared.durationMs; processing.keptDurationMs = prepared.durationMs;
          job.prepared = { identity, info: prepared };
          try { await this.persist(processing); }
          catch (error) {
            this.queue.unshift(job); this.active = null; this.controller = null; this.clearProgress(); this.blockStorage(error); return;
          }
          this.notify(processing);
          plan = { version: '1.0', title: processing.title, sourcePath: processing.sourcePath,
            outputPath: '', durationMs: prepared.durationMs, totalKeptDurationMs: prepared.durationMs,
            stripOriginalCover: processing.stripOriginalCover !== false,
            compress: processing.compress, outputs: [{ segmentIds: [], planSegments: [], spatialSegments: [] }], blockers: [] };
        } else {
          const meta = await job.prober.probe(processing.sourcePath, this.controller.signal);
          if (this.controller.signal.aborted) throw new Error('上次执行中断，可重试');
          const draft = RetentionDraft.fromRecord(processing, meta.durationMs);
          plan = draft.toPlan(meta.keyframes, { outputPath: processing.outputPath || processing.sourcePath, stripOriginalCover: processing.stripOriginalCover !== false, title: processing.title, keyframePoints: meta.keyframePoints });
        }
        const result = await execution.executeSnapshot(plan, this.controller.signal, processing.compressionOnly === true, prepared);
        final = result.success
          ? { ...processing, status: 'completed', outputPath: result.outputPath, outputPaths: result.outputPaths, resolvedEncoder: result.resolvedEncoder, completedAt: new Date().toISOString(), error: undefined }
          : { ...processing, status: 'failed', outputPath: result.outputPath, outputPaths: result.outputPaths, error: result.error || '剪辑失败' };
      } catch (error) { final = { ...processing, status: 'failed', error: error instanceof Error ? error.message : String(error) }; }
      if (final.compressionOnly && !final.outputPath) final.outputPath = null;
      if (final.status === 'completed') tracker.saving(); else tracker.failed();
      try { await this.persist(final); this.accepted.delete(final.id); this.notify(final); this.clearProgress(); }
      catch (error) { this.pendingFinal = final; this.blockStorage(error); }
      finally { this.active = null; this.controller = null; this.stateChanged(); }
    }
  }
  retryPendingWrites(): Promise<void> {
    if (this.retryTask) return this.retryTask;
    const pending = this.pendingFinal;
    this.retryTask = (async () => {
      if (pending) {
        await this.persist(pending);
        if (this.pendingFinal !== pending) return;
        this.accepted.delete(pending.id); this.notify(pending); this.pendingFinal = null; this.clearProgress();
      }
      this.storageError = null; this.stateChanged(); this.startDrain();
    })().finally(() => { this.retryTask = null; });
    return this.retryTask;
  }
  async shutdown() {
    this.closing = true; this.controller?.abort();
    const probes = [...this.encoderJobs.values()].map(job => { job.controller.abort(); return job.promise.catch(() => {}); });
    await this.submissionChain; await this.drainPromise; await this.retryTask?.catch(() => {}); await Promise.all(probes);
    if (this.ownsMaintenance) await this.maintenance.close();
  }

  async probeEncoderSupport(config: CompressConfig = { enabled: true, preset: 'balanced' }, signal?: AbortSignal): Promise<Encoder> {
    return this.probeEncoderSupportFor(this.ffmpegPath, config, signal);
  }
  private async probeEncoderSupportFor(ffmpegPath: string, config: CompressConfig, signal?: AbortSignal): Promise<Encoder> {
    if (signal?.aborted) throw abortError();
    if (config.hardwareAcceleration === false || config.encoder === 'cpu') return 'cpu';
    const target = config.preset === 'high_compression' ? 'hevc' : 'h264';
    const requested = config.encoder || 'auto';
    const key = `${ffmpegPath}:${target}:${requested}`;
    const existing = this.cachedEncoders.get(key); if (existing) return existing;
    let job = this.encoderJobs.get(key);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController(), executable = ffmpegPath;
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
  private executionSnapshot(tracker?: ExecutionProgressTracker): PlanExecution {
    const ffmpegPath = this.ffmpegPath;
    return new PlanExecution(ffmpegPath, this.ffprobePath, this.tmpDir, this.maintenance, this.tempReady,
      (config, signal) => this.probeEncoderSupportFor(ffmpegPath, config, signal), this.inputProvider, tracker);
  }
  executeRawPlan(plan: MediaRetentionPlan, signal?: AbortSignal): Promise<CutResult> { return this.executionSnapshot().executeSnapshot(plan, signal); }
  async compressFile(input: string, output: string, config: CompressConfig, encoder: Encoder = 'cpu', signal?: AbortSignal, spatialFilterArgs?: string[], progressKey?: string, cpuRetry = false, stripCover = false, prepared?: ProbedFile): Promise<void> {
    return this.executionSnapshot().compressFile(input, output, config, encoder, signal, spatialFilterArgs, progressKey, cpuRetry, stripCover, prepared);
  }
  resolveSafeSingleOutputPath(candidate: string, source: string, title?: string) { return resolveOutputBatch({ directory: path.dirname(candidate), source, extension: path.extname(candidate) || path.extname(source), title })[0]; }
  resolveSafeSegmentPaths(directory: string, _base: string, extension: string, count: number, source: string, title?: string) { return resolveOutputBatch({ directory, source, extension, count, title, segmented: true }); }
}

/** 单次导出固定配置并借用共享资源，队列与共享服务的关闭责任仍归原引擎。 */
class PlanExecution {
  constructor(
    private readonly ffmpegPath: string,
    readonly ffprobePath: string,
    private readonly tmpDir: string,
    private readonly maintenance: CacheMaintenanceService,
    private readonly tempReady: Promise<void>,
    private readonly probeEncoderSupport: (config: CompressConfig, signal?: AbortSignal) => Promise<Encoder>,
    private readonly inputProvider?: InputProvider,
    private readonly tracker?: ExecutionProgressTracker,
  ) {}
  private async runStep(key: string | undefined, args: string[], durationMs: number, signal?: AbortSignal, cpuRetry = false) {
    if (!this.tracker || !key) { await runMediaTool(this.ffmpegPath, args, { signal }); return; }
    const onOutput = this.tracker.start(key, durationMs, cpuRetry);
    // 这些输出均以零为时间原点：普通命令由 FFmpeg 重置输入起点，整理命令显式 start_at_zero。
    await runMediaTool(this.ffmpegPath, ['-progress', 'pipe:1', '-nostats', ...args], { signal, captureOutput: false, onOutput });
    this.tracker.complete(key);
  }
  async compressFile(input: string, output: string, config: CompressConfig, encoder: Encoder = 'cpu', signal?: AbortSignal, spatialFilterArgs?: string[], progressKey?: string, cpuRetry = false, stripCover = false, prepared?: ProbedFile): Promise<void> {
    const info = prepared || await probeFile(input, this.ffprobePath, signal);
    await this.runStep(progressKey, buildCompressArgs(input, output, config, encoder, { streams: retainedStreams(info.streams, stripCover), stripCover: false, spatialFilterArgs }), info.durationMs, signal, cpuRetry);
  }
  private async cut(source: string, segment: PlanSegment, output: string, streams: MediaStreamInfo[], signal?: AbortSignal, offset = millisecondsTime(0), progressKey?: string, prepared?: ProbedFile) {
    let startUs = ceilMicroseconds(addTime(segment.seekTime || millisecondsTime(segment.safeRange.startMs), offset));
    if (startUs < 0n) startUs = 0n;
    const endUs = ceilMicroseconds(addTime(millisecondsTime(segment.safeRange.endMs), offset));
    if (endUs <= startUs) throw new Error('保留区间没有有效时长');
    const info = prepared || await probeFile(source, this.ffprobePath, signal);
    const originUs = ceilMicroseconds(info.origin);
    // 音频可能比首幅视频更早；保留片头时以首幅视频核验关键帧，不能把公共零点当作视频包。
    const targetUs = originUs + (startUs === 0n && !segment.seekTime ? ceilMicroseconds(millisecondsTime(info.videoStartMs)) : startUs);
    // 只在执行裁剪时读取切点附近的包；用关键帧 DTS 定位，避免 B 帧导致退到前一个 GOP。
    const packets = JSON.parse(await runMediaTool(this.ffprobePath, ['-v', 'error', '-select_streams', String(info.videoIndex), '-read_intervals', `${formatMicroseconds(targetUs > 1000000n ? targetUs - 1000000n : 0n)}%${formatMicroseconds(targetUs + 1000000n)}`, '-show_packets', '-show_data_hash', 'crc32', '-show_entries', 'packet=pts_time,dts_time,flags,data_hash', '-of', 'json', source], { signal, timeoutMs: 30000 })).packets || [];
    const key = packets.find((p: any) => p.flags?.includes('K') && Number.isFinite(Number(p.dts_time)) && Math.abs(Number(p.pts_time) * 1e6 - Number(targetUs)) <= 2);
    if (!key) throw new Error('未找到方案指定的关键帧，已停止导出，请重新分析素材');
    const decodeUs = BigInt(Math.round(Number(key.dts_time) * 1e6));
    const durationUs = endUs + originUs - decodeUs;
    const mp4 = ['.mp4', '.mov', '.m4v'].includes(path.extname(output).toLowerCase());
    // FLV 片头不作输入寻址；其他位置可能退回较早的 GOP，保留源时间戳后
    // 再按目标 DTS 丢弃前置包，避免错误起帧。仍逐段流复制，不生成整片副本。
    const inputSeek = decodeUs > originUs ? ['-seek2any', '1', '-seek_timestamp', '1', '-ss', formatMicroseconds(decodeUs)] : [];
    await this.runStep(progressKey, ['-n', '-copyts', ...inputSeek, '-i', source, '-ss', formatMicroseconds(decodeUs), '-t', formatMicroseconds(durationUs), '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...(mp4 ? ['-movie_timescale', '720000'] : []), ...streams.flatMap(stream => ['-map', `0:${stream.index}`]), ...this.audioDispositions(streams), output], Number(durationUs) / 1000, signal);
    const first = JSON.parse(await runMediaTool(this.ffprobePath, ['-v', 'error', '-select_streams', 'V:0', '-read_intervals', '%+#1', '-show_packets', '-show_data_hash', 'crc32', '-show_entries', 'packet=pts_time,flags,data_hash', '-of', 'json', output], { signal, timeoutMs: 30000 })).packets?.[0];
    if (!first?.flags?.includes('K') || first.data_hash !== key.data_hash) throw new Error('导出首帧与方案关键帧不符，已停止发布输出');
  }
  private async concat(files: string[], output: string, directory: string, signal?: AbortSignal, progressKey?: string) {
    const list = path.join(directory, 'concat.txt');
    await this.maintenance.allowTaskFile(directory, list);
    await fs.promises.writeFile(list, files.map(file => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const info = await probeFile(files[0], this.ffprobePath, signal);
    let durationMs = info.containerDurationMs;
    // 分段数可能很多，逐个读取元数据，避免进度统计同时启动大量 FFprobe。
    for (const file of files.slice(1)) durationMs += (await probeFile(file, this.ffprobePath, signal)).containerDurationMs;
    await this.runStep(progressKey, ['-n', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c', 'copy', ...this.audioDispositions(info.streams), output], durationMs, signal);
  }
  private audioDispositions(streams: MediaStreamInfo[]) { return streams.filter(stream => stream.type === 'audio').flatMap((stream, index) => [`-disposition:a:${index}`, stream.default ? 'default' : '0']); }
  private async verify(file: string, expected: MediaStreamInfo[], signal?: AbortSignal, precise = false) {
    const info = await probeFile(file, this.ffprobePath, signal);
    const original = precise ? preciseAudioDefaults(expected) : expected.filter(stream => stream.type === 'audio'), actual = info.streams.filter(stream => stream.type === 'audio');
    if (original.length !== actual.length || original.some((stream, index) => (precise ? actual[index].codec !== 'aac' : stream.codec !== actual[index].codec) || (stream.language && stream.language !== actual[index].language) || (precise && stream.default !== actual[index].default))) throw new Error('导出音轨数量、编码、语言或默认轨与预期不一致，产物未发布');
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
  /** 一份安全覆盖只编码一次；视频在解码后按逻辑边界分窗，音轨不跟随窗口重复。 */
  private async spatialPiece(input: string, output: string, pieces: string[], unions: PlanSegment[], plan: OutputFilePlan, size: Dimension, target: Dimension | undefined, config: CompressConfig, encoder: Encoder, signal?: AbortSignal, progressKey?: string, cpuRetry = false) {
    const info = await probeFile(input, this.ffprobePath, signal);
    const startMs = await presentationStart(input, info, this.ffprobePath, signal);
    const segments = plan.spatialSegments;
    const logical: Array<{ startMs: number; spatialConfig: SpatialConfig | undefined }> = [];
    let elapsedMs = 0, firstStartMs = 0;
    // concat demuxer 以各文件的容器时长推进时间轴。采用中间素材实测值，不能用请求切片时长替代。
    for (let p = 0; p < pieces.length; p++) {
      const pieceInfo = await probeFile(pieces[p], this.ffprobePath, signal);
      const pieceStartMs = await presentationStart(pieces[p], pieceInfo, this.ffprobePath, signal);
      if (p === 0) firstStartMs = pieceStartMs;
      const union = unions[p];
      const windows = segments.filter(segment => segment.userRange.startMs < union.userRange.endMs && segment.userRange.endMs > union.userRange.startMs);
      if (!windows.length) throw new Error('画面配置窗口与安全区间不一致');
      windows.forEach((segment, i) => logical.push({
        startMs: elapsedMs + pieceStartMs - firstStartMs + startMs + (i ? windows[i - 1].userRange.endMs - union.safeRange.startMs : 0),
        spatialConfig: segment.spatialConfig,
      }));
      elapsedMs += pieceInfo.containerDurationMs;
    }
    const parts: string[] = [];
    const sampleAspect = info.displayAspectRatio / (info.width / info.height);
    const configurations: Array<SpatialConfig | undefined> = [], keys: string[] = [];
    const indices = logical.map(window => {
      const key = JSON.stringify(window.spatialConfig ?? null);
      let index = keys.indexOf(key);
      if (index < 0) { index = keys.length; keys.push(key); configurations.push(window.spatialConfig); }
      return index;
    });
    if (configurations.length > 1) {
      const commands = logical.flatMap((window, i) => i > 0 && indices[i] !== indices[i - 1] ? [`${(window.startMs / 1000).toFixed(6)} spatial map ${indices[i]}`] : []);
      parts.push(`[0:${info.videoIndex}]sendcmd=c='${commands.join(';')}',split=${configurations.length}${configurations.map((_, i) => `[win${i}]`).join('')}`);
    }
    for (let i = 0; i < configurations.length; i++) {
      const filters = buildSpatialFiltergraph(size, configurations[i], target, `w${i}_`)[1];
      parts.push(`${configurations.length > 1 ? `[win${i}]` : `[0:${info.videoIndex}]`}${filters ? filters + ',' : ''}setsar=${sampleAspect.toFixed(9)}[done${i}]`);
    }
    // 各路保持相同时间轴，按边界切换画面；避免 trim + interleave 为等待后段缓存整段解码帧。
    const concat = configurations.length > 1 ? `${configurations.map((_, i) => `[done${i}]`).join('')}streamselect@spatial=inputs=${configurations.length}:map=0` : '[done0]null';
    const scale = buildScaleFilterArgs(config)[1];
    parts.push(`${concat}${scale ? ',' + scale : ''}[spatialVideo]`);
    await this.runStep(progressKey, buildCompressArgs(input, output, config, encoder, { streams: info.streams, stripCover: false, videoFilterGraph: { graph: parts.join(';'), streamIndex: info.videoIndex, output: 'spatialVideo', timeBase: info.timeBase } }), info.durationMs, signal, cpuRetry);
  }
  async executeSnapshot(plan: MediaRetentionPlan, signal?: AbortSignal, compressionOnly = false, prepared?: ProbedFile): Promise<CutResult> {
    this.maintenance.protect(plan.sourcePath);
    await this.tempReady;
    const directory = await this.maintenance.create(this.tmpDir, 'task', '');
    return this.maintenance.task(directory, async () => {
    let indexedInput: { url: string; close: () => Promise<void> } | undefined;
    try {
      if (!plan.outputs.length || (!compressionOnly && plan.outputs.some(output => !output.planSegments.length))) throw new Error('未选择任何保留片段');
      const destination = resolveOutputDirectory(plan.sourcePath, compressionOnly);
      const sourceIdentity = await fileIdentityAsync(plan.sourcePath);
      const info = prepared || await probeFile(plan.sourcePath, this.ffprobePath, signal);
      if (!compressionOnly) indexedInput = await this.inputProvider?.(plan.sourcePath, signal);
      const streams = retainedStreams(info.streams, plan.stripOriginalCover !== false);
      const precise = plan.exportPrecision === 'frame';
      if (precise && (compressionOnly || plan.compress?.enabled)) throw new Error('精确导出不能同时使用智能降码或整片压缩');
      const sourceDim = { width: info.width, height: info.height };
      const configs = plan.outputs.flatMap(output => output.spatialSegments.map(segment => segment.spatialConfig));
      configs.forEach(config => validateSpatial(config, sourceDim));
      const hasSpatial = configs.some(config => hasSpatialEffects(config, sourceDim));
      const needCompress = !precise && (Boolean(plan.compress?.enabled) || hasSpatial);
      const effectiveCompressConfig: CompressConfig = (plan.compress && plan.compress.enabled)
        ? plan.compress
        : { enabled: true, preset: 'balanced', crf: 22 };
      const formats = precise ? { intermediateExtension: '.nut', outputExtension: '.mp4' } : resolveFormats(plan.sourcePath, info.streams, needCompress ? effectiveCompressConfig : undefined, plan.stripOriginalCover !== false);
      let encoder: Encoder | undefined = precise ? 'cpu' : needCompress ? await this.probeEncoderSupport(effectiveCompressConfig, signal) : undefined;
      const encode = async (output: string, work: (selected: Encoder, retry: boolean) => Promise<void>) => {
        try { await work(encoder!, false); }
        catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const initializationFailed = /InitializeEncoder failed|minimum supported|No capable devices|Error initializing.*encoder/i.test(detail);
          if (signal?.aborted || encoder === 'cpu' || !initializationFailed) throw error;
          if (effectiveCompressConfig.encoder && effectiveCompressConfig.encoder !== 'auto') throw new Error(`指定硬件编码器不支持当前画幅或参数，请选择自动或 CPU。${detail}`);
          // 只删除本次任务临时目录中的失败产物，再由 CPU 完整重试。
          await fs.promises.unlink(output).catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
          encoder = 'cpu'; await work(encoder, true);
        }
      };
      let source = indexedInput?.url || plan.sourcePath, sourceStreams = streams, seekOffset: MediaTime = millisecondsTime(0), sourceInfo = info;
      const repairTimestamps = !precise && await needsTimestampRepair(source, info, this.ffprobePath, signal);
      const durations = plan.outputs.map(output => compressionOnly ? [info.durationMs] : output.planSegments.map(segment => segment.safeRange.endMs - Number(ceilMicroseconds(segment.seekTime || millisecondsTime(segment.safeRange.startMs))) / 1000));
      const outputCount = plan.outputs.length;
      const steps: ExecutionStep[] = [];
      if (repairTimestamps) steps.push({ key: 'normalize', stage: 'normalizing', durationMs: info.durationMs });
      durations.forEach((members, i) => {
        if (precise) {
          plan.outputs[i].spatialSegments.forEach((segment, j) => steps.push({ key: `exact:${i}:${j}`, stage: 'encoding', durationMs: segment.userRange.endMs - segment.userRange.startMs, current: i + 1, total: outputCount }));
          steps.push({ key: `exact-final:${i}`, stage: 'merging', durationMs: members.reduce((a, b) => a + b, 0), current: i + 1, total: outputCount });
          return;
        }
        if (!compressionOnly) members.forEach((durationMs, j) => steps.push({ key: `cut:${i}:${j}`, stage: 'cutting', durationMs, current: i + 1, total: outputCount }));
        const durationMs = members.reduce((sum, duration) => sum + duration, 0);
        if (members.length > 1) steps.push({ key: `merge:${i}`, stage: 'merging', durationMs, current: i + 1, total: outputCount });
        if (needCompress) steps.push({ key: `encode:${i}`, stage: 'encoding', durationMs, current: i + 1, total: outputCount });
      });
      this.tracker?.configure(steps, outputCount);
      // 缺失包 PTS 的 AVI 等素材，直接跳转可能选到前一个 GOP。先无损整理时间戳与索引。
      if (repairTimestamps) {
        const normalized = path.join(directory, `normalized${resolveNormalizationExtension(streams)}`);
        await this.runStep('normalize', ['-n', '-fflags', '+genpts', '-copyts', '-start_at_zero', '-i', source, ...streams.flatMap(stream => ['-map', `0:${stream.index}`]), '-c', 'copy', ...this.audioDispositions(streams), normalized], info.durationMs, signal);
        const normalizedInfo = await probeFile(normalized, this.ffprobePath, signal);
        if (!compressionOnly) seekOffset = subtractTime(await presentationStartTime(normalized, normalizedInfo, this.ffprobePath, signal), await presentationStartTime(source, info, this.ffprobePath, signal));
        source = normalized; sourceStreams = normalizedInfo.streams; sourceInfo = normalizedInfo;
      }

      const finalFiles: string[] = [];
      for (let i = 0; i < plan.outputs.length; i++) {
        const filePlan = plan.outputs[i];
        if (precise) {
          const output = await exportPreciseFile({ plan: { ...plan, sourcePath: source }, filePlan, fileIndex: i, info, streams, directory, ffprobe: this.ffprobePath, signal,
            run: (key, args, duration, abort) => this.runStep(key, args, duration, abort), allowFile: file => this.maintenance.allowTaskFile(directory, file) });
          this.tracker?.stage('verifying', i + 1, outputCount);
          await this.verify(output, streams, signal, true);
          finalFiles.push(output); this.tracker?.finishOperation(`verify:${i}`);
          continue;
        }
        const pieces: string[] = compressionOnly ? [source] : [];
        for (let j = 0; j < filePlan.planSegments.length; j++) {
          const piece = path.join(directory, `segment_${i}_${j}${formats.intermediateExtension}`);
          await this.cut(source, filePlan.planSegments[j], piece, sourceStreams, signal, seekOffset, `cut:${i}:${j}`, sourceInfo);
          pieces.push(piece);
        }
        let input = pieces[0];
        if (pieces.length > 1) {
          input = path.join(directory, `merged_${i}${formats.intermediateExtension}`);
          await this.concat(pieces, input, directory, signal, `merge:${i}`);
        }
        let output = input;
        const fileHasSpatial = filePlan.spatialSegments.some(segment => hasSpatialEffects(segment.spatialConfig, sourceDim));
        if (fileHasSpatial) {
          const target = spatialOutputSize(sourceDim, filePlan.spatialSegments[0]?.spatialConfig);
          output = path.join(directory, `spatial_${i}${formats.outputExtension}`);
          await encode(output, (selected, retry) => this.spatialPiece(input, output, pieces, filePlan.planSegments, filePlan, sourceDim, target, effectiveCompressConfig, selected, signal, `encode:${i}`, retry));
        } else if (needCompress) {
          output = path.join(directory, `encoded_${i}${formats.outputExtension}`);
          await encode(output, (selected, retry) => this.compressFile(input, output, effectiveCompressConfig, selected, signal, undefined, `encode:${i}`, retry, compressionOnly && plan.stripOriginalCover, compressionOnly ? sourceInfo : undefined));
        }
        // 完成拼接后才统一移动展示起点；修改中间片会使跨段解码时间重叠。
        if (!needCompress && ['.mp4', '.mov', '.m4v'].includes(path.extname(output).toLowerCase())) {
          const packet = JSON.parse(await runMediaTool(this.ffprobePath, ['-v', 'error', '-select_streams', 'V:0', '-read_intervals', '%+#1', '-show_packets', '-show_entries', 'packet=pts_time', '-of', 'json', output], { signal, timeoutMs: 30000 })).packets?.[0];
          if (!Number.isFinite(Number(packet?.pts_time))) throw new Error('无法校准导出展示起点');
          const file = await fs.promises.open(output, 'r+');
          try { await removeMp4Preroll(file, BigInt(Math.round(Number(packet.pts_time) * 1e6))); } finally { await file.close(); }
        }
        this.tracker?.stage('verifying', i + 1, outputCount);
        await this.verify(output, streams, signal); finalFiles.push(output);
        this.tracker?.finishOperation(`verify:${i}`);
      }
      await fs.promises.mkdir(destination, { recursive: true });
      if (await fileIdentityAsync(plan.sourcePath) !== sourceIdentity) throw new Error('导出期间原片发生变化，未发布结果');
      const timestamp = formatTaskTimestamp();
      for (let attempt = 0; attempt < 10; attempt++) {
        if (signal?.aborted) throw new Error('操作已取消');
        const targets = resolveOutputBatch({ directory: destination, source: plan.sourcePath, title: plan.title, extension: formats.outputExtension, count: finalFiles.length, segmented: finalFiles.length > 1, timestamp });
        const published: Array<{ file: string; identity: fs.Stats }> = [];
        try {
          for (let i = 0; i < targets.length; i++) {
            this.tracker?.stage('publishing', i + 1, targets.length);
            published.push({ file: targets[i], identity: await this.publishOne(finalFiles[i], targets[i], signal) });
            this.tracker?.finishOperation(`publish:${i}`);
          }
          return { success: true, outputPath: targets[0], outputPaths: targets, resolvedEncoder: encoder };
        } catch (error: any) {
          if (error.code !== 'EEXIST') return { success: false, outputPath: published[0]?.file || plan.outputPath, outputPaths: published.map(entry => entry.file), error: `${error.message || error}${published.length ? `；已保留 ${published.length} 个完整分段：${published.map(entry => entry.file).join('、')}` : ''}` };
          for (const entry of published) await this.removePublished(entry.file, entry.identity);
        }
      }
      throw new Error('输出目录持续出现同名文件，未覆盖已有文件，请重试');
    } catch (error) { return { success: false, outputPath: plan.outputPath, error: error instanceof Error ? error.message : String(error) }; }
    finally {
      await indexedInput?.close().catch(error => console.warn('索引输入关闭失败：', error));
      await this.maintenance.abandon(directory).catch(error => console.warn('本次切片缓存收尾失败：', error));
    this.maintenance.release(directory); await this.maintenance.sweep();
    }
    });
  }
}
