import { SpatialConfig, SpatialCropBox } from './types';

export interface Dimension { width: number; height: number }
export const makeEven = (value: number) => Math.floor(value / 2) * 2;
export const makeEvenCeil = (value: number) => Math.ceil(value / 2) * 2;
export function hasEffectiveCrop(crop?: SpatialCropBox, size?: Dimension): boolean {
  return Boolean(crop && (!size || crop.x !== 0 || crop.y !== 0 || crop.width < size.width || crop.height < size.height));
}
export function hasSpatialEffects(config?: SpatialConfig, size?: Dimension): boolean {
  return hasEffectiveCrop(config?.crop, size) || Boolean(config?.masks?.length);
}
export function spatialOutputSize(size: Dimension, config?: SpatialConfig): Dimension {
  return { width: Math.max(2, makeEven(config?.crop?.width ?? size.width)), height: Math.max(2, makeEven(config?.crop?.height ?? size.height)) };
}

/** 拒绝无效选区，不能静默缩小遮罩而暴露未处理像素。 */
export function validateSpatial(config: SpatialConfig | undefined, size?: Dimension): void {
  if (!config) return;
  if (!['global', 'segment'].includes(config.scope) || !Array.isArray(config.masks) || config.masks.length > 64) throw new Error('画面配置或遮罩数量无效');
  for (const box of [...config.masks, ...(config.crop ? [config.crop] : [])]) {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.x < 0 || box.y < 0 || box.width < 2 || box.height < 2 || Math.max(box.x, box.y, box.width, box.height) > 32768) throw new Error('画面选区坐标无效');
    if (size && (box.x + box.width > size.width || box.y + box.height > size.height)) throw new Error('画面选区超出当前素材尺寸，请重新调整');
  }
  if (config.crop && (!['free', 'source', '16:9', '9:16', '1:1'].includes(config.crop.ratio) || typeof config.crop.locked !== 'boolean')) throw new Error('裁剪比例配置无效');
  const ids = new Set<string>();
  for (const mask of config.masks) {
    if (typeof mask.id !== 'string' || !mask.id || mask.id.length > 128 || ids.has(mask.id) || !['delogo', 'black', 'mosaic'].includes(mask.type)) throw new Error('遮罩配置无效');
    ids.add(mask.id);
    if (mask.type === 'delogo' && (makeEven(mask.x) < 2 || makeEven(mask.y) < 2 || (size && (makeEvenCeil(mask.x + mask.width) > makeEven(size.width) - 2 || makeEvenCeil(mask.y + mask.height) > makeEven(size.height) - 2)))) throw new Error('去水印选区需要与画面四边至少保留 2 像素，请内移选区或使用黑色遮罩/马赛克');
  }
}

/** 单输入、单输出滤镜图；局部模糊使用 split/crop/overlay，仍可用于 -vf。 */
export function buildSpatialFiltergraph(sourceDim: Dimension, config?: SpatialConfig, target?: Dimension, prefix = 'sp'): string[] {
  validateSpatial(config, sourceDim);
  const filters: string[] = [];
  for (const [i, mask] of (config?.masks ?? []).entries()) {
    const x = makeEven(mask.x), y = makeEven(mask.y);
    const w = Math.min(makeEven(sourceDim.width) - x, makeEvenCeil(mask.x + mask.width) - x);
    const h = Math.min(makeEven(sourceDim.height) - y, makeEvenCeil(mask.y + mask.height) - y);
    if (mask.type === 'black') filters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black:t=fill`);
    else if (mask.type === 'delogo') filters.push(`delogo=x=${x}:y=${y}:w=${w}:h=${h}`);
    else {
      const radius = Math.min(10, Math.floor(Math.min(w, h) / 2));
      const chroma = Math.min(5, Math.floor(Math.min(w, h) / 4));
      filters.push(`split=2[${prefix}b${i}][${prefix}r${i}];[${prefix}r${i}]crop=${w}:${h}:${x}:${y},boxblur=luma_radius=${radius}:luma_power=2:chroma_radius=${chroma}[${prefix}m${i}];[${prefix}b${i}][${prefix}m${i}]overlay=${x}:${y}:shortest=1`);
    }
  }
  let current = spatialOutputSize(sourceDim);
  if (hasEffectiveCrop(config?.crop, sourceDim)) {
    current = spatialOutputSize(sourceDim, config);
    filters.push(`crop=${current.width}:${current.height}:${makeEven(config!.crop!.x)}:${makeEven(config!.crop!.y)}`);
  }
  if (target) {
    const wanted = spatialOutputSize(target);
    if (current.width !== wanted.width || current.height !== wanted.height) {
      filters.push(`scale=${wanted.width}:${wanted.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`);
      filters.push(`pad=${wanted.width}:${wanted.height}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }
  }
  return filters.length ? ['-vf', filters.join(',')] : [];
}

