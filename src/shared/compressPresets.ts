/**
 * 视频降码压缩预设标准定义与参数装配
 * 对齐 ja_workspace (compress_presets.cpp / ffmpeg_runner.cpp) 与 f2 (临时讨论-F2-TOOLS-01)
 */

import { CompressConfig, CompressPresetId, MediaStreamInfo } from './types';

export interface CompressPresetMetadata {
  id: CompressPresetId;
  title: string;
  summary: string;
  defaultCrf: number;
}

export const COMPRESS_PRESETS: Record<Exclude<CompressPresetId, 'custom'>, CompressPresetMetadata> = {
  high_quality: {
    id: 'high_quality',
    title: '高画质',
    summary: 'libx264 CRF18 / NVENC CQ19，保留原生分辨率',
    defaultCrf: 18,
  },
  balanced: {
    id: 'balanced',
    title: '均衡',
    summary: 'libx264 CRF22 / NVENC CQ23，日常最推荐减负档',
    defaultCrf: 22,
  },
  high_compression: {
    id: 'high_compression',
    title: '高压缩',
    summary: 'H.265 (HEVC) CRF24 / NVENC CQ26，体积极限缩减',
    defaultCrf: 24,
  },
  scale_1080p: {
    id: 'scale_1080p',
    title: '降至 1080p',
    summary: '按实际画面限高 1080，保持比例并保留原始音轨',
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
  resolvedEncoder: 'cpu' | 'nvenc' | 'qsv' = 'cpu',
  options: { streams?: MediaStreamInfo[]; stripCover?: boolean; videoOnly?: boolean; startSeconds?: string; durationSeconds?: string } = {}
): string[] {
  const args: string[] = ['-n'];
  if (options.startSeconds !== undefined) args.push('-ss', options.startSeconds);
  args.push('-i', inputPath);
  if (options.durationSeconds !== undefined) args.push('-t', options.durationSeconds);
  const selected = options.streams?.filter(stream => options.videoOnly ? stream.type === 'video' && !stream.attachedPicture : options.stripCover !== false ? (stream.type === 'video' && !stream.attachedPicture) || stream.type === 'audio' : true);
  if (selected) selected.forEach(stream => args.push('-map', `0:${stream.index}`));
  else args.push('-map', '0:V', ...(options.videoOnly ? [] : ['-map', '0:a?']));
  args.push('-c', 'copy');

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
  const scaleArgs = buildScaleFilterArgs(config);
  if (selected?.some(stream => stream.attachedPicture) && scaleArgs.length) {
    selected.filter(stream => stream.type === 'video').forEach((stream, index) => {
      if (!stream.attachedPicture) args.push(`-filter:v:${index}`, scaleArgs[1]);
    });
  } else args.push(...scaleArgs);
  args.push('-pix_fmt', 'yuv420p');
  selected?.filter(stream => stream.type === 'video').forEach((stream, index) => {
    if (stream.attachedPicture) args.push(`-c:v:${index}`, 'copy', `-disposition:v:${index}`, 'attached_pic');
  });

  // 4. 音频铁律：无损流复制
  args.push('-c:a', 'copy');
  selected?.filter(stream => stream.type === 'audio').forEach((stream, index) => args.push(`-disposition:a:${index}`, stream.default ? 'default' : '0'));

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
    const height = Math.max(2, Math.floor(effectiveMaxHeight / 2) * 2);
    return ['-vf', `scale='max(2,trunc(iw*min(1,${height}/ih)/2)*2)':'max(2,trunc(ih*min(1,${height}/ih)/2)*2)'`];
  }
  return [];
}
