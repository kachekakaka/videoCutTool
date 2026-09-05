/**
 * 视频降码压缩预设标准定义与参数装配
 * 对齐 ja_workspace (compress_presets.cpp / ffmpeg_runner.cpp) 与 f2 (临时讨论-F2-TOOLS-01)
 */

import { CompressConfig, CompressPresetId } from './types';

export interface CompressPresetMetadata {
  id: CompressPresetId;
  title: string;
  summary: string;
  qualityRetainMin: number;
  qualityRetainMax: number;
  sizeReduceMin: number;
  sizeReduceMax: number;
  defaultCrf: number;
}

export const COMPRESS_PRESETS: Record<Exclude<CompressPresetId, 'custom'>, CompressPresetMetadata> = {
  high_quality: {
    id: 'high_quality',
    title: '高画质',
    summary: 'libx264 CRF18 / NVENC CQ19，保留原生分辨率',
    qualityRetainMin: 95,
    qualityRetainMax: 98,
    sizeReduceMin: 15,
    sizeReduceMax: 35,
    defaultCrf: 18,
  },
  balanced: {
    id: 'balanced',
    title: '均衡',
    summary: 'libx264 CRF22 / NVENC CQ23，日常最推荐减负档',
    qualityRetainMin: 90,
    qualityRetainMax: 94,
    sizeReduceMin: 35,
    sizeReduceMax: 50,
    defaultCrf: 22,
  },
  high_compression: {
    id: 'high_compression',
    title: '高压缩',
    summary: 'H.265 (HEVC) CRF24 / NVENC CQ26，体积极限缩减',
    qualityRetainMin: 82,
    qualityRetainMax: 90,
    sizeReduceMin: 50,
    sizeReduceMax: 70,
    defaultCrf: 24,
  },
  scale_1080p: {
    id: 'scale_1080p',
    title: '降至 1080p',
    summary: '限宽 1920 + 高画质编码；4K/2K 超高清片源专享',
    qualityRetainMin: 93,
    qualityRetainMax: 97,
    sizeReduceMin: 40,
    sizeReduceMax: 65,
    defaultCrf: 18,
  },
};

/**
 * 拼装 FFmpeg 降码参数
 * 铁律：音频统一强制采用 -c:a copy，绝不重新编码音频
 */
export function buildCompressArgs(
  inputPath: string,
  outputPath: string,
  config: CompressConfig,
  resolvedEncoder: 'cpu' | 'nvenc' | 'qsv' = 'cpu'
): string[] {
  const args: string[] = ['-y', '-i', inputPath];

  const preset = config.preset;
  const isHevc = preset === 'high_compression';

  // 1. 确定 CRF / CQ
  let crf = config.crf;
  if (crf === undefined || isNaN(crf)) {
    if (preset === 'custom') {
      crf = 22;
    } else {
      crf = COMPRESS_PRESETS[preset].defaultCrf;
    }
  }

  // 2. 视频编码器与画质参数
  if (resolvedEncoder === 'nvenc') {
    const encoder = isHevc ? 'hevc_nvenc' : 'h264_nvenc';
    const cq = preset === 'high_quality' || preset === 'scale_1080p' ? 19 : preset === 'balanced' ? 23 : 26;
    args.push('-c:v', encoder, '-cq', String(config.crf ?? cq), '-preset', 'p5');
  } else if (resolvedEncoder === 'qsv') {
    const encoder = isHevc ? 'hevc_qsv' : 'h264_qsv';
    const globalQuality = preset === 'high_quality' || preset === 'scale_1080p' ? '18' : preset === 'balanced' ? '22' : '26';
    args.push('-c:v', encoder, '-global_quality', String(config.crf ?? globalQuality));
  } else {
    // 默认 CPU 软解软编
    const encoder = isHevc ? 'libx265' : 'libx264';
    const presetSpeed = preset === 'balanced' ? 'medium' : 'slow';
    args.push('-c:v', encoder, '-crf', String(crf), '-preset', presetSpeed);
  }

  // 3. 分辨率限高/缩放
  args.push(...buildScaleFilterArgs(config));

  // 4. 音频铁律：无损流复制
  args.push('-c:a', 'copy');

  // 5. 输出产物路径
  args.push(outputPath);

  return args;
}

/**
 * 构建统一的分辨率限高与等比缩放滤镜参数
 */
export function buildScaleFilterArgs(config: CompressConfig): string[] {
  let effectiveMaxHeight = config.maxHeight;
  if (config.preset === 'scale_1080p' && (!effectiveMaxHeight || effectiveMaxHeight <= 0)) {
    effectiveMaxHeight = 1080;
  }
  if (effectiveMaxHeight && effectiveMaxHeight > 0) {
    const maxWidth = Math.round((effectiveMaxHeight * 16) / 9);
    return ['-vf', `scale='min(${maxWidth},iw)':-2`];
  }
  return [];
}
