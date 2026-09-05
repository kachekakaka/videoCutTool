import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { PlanRecord, CutResult, MediaRetentionPlan } from '../../shared/types';
import { RetentionDraft } from '../../shared/RetentionDraft';
import { formatTaskTimestamp } from '../../shared/timeUtils';
import { KeyframeProber } from './KeyframeProber';

export type PlanStatusListener = (event: {
  planId: string;
  status: 'processing' | 'completed' | 'failed';
  outputPath?: string;
  error?: string;
  record?: PlanRecord;
}) => void;

/**
 * MediaCuttingEngine: 后台异步剪辑执行引擎
 * 负责单任务串行 FIFO 队列调度、无损流复制执行、临时切片生命周期 GC 与方案状态机跃迁
 */
export class MediaCuttingEngine {
  private ffmpegPath: string;
  private tmpDir: string;
  private queue: Array<{ record: PlanRecord; prober: KeyframeProber }> = [];
  private isRunning: boolean = false;
  private activePlanId: string | null = null;
  private onStatusChange?: PlanStatusListener;
  private savePlanFn?: (record: PlanRecord) => void;

  constructor(
    preferredPath?: string,
    customSlicesDir?: string,
    savePlanFn?: (record: PlanRecord) => void,
    onStatusChange?: PlanStatusListener
  ) {
    const resourcesPath = (process as any).resourcesPath;
    const candidates = [
      resourcesPath ? path.join(resourcesPath, 'bin', 'ffmpeg.exe') : '',
      resourcesPath ? path.join(resourcesPath, 'tools', 'ffmpeg.exe') : '',
      preferredPath,
      'D:/Tools/ffmpeg/ffmpeg.exe',
      'D:\\Tools\\ffmpeg\\ffmpeg.exe',
      './tools/ffmpeg.exe',
      path.resolve(process.cwd(), 'tools/ffmpeg.exe'),
    ].filter(Boolean) as string[];

    const matched = candidates.find((p) => fs.existsSync(p));
    this.ffmpegPath = matched || 'ffmpeg';

    // 切片缓存统一存放至同级外部目录 ../videoCutTool_tmp/slices/
    const baseCwd = process.cwd();
    const fallbackTmp = path.basename(baseCwd).toLowerCase() === 'release'
      ? path.resolve(baseCwd, '../../videoCutTool_tmp')
      : path.resolve(baseCwd, '../videoCutTool_tmp');
    this.tmpDir = customSlicesDir
      ? path.resolve(customSlicesDir)
      : path.resolve(fallbackTmp, 'slices');

    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }

    this.savePlanFn = savePlanFn;
    this.onStatusChange = onStatusChange;
  }

  public setStatusListener(listener: PlanStatusListener) {
    this.onStatusChange = listener;
  }

  public setPlanSaver(saver: (record: PlanRecord) => void) {
    this.savePlanFn = saver;
  }

  /**
   * 提交方案至后台执行队列
   */
  public submitPlan(
    record: PlanRecord,
    prober: KeyframeProber
  ): { queued: boolean; active: boolean } {
    if (this.isRunning) {
      record.status = 'ready';
      if (this.savePlanFn) this.savePlanFn(record);
      this.queue.push({ record, prober });
      return { queued: true, active: false };
    }

    // 立即启动调度
    this.processRecord(record, prober);
    return { queued: false, active: true };
  }

  public getActivePlanId(): string | null {
    return this.activePlanId;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  private async processRecord(record: PlanRecord, prober: KeyframeProber) {
    this.isRunning = true;
    this.activePlanId = record.id;

    // 1. 状态跃迁为 processing 并通知
    record.status = 'processing';
    if (this.savePlanFn) this.savePlanFn(record);
    this.notifyStatus(record.id, 'processing', undefined, undefined, record);

    try {
      if (!fs.existsSync(record.sourcePath)) {
        throw new Error(`原视频文件不存在: ${record.sourcePath}`);
      }

      // 2. 重新探测关键帧以保证精度
      const meta = await prober.probe(record.sourcePath);

      // 3. 使用 RetentionDraft 重建不可变切片计划
      const draft = RetentionDraft.fromRecord(record, meta.durationMs);
      const isConcat = record.concatSingleFile !== false;
      const safeOutput = this.resolveSafeSingleOutputPath(
        record.outputPath || record.sourcePath,
        record.sourcePath,
        record.title
      );

      const retentionPlan = draft.toPlan(meta.keyframes, {
        outputPath: safeOutput,
        concatToSingleFile: isConcat,
        stripOriginalCover: record.stripOriginalCover !== false,
        title: record.title,
      });

      // 4. 执行剪辑
      const result = await this.executeRawPlan(retentionPlan);

      if (result.success) {
        // 成功状态跃迁
        record.status = 'completed';
        record.outputPath = result.outputPath;
        record.completedAt = new Date().toISOString();
        delete record.error;
        if (this.savePlanFn) this.savePlanFn(record);
        this.notifyStatus(record.id, 'completed', result.outputPath, undefined, record);
      } else {
        throw new Error(result.error || '剪辑执行返回失败');
      }
    } catch (err: any) {
      console.error(`[MediaCuttingEngine] 执行方案 ${record.id} 出错:`, err);
      record.status = 'failed';
      record.error = err.message || '剪辑过程发生异常';
      if (this.savePlanFn) this.savePlanFn(record);
      this.notifyStatus(record.id, 'failed', undefined, record.error, record);
    } finally {
      this.activePlanId = null;
      this.isRunning = false;
      this.processNext();
    }
  }

  private processNext() {
    if (this.queue.length > 0 && !this.isRunning) {
      const next = this.queue.shift();
      if (next) {
        this.processRecord(next.record, next.prober);
      }
    }
  }

  private notifyStatus(
    planId: string,
    status: 'processing' | 'completed' | 'failed',
    outputPath?: string,
    error?: string,
    record?: PlanRecord
  ) {
    if (this.onStatusChange) {
      try {
        this.onStatusChange({ planId, status, outputPath, error, record });
      } catch (err) {
        console.error('[MediaCuttingEngine] 状态回调执行异常:', err);
      }
    }
  }

  /**
   * 底层无损流复制执行器
   */
  public async executeRawPlan(plan: MediaRetentionPlan): Promise<CutResult> {
    if (plan.planSegments.length === 0) {
      return {
        success: false,
        outputPath: plan.outputPath,
        error: '未选择任何保留片段',
      };
    }

    const outDir = path.dirname(plan.outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    try {
      if (plan.planSegments.length === 1) {
        const seg = plan.planSegments[0];
        const segStartMs = seg.safeRange?.startMs ?? (seg as any).startMs ?? 0;
        const segEndMs = seg.safeRange?.endMs ?? (seg as any).endMs ?? plan.durationMs;
        const finalOutputPath = this.resolveSafeSingleOutputPath(plan.outputPath, plan.sourcePath, plan.title);

        await this.cutSingleSegment(
          plan.sourcePath,
          segStartMs,
          segEndMs,
          finalOutputPath,
          plan.stripOriginalCover !== false
        );

        return {
          success: true,
          outputPath: finalOutputPath,
        };
      }

      const ext = path.extname(plan.sourcePath) || '.mp4';
      const baseName = path.basename(plan.sourcePath, ext);

      if (plan.concatToSingleFile) {
        const finalOutputPath = this.resolveSafeSingleOutputPath(plan.outputPath, plan.sourcePath, plan.title);
        const tempSegments: string[] = [];
        const timestamp = Date.now();

        try {
          for (let i = 0; i < plan.planSegments.length; i++) {
            const seg = plan.planSegments[i];
            const segStartMs = seg.safeRange.startMs;
            const segEndMs = seg.safeRange.endMs;
            const tempPath = path.join(this.tmpDir, `slice_${timestamp}_${i}${ext}`);
            tempSegments.push(tempPath);

            await this.cutSingleSegment(
              plan.sourcePath,
              segStartMs,
              segEndMs,
              tempPath,
              plan.stripOriginalCover !== false
            );
          }

          await this.concatSegments(tempSegments, finalOutputPath);

          return {
            success: true,
            outputPath: finalOutputPath,
          };
        } finally {
          // 确保无论执行成功还是异常抛错，均对临时切片进行保底垃圾回收
          for (const tempPath of tempSegments) {
            try {
              if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } catch {
              // 忽略临时文件释放异常
            }
          }
        }
      } else {
        const finalDestPaths = this.resolveSafeSegmentPaths(
          outDir,
          baseName,
          ext,
          plan.planSegments.length,
          plan.sourcePath,
          plan.title
        );

        for (let i = 0; i < plan.planSegments.length; i++) {
          const seg = plan.planSegments[i];
          const segStartMs = seg.safeRange?.startMs ?? (seg as any).startMs ?? 0;
          const segEndMs = seg.safeRange?.endMs ?? (seg as any).endMs ?? plan.durationMs;
          const destPath = finalDestPaths[i];

          await this.cutSingleSegment(
            plan.sourcePath,
            segStartMs,
            segEndMs,
            destPath,
            plan.stripOriginalCover !== false
          );
        }

        return {
          success: true,
          outputPath: finalDestPaths[0] || outDir,
        };
      }
    } catch (err: any) {
      console.error('[MediaCuttingEngine] executeRawPlan 发生异常:', err);
      return {
        success: false,
        outputPath: plan.outputPath,
        error: err.message || '剪辑执行过程发生未知错误',
      };
    }
  }

  public resolveSafeSingleOutputPath(
    candidatePath: string,
    sourcePath: string,
    planTitle?: string
  ): string {
    const ext = path.extname(candidatePath) || path.extname(sourcePath) || '.mp4';
    const outDir = path.dirname(candidatePath);
    const rawSourceBase = path.basename(sourcePath, ext);
    let rawCandidateBase = path.basename(candidatePath, ext);
    const resolvedSource = path.resolve(sourcePath);

    const isConflict = (p: string) => path.resolve(p) === resolvedSource || fs.existsSync(p);

    const cleanTitle = planTitle?.trim();
    const hasCustomTitle = Boolean(
      cleanTitle &&
      cleanTitle !== rawSourceBase &&
      !/^plan_\d+$/.test(cleanTitle)
    );

    // 如果 candidateBase 尚未带有 YYYYMMDD_HHmm 时间戳前缀，则主动补全
    const hasTimestampPrefix = /^\d{8}_\d{4}_/.test(rawCandidateBase);
    let baseWithPrefix = rawCandidateBase;

    if (!hasTimestampPrefix) {
      const timestamp = formatTaskTimestamp();
      let prefix = `${timestamp}_`;
      if (hasCustomTitle && !rawCandidateBase.includes(`[${cleanTitle}]`)) {
        prefix += `[${cleanTitle}]`;
      }
      baseWithPrefix = `${prefix}${rawSourceBase}`;
      if (!hasCustomTitle && !baseWithPrefix.endsWith('_cut')) {
        baseWithPrefix += '_cut';
      }
    }

    const initial = path.join(outDir, `${baseWithPrefix}${ext}`);
    if (!isConflict(initial)) {
      return initial;
    }

    let counter = 1;
    while (true) {
      const suffix = `_${String(counter).padStart(2, '0')}`;
      const safeCandidate = path.join(outDir, `${baseWithPrefix}${suffix}${ext}`);
      if (!isConflict(safeCandidate)) {
        return safeCandidate;
      }
      counter++;
    }
  }

  public resolveSafeSegmentPaths(
    outDir: string,
    rawSourceBase: string,
    ext: string,
    count: number,
    sourcePath: string,
    planTitle?: string
  ): string[] {
    const resolvedSource = path.resolve(sourcePath);
    const isConflict = (p: string) => path.resolve(p) === resolvedSource || fs.existsSync(p);

    const timestamp = formatTaskTimestamp();
    const cleanTitle = planTitle?.trim();
    const hasCustomTitle = Boolean(
      cleanTitle &&
      cleanTitle !== rawSourceBase &&
      !/^plan_\d+$/.test(cleanTitle)
    );

    let prefixPart = `${timestamp}_`;
    if (hasCustomTitle) {
      prefixPart += `[${cleanTitle}]`;
    }
    const basePrefix = `${prefixPart}${rawSourceBase}`;

    const defaultSeg1 = path.join(outDir, `${basePrefix}_seg01${ext}`);
    let batchSuffix = '';

    if (isConflict(defaultSeg1)) {
      let counter = 1;
      while (true) {
        const candidateSuffix = `_${String(counter).padStart(2, '0')}`;
        let batchAllFree = true;
        for (let i = 0; i < count; i++) {
          const pad = String(i + 1).padStart(2, '0');
          const segPath = path.join(outDir, `${basePrefix}_seg${pad}${candidateSuffix}${ext}`);
          if (isConflict(segPath)) {
            batchAllFree = false;
            break;
          }
        }
        if (batchAllFree) {
          batchSuffix = candidateSuffix;
          break;
        }
        counter++;
      }
    }

    const result: string[] = [];
    for (let i = 0; i < count; i++) {
      const pad = String(i + 1).padStart(2, '0');
      result.push(path.join(outDir, `${basePrefix}_seg${pad}${batchSuffix}${ext}`));
    }
    return result;
  }

  private cutSingleSegment(
    sourcePath: string,
    startMs: number,
    endMs: number,
    outputPath: string,
    stripOriginalCover: boolean = true
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const startSec = (startMs / 1000).toFixed(3);
      const durationSec = ((endMs - startMs) / 1000).toFixed(3);

      const mapArgs = stripOriginalCover
        ? ['-map', '0:V', '-map', '0:a?']
        : ['-map', '0'];

      const args = [
        '-y',
        '-ss', startSec,
        '-i', sourcePath,
        '-t', durationSec,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        ...mapArgs,
        outputPath,
      ];

      const proc = spawn(this.ffmpegPath, args);
      let stderr = '';

      proc.stderr.on('data', (chunk) => (stderr += chunk));

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg 流复制切片失败 (code ${code}): ${stderr}`));
        }
      });

      proc.on('error', (err) => reject(err));
    });
  }

  private concatSegments(segmentPaths: string[], outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const listFilePath = path.join(this.tmpDir, `concat_list_${Date.now()}.txt`);
      const lines = segmentPaths.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
      fs.writeFileSync(listFilePath, lines, 'utf-8');

      const args = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFilePath,
        '-c', 'copy',
        outputPath,
      ];

      const proc = spawn(this.ffmpegPath, args);
      let stderr = '';

      proc.stderr.on('data', (chunk) => (stderr += chunk));

      proc.on('close', (code) => {
        try {
          if (fs.existsSync(listFilePath)) fs.unlinkSync(listFilePath);
        } catch {
          // 忽略清理异常
        }

        if (code === 0 && fs.existsSync(outputPath)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg Concat 合并失败 (code ${code}): ${stderr}`));
        }
      });

      proc.on('error', (err) => reject(err));
    });
  }
}
