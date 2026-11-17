import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { ProcessingError, ProcessingProgress, ProcessingRequest, ProcessingResult } from '../../shared/processingTask';
import { PlanRecord } from '../../shared/types';
import { ProcessingRuntime } from './ProcessingRuntime';
import { validateCompress } from './ProcessingValidation';
import { resolveFormats } from './MediaFormatResolver';
import { abortError, probeCompressionFile, resolveTool, runMediaTool } from './MediaTools';

export class ProcessingTaskService {
  private controller = new AbortController();
  private currentId?: string;
  private started = false;
  private listeners = new Set<(progress: ProcessingProgress) => void>();
  constructor(private runtime: ProcessingRuntime, private mode: 'desktop' | 'cli' = 'cli') {}
  subscribeProgress(listener: (progress: ProcessingProgress) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  cancel() { this.controller.abort(); }
  private checkCancelled() { if (this.controller.signal.aborted) throw abortError(); }
  private async prepare(request: ProcessingRequest): Promise<PlanRecord> {
    if (!['compress', 'cut'].includes(request.operation) || !path.isAbsolute(request.inputPath) || !path.isAbsolute(request.outputPath)) throw new ProcessingError('INVALID_ARGUMENT', '操作及绝对路径无效', 2);
    validateCompress(request.compress);
    if (request.operation === 'compress' && !request.compress?.enabled) throw new ProcessingError('INVALID_ARGUMENT', '缺少压缩参数', 2);
    if (request.operation === 'cut' && request.compress) throw new ProcessingError('INVALID_ARGUMENT', '无损剪切不接受压缩参数', 2);
    let source: string;
    try { source = await fs.promises.realpath(request.inputPath); const handle = await fs.promises.open(source, 'r'); try { if (!(await handle.stat()).isFile()) throw new Error('原片不是文件'); } finally { await handle.close(); } }
    catch (error) { throw new ProcessingError('INPUT_INVALID', `原片不可读取：${String(error)}`); }
    const parent = await fs.promises.realpath(path.dirname(request.outputPath));
    await fs.promises.access(parent, fs.constants.W_OK);
    const output = path.join(parent, path.basename(request.outputPath));
    const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (key(source) === key(output)) throw new ProcessingError('INPUT_OUTPUT_SAME', '原片和目标不能相同');
    try {
      const existing = await fs.promises.stat(output), input = await fs.promises.stat(source);
      if (existing.dev === input.dev && existing.ino === input.ino) throw new ProcessingError('INPUT_OUTPUT_SAME', '原片和目标指向同一文件');
      throw new ProcessingError('OUTPUT_EXISTS', '目标文件已存在');
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    // 包括失效链接，不能把它当作空闲文件名。
    try { await fs.promises.lstat(output); throw new ProcessingError('OUTPUT_EXISTS', '目标路径已存在'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const config = this.runtime.config.getConfig();
    for (const [name, configured] of [['ffmpeg', config.ffmpegPath], ['ffprobe', config.ffprobePath]] as const) {
      try { if (configured) await fs.promises.access(configured); await runMediaTool(resolveTool(name, configured), ['-version'], { signal: this.controller.signal, timeoutMs: 10000 }); }
      catch (error) { this.checkCancelled(); throw new ProcessingError('TOOL_UNAVAILABLE', `媒体工具不可用：${name}；${String(error)}`); }
    }
    this.checkCancelled();
    const common = { id: this.currentId!, title: 'CLI', sourcePath: source, requestedOutputPath: output, stripOriginalCover: request.stripCover, status: 'ready' as const, updatedAt: new Date().toISOString(), completedAt: null };
    if (request.operation === 'compress') {
      const inspection = await probeCompressionFile(source, resolveTool('ffprobe', config.ffprobePath), this.controller.signal);
      if (inspection.check === 'invalid') throw new ProcessingError('INPUT_INVALID', inspection.message || '原片无视频流');
      // 只做有限检查；精确时长及流/容器校验在引擎执行准备阶段完成。
      return { ...common, compressionOnly: true, compress: request.compress!, outputDirectory: parent, outputPath: null, totalDurationMs: null, keptDurationMs: null, cutsCount: 0, cuts: [], decisions: { seg_0: 'keep' } };
    }
    const ranges = request.ranges;
    if (!ranges?.length || ranges.length > 5000 || ranges.some((range, i) => !Number.isSafeInteger(range.startMs) || !Number.isSafeInteger(range.endMs) || range.startMs < 0 || range.endMs <= range.startMs || (i > 0 && range.startMs < ranges[i - 1].endMs))) throw new ProcessingError('INVALID_ARGUMENT', '保留区间无效', 2);
    const meta = await this.runtime.indexes.prober.probe(source, this.controller.signal);
    if (ranges.some(range => range.endMs > meta.durationMs)) throw new ProcessingError('INVALID_ARGUMENT', '保留区间超过素材有效时长', 2);
    const formats = resolveFormats(source, meta.streams || [], undefined, request.stripCover);
    if (path.extname(output).toLowerCase() !== formats.outputExtension) throw new ProcessingError('CONTAINER_UNSUPPORTED', `目标后缀必须为 ${formats.outputExtension}`);
    const cuts = [...new Set(ranges.flatMap(range => [range.startMs, range.endMs]).filter(time => time > 0 && time < meta.durationMs))].sort((a, b) => a - b);
    const bounds = [0, ...cuts, meta.durationMs];
    const decisions: PlanRecord['decisions'] = {};
    for (let i = 0; i < bounds.length - 1; i++) decisions[`seg_${i}`] = ranges.some(range => range.startMs <= bounds[i] && range.endMs >= bounds[i + 1]) ? 'keep' : 'discard';
    return { ...common, sourceIdentity: meta.sourceIdentity, outputPath: '', outputMode: 'single', outputGroups: {}, exportPrecision: 'keyframe', cuts, cutsCount: cuts.length, decisions, totalDurationMs: meta.durationMs, keptDurationMs: ranges.reduce((sum, range) => sum + range.endMs - range.startMs, 0) };
  }
  async submit(request: ProcessingRequest): Promise<ProcessingResult> {
    if (this.started) throw new Error('每个任务服务只接受一次提交');
    this.started = true; this.currentId = randomUUID();
    const id = this.currentId, engine = this.runtime.engine;
    const base = { taskId: id, operation: request.operation, outputPaths: [] as string[] };
    let unsubscribe = () => {}; let submitted = false;
    const failed = (error: unknown, defaultCode: string): ProcessingResult => {
      const snapshot = engine.getExecutionSnapshot(id);
      const message = error instanceof Error ? error.message : String(error);
      const code = snapshot.storageError ? 'STORAGE_FAILED' : error instanceof ProcessingError ? error.code : /CLEANUP_FAILED/.test(message) ? 'CLEANUP_FAILED' : /OUTPUT_EXISTS/.test(message) ? 'OUTPUT_EXISTS' : /容器|后缀/.test(message) ? 'CONTAINER_UNSUPPORTED' : /占用|锁定|其他进程使用/.test(message) ? 'DIRECTORY_BUSY' : /编码器/.test(message) ? 'ENCODER_UNAVAILABLE' : defaultCode;
      return { ...base, ok: false, status: 'failed', outputPaths: snapshot.outputPaths, error: { code, message: snapshot.storageError || message } };
    };
    try {
      try { await this.runtime.plans.ready; } catch (error) { throw new ProcessingError('STORAGE_FAILED', `方案存储初始化失败：${String(error)}`, 5); }
      const record = await this.prepare(structuredClone(request)); this.checkCancelled();
      let wake!: () => void;
      const done = new Promise<void>(resolve => { wake = resolve; });
      const inspect = () => {
        const snapshot = engine.getExecutionSnapshot(id);
        if (snapshot.progress) for (const listener of this.listeners) listener(snapshot.progress);
        if (snapshot.storageError || snapshot.completedPersisted || snapshot.record?.status === 'failed' || this.controller.signal.aborted) wake();
      };
      unsubscribe = engine.subscribeExecution(inspect);
      this.controller.signal.addEventListener('abort', inspect, { once: true });
      try {
        try { await this.runtime.plans.submitDraft(record); submitted = true; }
        catch (error) { throw new ProcessingError('STORAGE_FAILED', `任务提交或记录保存失败：${String(error)}`, 5); }
        inspect(); await done;
        let snapshot = engine.getExecutionSnapshot(id);
        if (snapshot.storageError) {
          const result = failed(new Error(snapshot.storageError), 'STORAGE_FAILED');
          if (this.mode === 'cli') {
            try { await engine.stopAfterStorageFailure(); } catch (error) { result.error!.details = [String(error)]; }
          }
          result.outputPaths = engine.getExecutionSnapshot(id).outputPaths;
          return result;
        }
        if (snapshot.completedPersisted) return { ...base, ok: true, status: 'completed', outputPaths: snapshot.outputPaths, resolvedEncoder: snapshot.record?.resolvedEncoder, warnings: request.operation === 'cut' ? ['按关键帧保全内容；实际起点可能提前、片尾扩出，多个区间可能因扩展重叠。'] : [] };
        if (this.controller.signal.aborted) {
          const cancellation = await this.runtime.plans.cancelPlan(id);
          snapshot = engine.getExecutionSnapshot(id);
          if (snapshot.completedPersisted) return { ...base, ok: true, status: 'completed', outputPaths: snapshot.outputPaths, resolvedEncoder: snapshot.record?.resolvedEncoder, warnings: [] };
          if (!cancellation.success || snapshot.storageError) return failed(new Error(cancellation.message || '取消收尾失败'), 'CLEANUP_FAILED');
          return { ...base, ok: false, status: 'cancelled', outputPaths: snapshot.outputPaths, error: { code: 'CANCELLED', message: '用户已取消' } };
        }
        return failed(new Error(snapshot.record?.error || '任务执行失败'), 'EXECUTION_FAILED');
      } finally { this.controller.signal.removeEventListener('abort', inspect); }
    } catch (error) {
      if (this.controller.signal.aborted && !submitted && !(error instanceof ProcessingError && error.code === 'STORAGE_FAILED')) return { ...base, ok: false, status: 'cancelled', error: { code: 'CANCELLED', message: '用户已取消' } };
      const result = failed(error, submitted ? 'EXECUTION_FAILED' : 'PRECHECK_FAILED');
      if (result.error?.code === 'STORAGE_FAILED' && this.mode === 'cli') {
        try { await engine.stopAfterStorageFailure(); } catch (cleanup) { result.error.details = [String(cleanup)]; }
        result.outputPaths = engine.getExecutionSnapshot(id).outputPaths;
      }
      return result;
    } finally { unsubscribe(); }
  }
}
