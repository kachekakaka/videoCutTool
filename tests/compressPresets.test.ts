import { describe, it, expect } from 'vitest';
import { buildCompressArgs, COMPRESS_PRESETS } from '../src/shared/compressPresets';

describe('buildCompressArgs', () => {
  it('应当为高画质预设生成 libx264 CRF18 与音频流复制参数', () => {
    const args = buildCompressArgs('input.mp4', 'output.mp4', {
      enabled: true,
      preset: 'high_quality',
    });

    expect(args).toContain('-c:v');
    expect(args).toContain('libx264');
    expect(args).toContain('-crf');
    expect(args).toContain('18');
    expect(args).toContain('-c:a');
    expect(args).toContain('copy');
  });

  it('应当为高压缩预设生成 libx265 CRF24 参数', () => {
    const args = buildCompressArgs('input.mp4', 'output.mp4', {
      enabled: true,
      preset: 'high_compression',
    });

    expect(args).toContain('libx265');
    expect(args).toContain('24');
    expect(args).toContain('-c:a');
    expect(args).toContain('copy');
  });

  it('应当为降至1080p预设生成正确的分辨率缩放滤镜', () => {
    const args = buildCompressArgs('input.mp4', 'output.mp4', {
      enabled: true,
      preset: 'scale_1080p',
    });

    expect(args).toContain('-vf');
    expect(args).toContain("scale='max(2,trunc(iw*min(1,1080/ih)/2)*2)':'max(2,trunc(ih*min(1,1080/ih)/2)*2)'");
    expect(args).toContain('-c:a');
    expect(args).toContain('copy');
  });

  it('NVENC 加速启用时应当使用 h264_nvenc 与 CQ 参数', () => {
    const args = buildCompressArgs(
      'input.mp4',
      'output.mp4',
      {
        enabled: true,
        preset: 'balanced',
      },
      'nvenc'
    );

    expect(args).toContain('h264_nvenc');
    expect(args).toContain('-cq');
    expect(args).toContain('23');
    expect(args).toContain('-c:a');
    expect(args).toContain('copy');
  });

  it('铁律校验：所有预设必须强制包含 -c:a copy', () => {
    const presets = Object.keys(COMPRESS_PRESETS) as Array<keyof typeof COMPRESS_PRESETS>;
    for (const preset of presets) {
      const args = buildCompressArgs('in.mp4', 'out.mp4', { enabled: true, preset });
      const aIdx = args.indexOf('-c:a');
      expect(aIdx).toBeGreaterThan(-1);
      expect(args[aIdx + 1]).toBe('copy');
    }
  });
});
