import { describe, it, expect } from 'vitest';
import { buildSpatialFiltergraph } from '../src/shared/spatialFiltergraph';
import { SpatialConfig } from '../src/shared/types';

describe('spatialFiltergraph - 纯函数算子与串联管线不变量校验', () => {
  it('严格执行 delogo/drawbox 修补先行、crop 裁切居后的串联次序', () => {
    const config: SpatialConfig = {
      crop: { x: 10, y: 10, width: 800, height: 600, ratio: '16:9', locked: true },
      masks: [{ id: 'm1', name: '台标', x: 100, y: 50, width: 120, height: 60, type: 'delogo' }],
      scope: 'global'
    };
    const [flag, vf] = buildSpatialFiltergraph({ width: 1920, height: 1080 }, config);
    expect(flag).toBe('-vf');
    expect(vf.indexOf('delogo=x=100:y=50:w=120:h=60')).toBeLessThan(vf.indexOf('crop=800:600:10:10'));
  });

  it('坐标与尺寸必须强制向偶数对齐，杜绝 FFmpeg 报 not divisible by 2 报错', () => {
    const config: SpatialConfig = {
      crop: { x: 11, y: 13, width: 801, height: 601, ratio: '9:16', locked: false },
      masks: [{ id: 'm2', name: '黑条', x: 21, y: 31, width: 99, height: 45, type: 'black' }],
      scope: 'global'
    };
    const [, vf] = buildSpatialFiltergraph({ width: 1920, height: 1080 }, config);
    expect(vf).toContain('drawbox=x=20:y=30:w=100:h=46');
    expect(vf).toContain('crop=800:600:10:12');
  });

  it('单文件合并时按母版分辨率执行 Letterbox 居中加黑边填充', () => {
    const config: SpatialConfig = {
      crop: { x: 0, y: 0, width: 608, height: 1080, ratio: '9:16', locked: true },
      masks: [],
      scope: 'global'
    };
    const [, vf] = buildSpatialFiltergraph({ width: 1920, height: 1080 }, config, { width: 1920, height: 1080 });
    expect(vf).toContain('pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black');
  });
});
