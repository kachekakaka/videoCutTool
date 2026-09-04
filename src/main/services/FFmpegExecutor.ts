import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { MediaRetentionPlan, CutResult } from '../../shared/types';

export class FFmpegExecutor {
  private ffmpegPath: string;
  private tmpDir: string;

  constructor(preferredPath?: string, customSlicesDir?: string) {
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

    const matched = candidates.find(p => fs.existsSync(p));
    this.ffmpegPath = matched || 'ffmpeg';
    console.log('[FFmpegExecutor] Path:', this.ffmpegPath);

    // 遵守隔离红线：切片缓存统一存放至同级外部目录 ../videoCutTool_tmp/slices/
    this.tmpDir = customSlicesDir
      ? path.resolve(customSlicesDir)
      : path.resolve(process.cwd(), '../videoCutTool_tmp/slices');

    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
  }

  /**
   * 执行无损流复制裁剪方案
   */
  public async executePlan(plan: MediaRetentionPlan): Promise<CutResult> {
    if (plan.planSegments.length === 0) {
      return {
        success: false,
        outputPath: plan.outputPath,
        durationMs: 0,
        error: '未选择任何保留片段',
      };
    }

    // 确保输出目录存在
    const outDir = path.dirname(plan.outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    try {
      // 场景 1：只有一个保留段，直接无损输出到最终目标
      if (plan.planSegments.length === 1) {
        const seg = plan.planSegments[0];
        const segStartMs = seg.safeRange?.startMs ?? (seg as any).startMs ?? 0;
        const segEndMs = seg.safeRange?.endMs ?? (seg as any).endMs ?? plan.durationMs;
        const finalOutputPath = this.resolveSafeSingleOutputPath(plan.outputPath, plan.sourcePath);

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
          durationMs: segEndMs - segStartMs,
        };
      }

      // 场景 2：有多个保留段
      const ext = path.extname(plan.sourcePath) || '.mp4';
      const baseName = path.basename(plan.sourcePath, ext);

      // 如果需要合并为单个文件
      if (plan.concatToSingleFile) {
        const finalOutputPath = this.resolveSafeSingleOutputPath(plan.outputPath, plan.sourcePath);
        const tempSegments: string[] = [];
        const timestamp = Date.now();

        for (let i = 0; i < plan.planSegments.length; i++) {
          const seg = plan.planSegments[i];
          const segStartMs = seg.safeRange?.startMs ?? (seg as any).startMs ?? 0;
          const segEndMs = seg.safeRange?.endMs ?? (seg as any).endMs ?? plan.durationMs;
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

        // 剪辑合并完成后，清理临时切片
        for (const tempPath of tempSegments) {
          try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          } catch {
            // ignore
          }
        }

        return {
          success: true,
          outputPath: finalOutputPath,
          durationMs: plan.totalKeptDurationMs,
        };
      } else {
        // 不需要合并：各保留片段直接无损切出至目标输出目录 outDir（带智能批次避让）
        const finalDestPaths = this.resolveSafeSegmentPaths(
          outDir,
          baseName,
          ext,
          plan.planSegments.length,
          plan.sourcePath
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
          durationMs: plan.totalKeptDurationMs,
        };
      }
    } catch (err: any) {
      console.error('FFmpeg 执行裁剪失败:', err);
      return {
        success: false,
        outputPath: plan.outputPath,
        durationMs: 0,
        error: err.message || '剪辑执行过程发生未知错误',
      };
    }
  }

  /**
   * 确保单文件输出路径物理安全（避让已存在文件与源文件）
   */
  public resolveSafeSingleOutputPath(candidatePath: string, sourcePath: string): string {
    const ext = path.extname(candidatePath) || path.extname(sourcePath) || '.mp4';
    const outDir = path.dirname(candidatePath);
    let rawBase = path.basename(candidatePath, ext);
    const resolvedSource = path.resolve(sourcePath);

    const isConflict = (p: string) => path.resolve(p) === resolvedSource || fs.existsSync(p);

    if (!isConflict(candidatePath)) {
      return candidatePath;
    }

    let prefix = rawBase;
    if (!prefix.endsWith('_cut') && !/_cut_\d+$/.test(prefix)) {
      prefix = `${rawBase}_cut`;
    } else if (/_cut_\d+$/.test(prefix)) {
      prefix = prefix.replace(/_\d+$/, '');
    }

    let counter = 1;
    while (true) {
      const suffix = `_${String(counter).padStart(2, '0')}`;
      const safeCandidate = path.join(outDir, `${prefix}${suffix}${ext}`);
      if (!isConflict(safeCandidate)) {
        return safeCandidate;
      }
      counter++;
    }
  }

  /**
   * 确保多段不合并模式下的批次文件路径安全
   */
  public resolveSafeSegmentPaths(
    outDir: string,
    baseName: string,
    ext: string,
    count: number,
    sourcePath: string
  ): string[] {
    const resolvedSource = path.resolve(sourcePath);
    const isConflict = (p: string) => path.resolve(p) === resolvedSource || fs.existsSync(p);

    const defaultSeg1 = path.join(outDir, `${baseName}_seg01${ext}`);
    let batchSuffix = '';

    if (isConflict(defaultSeg1)) {
      let counter = 1;
      while (true) {
        const candidateSuffix = `_${String(counter).padStart(2, '0')}`;
        let batchAllFree = true;
        for (let i = 0; i < count; i++) {
          const pad = String(i + 1).padStart(2, '0');
          const segPath = path.join(outDir, `${baseName}_seg${pad}${candidateSuffix}${ext}`);
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
      result.push(path.join(outDir, `${baseName}_seg${pad}${batchSuffix}${ext}`));
    }
    return result;
  }

  /**
   * 单段无损流拷贝 (-c copy)
   */
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

      // 当 stripOriginalCover 为 true 时，使用 0:V 排除原片静态封面 (attached_pic)，让系统自动抓取切片真实首帧
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

      proc.stderr.on('data', chunk => stderr += chunk);

      proc.on('close', code => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg 流复制切片失败 (code ${code}): ${stderr}`));
        }
      });

      proc.on('error', err => reject(err));
    });
  }

  /**
   * 使用 FFmpeg Concat Demuxer 无损合并片段
   */
  private concatSegments(segmentPaths: string[], outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const listFilePath = path.join(this.tmpDir, `concat_list_${Date.now()}.txt`);
      // 生成符合 FFmpeg concat demuxer 规范的文件列表
      const lines = segmentPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
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

      proc.stderr.on('data', chunk => stderr += chunk);

      proc.on('close', code => {
        // 清理 list 文件
        try {
          if (fs.existsSync(listFilePath)) fs.unlinkSync(listFilePath);
        } catch {
          // ignore
        }

        if (code === 0 && fs.existsSync(outputPath)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg Concat 合并失败 (code ${code}): ${stderr}`));
        }
      });

      proc.on('error', err => reject(err));
    });
  }
}
