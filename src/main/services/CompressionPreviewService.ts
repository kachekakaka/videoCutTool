import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { CompressConfig, PreviewSample } from '../../shared/types';
import { COMPRESS_PRESETS, buildScaleFilterArgs } from '../../shared/compressPresets';

export type CompressionPreviewSample = PreviewSample;

/**
 * CompressionPreviewService: 降码画质 A/B 对比瞬时抽样服务
 * 负责在 300~500ms 内快速完成 3~5 个关键帧的抽取、微型编码压制与 Base64 组装
 */
export class CompressionPreviewService {
  private ffmpegPath: string;
  private tmpDir: string;

  constructor(preferredPath?: string, customTmpDir?: string) {
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

    const baseCwd = process.cwd();
    const fallbackTmp = path.basename(baseCwd).toLowerCase() === 'release'
      ? path.resolve(baseCwd, '../../videoCutTool_tmp')
      : path.resolve(baseCwd, '../videoCutTool_tmp');
    this.tmpDir = customTmpDir ? path.resolve(customTmpDir) : path.resolve(fallbackTmp, 'preview_cache');

    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }
  }

  /**
   * 生成指定时间戳列表的画质对比抽样帧
   */
  public async generatePreviewSamples(
    videoPath: string,
    timestampsMs: number[],
    config: CompressConfig
  ): Promise<CompressionPreviewSample[]> {
    if (!fs.existsSync(videoPath)) {
      throw new Error(`原视频文件不存在: ${videoPath}`);
    }

    const uniqueTs = Array.from(new Set(timestampsMs)).filter((t) => t >= 0);
    const targetTimestamps = uniqueTs.length > 0 ? uniqueTs.slice(0, 5) : [1000];

    // 并发处理抽样，最大限度压低总耗时
    const promises = targetTimestamps.map((ts, idx) =>
      this.sampleSingleFrame(videoPath, ts, idx, config)
    );

    const samples = await Promise.all(promises);
    return samples.filter((s): s is CompressionPreviewSample => s !== null);
  }

  /**
   * 针对单帧执行原图抽取与极速 CRF 压制对比
   */
  private async sampleSingleFrame(
    videoPath: string,
    timestampMs: number,
    index: number,
    config: CompressConfig
  ): Promise<CompressionPreviewSample | null> {
    const sec = (timestampMs / 1000).toFixed(3);
    const runId = `${Date.now()}_${index}_${Math.floor(Math.random() * 1000)}`;
    const origPath = path.join(this.tmpDir, `orig_${runId}.jpg`);
    const tempMp4 = path.join(this.tmpDir, `temp_${runId}.mp4`);
    const compPath = path.join(this.tmpDir, `comp_${runId}.jpg`);

    try {
      // 1. 抽取原视频在目标时间戳的高画质单帧
      await this.runFfmpeg([
        '-y',
        '-ss', sec,
        '-i', videoPath,
        '-vframes', '1',
        '-q:v', '2',
        origPath,
      ]);

      if (!fs.existsSync(origPath)) return null;

      // 2. 确定编码器与 CRF 参数进行极速微型压制
      const preset = config.preset;
      const isHevc = preset === 'high_compression';
      let crf = config.crf;
      if (crf === undefined || isNaN(crf)) {
        crf = preset === 'custom' ? 22 : COMPRESS_PRESETS[preset].defaultCrf;
      }

      // 构建单帧压制参数 (使用 ultrafast 保持极速响应，还原真实量化噪点)
      const compressArgs = [
        '-y',
        '-i', origPath,
        '-c:v', isHevc ? 'libx265' : 'libx264',
        '-crf', String(crf),
        '-preset', 'ultrafast',
      ];

      // 分辨率限高/缩放
      compressArgs.push(...buildScaleFilterArgs(config));

      compressArgs.push(tempMp4);
      await this.runFfmpeg(compressArgs);

      // 3. 将压制后的微型视频转为单帧测试图像
      await this.runFfmpeg([
        '-y',
        '-i', tempMp4,
        '-vframes', '1',
        '-q:v', '2',
        compPath,
      ]);

      if (!fs.existsSync(compPath)) return null;

      const origSize = fs.statSync(origPath).size;
      const compSize = fs.statSync(compPath).size;

      const origBuf = fs.readFileSync(origPath);
      const compBuf = fs.readFileSync(compPath);

      return {
        index,
        timestampMs,
        originalBase64: `data:image/jpeg;base64,${origBuf.toString('base64')}`,
        compressedBase64: `data:image/jpeg;base64,${compBuf.toString('base64')}`,
        originalSizeBytes: origSize,
        compressedSizeBytes: compSize,
      };
    } catch (err) {
      console.error(`[CompressionPreviewService] 抽样帧 ${index} (${sec}s) 失败:`, err);
      return null;
    } finally {
      // 保底清理临时文件
      [origPath, tempMp4, compPath].forEach((p) => {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {}
      });
    }
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, args);
      let stderr = '';
      proc.stderr.on('data', (d) => (d ? (stderr += d) : null));
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg 执行异常 (code ${code}): ${stderr}`));
        }
      });
      proc.on('error', (err) => reject(err));
    });
  }
}
