import type { CompressConfig } from '../../shared/types';

/** 纯业务校验，桌面来源授权仍由 IpcSecurity 负责。 */
export function validateCompress(value?: CompressConfig) {
  if (value === undefined) return;
  if (!value || typeof value.enabled !== 'boolean' || !['custom', 'high_quality', 'balanced', 'high_compression', 'scale_1080p'].includes(value.preset) || (value.encoder !== undefined && !['auto', 'cpu', 'nvenc', 'qsv'].includes(value.encoder)) || (value.hardwareAcceleration !== undefined && typeof value.hardwareAcceleration !== 'boolean')) throw new Error('压缩配置无效');
  if (value.crf !== undefined && (!Number.isFinite(value.crf) || value.crf < 0 || value.crf > 51)) throw new Error('压缩画质参数无效');
  if (value.maxHeight !== undefined && (!Number.isInteger(value.maxHeight) || value.maxHeight < 2 || value.maxHeight > 16384)) throw new Error('压缩尺寸无效');
}
