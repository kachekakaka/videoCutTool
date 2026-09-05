import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { MediaMetadata } from '../../shared/types';

export class KeyframeProber {
  private ffprobePath: string;
  private cacheDir: string;

  constructor(preferredPath?: string, baseDir: string = process.cwd()) {
    const resourcesPath = (process as any).resourcesPath;
    const candidates = [
      resourcesPath ? path.join(resourcesPath, 'bin', 'ffprobe.exe') : '',
      resourcesPath ? path.join(resourcesPath, 'tools', 'ffprobe.exe') : '',
      preferredPath,
      'D:/Tools/ffmpeg/ffprobe.exe',
      'D:\\Tools\\ffmpeg\\ffprobe.exe',
      './tools/ffprobe.exe',
      path.resolve(process.cwd(), 'tools/ffprobe.exe'),
    ].filter(Boolean) as string[];

    const matched = candidates.find(p => fs.existsSync(p));
    this.ffprobePath = matched || 'ffprobe';
    console.log('[KeyframeProber] Path:', this.ffprobePath);

    // 遵守隔离红线：关键帧持久化缓存统一存放至同级外部临时目录 ../videoCutTool_tmp/cache/
    const externalTmp = path.basename(baseDir).toLowerCase() === 'release'
      ? path.resolve(baseDir, '../../videoCutTool_tmp')
      : path.resolve(baseDir, '../videoCutTool_tmp');
    this.cacheDir = path.resolve(externalTmp, 'cache');
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * 极速秒开探测：只读取视频元数据（时长、分辨率、帧率），耗时通常 < 300ms
   */
  public async probeBasic(filePath: string): Promise<MediaMetadata> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`视频文件不存在: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const streamInfo = await this.getStreamInfo(filePath);

    // 尝试先看有没有已存在的关键帧缓存
    const cachedKeyframes = this.readCachedKeyframes(filePath);

    return {
      filePath,
      fileName,
      durationMs: streamInfo.durationMs,
      width: streamInfo.width,
      height: streamInfo.height,
      fps: streamInfo.fps,
      keyframes: cachedKeyframes || [0],
    };
  }

  /**
   * 异步扫描或从缓存加载全量物理关键帧列表
   */
  public async probeKeyframes(filePath: string): Promise<number[]> {
    // 1. 检查缓存 (二次访问 0ms 秒开)
    const cached = this.readCachedKeyframes(filePath);
    if (cached && cached.length > 0) {
      console.log(`[KeyframeCache] 命中磁盘缓存: ${filePath} (共 ${cached.length} 个关键帧)`);
      return cached;
    }

    // 2. 无缓存时后台执行物理探测
    const keyframes = await this.extractKeyframes(filePath);

    // 3. 写入缓存
    this.writeCachedKeyframes(filePath, keyframes);
    return keyframes;
  }

  /**
   * 兼容旧接口：全量探测
   */
  public async probe(filePath: string): Promise<MediaMetadata> {
    const basic = await this.probeBasic(filePath);
    if (basic.keyframes.length <= 1) {
      const kfs = await this.probeKeyframes(filePath);
      basic.keyframes = kfs;
    }
    return basic;
  }

  private getCachePath(filePath: string): string {
    try {
      const stat = fs.statSync(filePath);
      const raw = `${filePath}_${stat.size}_${stat.mtimeMs}`;
      const hash = crypto.createHash('md5').update(raw).digest('hex');
      return path.join(this.cacheDir, `kfs_${hash}.json`);
    } catch {
      return '';
    }
  }

  private readCachedKeyframes(filePath: string): number[] | null {
    const cpath = this.getCachePath(filePath);
    if (cpath && fs.existsSync(cpath)) {
      try {
        const data = fs.readFileSync(cpath, 'utf-8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) return parsed;
      } catch (err) {
        console.warn('读取关键帧缓存失败:', err);
      }
    }
    return null;
  }

  private writeCachedKeyframes(filePath: string, keyframes: number[]): void {
    const cpath = this.getCachePath(filePath);
    if (cpath) {
      try {
        fs.writeFileSync(cpath, JSON.stringify(keyframes), 'utf-8');
      } catch (err) {
        console.warn('写入关键帧缓存失败:', err);
      }
    }
  }

  private getStreamInfo(filePath: string): Promise<{ durationMs: number; width: number; height: number; fps: number }> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,duration:format=duration',
        '-of', 'json',
        filePath,
      ];

      const proc = spawn(this.ffprobePath, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', chunk => stdout += chunk);
      proc.stderr.on('data', chunk => stderr += chunk);

      proc.on('close', code => {
        if (code !== 0) {
          return reject(new Error(`ffprobe 探测视频失败 (code ${code}): ${stderr || '未知错误'}`));
        }

        try {
          const data = JSON.parse(stdout);
          const stream = data.streams?.[0] || {};
          const format = data.format || {};

          let durationSec = parseFloat(stream.duration || format.duration || '0');
          if (isNaN(durationSec) || durationSec <= 0) {
            durationSec = 60;
          }

          let fps = 30;
          if (stream.r_frame_rate) {
            const [num, den] = stream.r_frame_rate.split('/').map(Number);
            if (den && den > 0) {
              fps = Math.round(num / den);
            }
          }

          resolve({
            durationMs: Math.round(durationSec * 1000),
            width: stream.width || 1920,
            height: stream.height || 1080,
            fps: fps || 30,
          });
        } catch (err) {
          reject(new Error(`解析 ffprobe 输出 JSON 失败: ${err}`));
        }
      });

      proc.on('error', err => reject(new Error(`启动 ffprobe 失败 (${this.ffprobePath}): ${err.message}`)));
    });
  }

  private extractKeyframes(filePath: string): Promise<number[]> {
    return new Promise((resolve) => {
      const args = [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-skip_frame', 'nokey',
        '-show_frames',
        '-show_entries', 'frame=pkt_dts_time',
        '-of', 'json',
        filePath,
      ];

      const proc = spawn(this.ffprobePath, args);
      let stdout = '';

      proc.stdout.on('data', chunk => stdout += chunk);

      proc.on('close', () => {
        const keyframes: number[] = [0];

        try {
          const data = JSON.parse(stdout);
          if (Array.isArray(data.frames)) {
            for (const f of data.frames) {
              const sec = parseFloat(f.pkt_dts_time);
              if (!isNaN(sec) && sec >= 0) {
                keyframes.push(Math.round(sec * 1000));
              }
            }
          }
        } catch {
          // JSON 解析降级
        }

        const uniqueSorted = Array.from(new Set(keyframes)).sort((a, b) => a - b);
        resolve(uniqueSorted);
      });

      proc.on('error', (err) => {
        console.warn('提取关键帧进程出错，默认使用 0ms:', err);
        resolve([0]);
      });
    });
  }
}
