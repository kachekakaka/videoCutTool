import fs from 'fs';
import path from 'path';
import { AppConfig, CompressConfig, PlanRecord } from '../../shared/types';
import { validateSpatial } from '../../shared/spatialFiltergraph';

export function textValue(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error(`${label}无效`);
}
export function localPath(value: unknown): asserts value is string {
  textValue(value, '本地路径'); if (!path.isAbsolute(value)) throw new Error('仅允许绝对本地路径');
}
export function requestId(value: unknown): asserts value is string { textValue(value, '请求标识', 128); if (!/^[\w-]+$/.test(value)) throw new Error('请求标识无效'); }
export function validateCompress(value?: CompressConfig) {
  if (value === undefined) return;
  if (!value || typeof value.enabled !== 'boolean' || !['custom', 'high_quality', 'balanced', 'high_compression', 'scale_1080p'].includes(value.preset) || (value.encoder !== undefined && !['auto', 'cpu', 'nvenc', 'qsv'].includes(value.encoder)) || (value.hardwareAcceleration !== undefined && typeof value.hardwareAcceleration !== 'boolean')) throw new Error('压缩配置无效');
  if (value.crf !== undefined && (!Number.isFinite(value.crf) || value.crf < 0 || value.crf > 51)) throw new Error('压缩画质参数无效');
  if (value.maxHeight !== undefined && (!Number.isInteger(value.maxHeight) || value.maxHeight < 2 || value.maxHeight > 16384)) throw new Error('压缩尺寸无效');
}
export function validateConfigPatch(patch: Partial<AppConfig>) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('配置内容无效');
  const booleans = ['autoConcatSingleFile', 'stripOriginalCover', 'notifyOnExportComplete'];
  const paths = ['ffmpegPath', 'ffprobePath'];
  for (const [key, value] of Object.entries(patch)) {
    if (booleans.includes(key)) { if (typeof value !== 'boolean') throw new Error('配置开关无效'); }
    else if (paths.includes(key)) { if (value !== '') localPath(value); }
    else throw new Error(`不允许通过页面修改配置字段：${key}`);
  }
}
export function validateRecord(record: PlanRecord) {
  if (!record || typeof record !== 'object') throw new Error('方案内容无效');
  requestId(record.id); localPath(record.sourcePath); textValue(record.title, '方案标题', 256);
  if (record.outputPath) localPath(record.outputPath);
  const unknownDuration = record.compressionOnly === true && record.totalDurationMs === null && record.keptDurationMs === null;
  if ((!unknownDuration && (typeof record.totalDurationMs !== 'number' || !Number.isFinite(record.totalDurationMs) || record.totalDurationMs <= 0)) || !Array.isArray(record.cuts) || record.cuts.length > 10000 || record.cuts.some((cut, index) => !Number.isFinite(cut) || cut <= 0 || record.totalDurationMs === null || cut >= record.totalDurationMs || (index > 0 && cut <= record.cuts[index - 1]))) throw new Error('方案切点或时长无效');
  if (!record.decisions || Array.isArray(record.decisions) || typeof record.decisions !== 'object') throw new Error('方案保留决策无效');
  const validId = (id: string) => /^seg_\d+$/.test(id) && Number(id.slice(4)) <= record.cuts.length;
  if (Object.keys(record.decisions).length > record.cuts.length + 1 || Object.entries(record.decisions).some(([id, value]) => !validId(id) || !['keep', 'discard'].includes(value))) throw new Error('方案保留决策无效');
  for (const value of [record.concatSingleFile, record.stripOriginalCover]) if (value !== undefined && typeof value !== 'boolean') throw new Error('方案选项无效');
  validateCompress(record.compress); validateSpatial(record.spatialConfig);
  if (record.compressionOnly !== undefined) {
    localPath(record.outputDirectory);
    if (record.outputPath !== null) localPath(record.outputPath);
    if (record.compressionOnly !== true || !record.compress?.enabled || record.cuts.length || record.cutsCount !== 0 || record.keptDurationMs !== record.totalDurationMs || record.concatSingleFile !== true || Object.keys(record.decisions).length !== 1 || record.decisions.seg_0 !== 'keep' || record.spatialConfig || record.segmentSpatialOverrides) throw new Error('整片压缩方案不能包含裁剪或画面处理');
  } else if (typeof record.outputPath !== 'string' || typeof record.keptDurationMs !== 'number' || !Number.isFinite(record.keptDurationMs) || record.keptDurationMs < 0) throw new Error('裁剪方案时长或输出路径无效');
  if (record.segmentSpatialOverrides) {
    if (typeof record.segmentSpatialOverrides !== 'object' || Array.isArray(record.segmentSpatialOverrides) || Object.keys(record.segmentSpatialOverrides).length > record.cuts.length + 1) throw new Error('分段画面配置无效');
    for (const [id, config] of Object.entries(record.segmentSpatialOverrides)) { if (!validId(id) || !config) throw new Error('独立画面配置对应分段不存在'); validateSpatial(config); }
  }
  if (JSON.stringify(record).length > 4 * 1024 * 1024) throw new Error('方案内容过大');
}

/** 仅登记用户实际选择、已保存方案或服务生成的文件，不向页面暴露任意路径登记接口。 */
export class FileAccessRegistry {
  private media = new Map<string, string>();
  private reveals = new Set<string>();
  private key(file: string) { const result = path.resolve(file); return process.platform === 'win32' ? result.toLowerCase() : result; }
  async authorize(file: string): Promise<string> {
    localPath(file);
    const resolved = await fs.promises.realpath(file);
    if (!(await fs.promises.stat(resolved)).isFile()) throw new Error('素材不是普通文件');
    this.media.set(this.key(file), this.key(resolved)); this.media.set(this.key(resolved), this.key(resolved));
    this.allowReveal(file); return file;
  }
  async check(file: string): Promise<string> {
    localPath(file);
    const expected = this.media.get(this.key(file));
    if (!expected) throw new Error('文件尚未授权，请先选择素材或载入已保存方案');
    this.media.delete(this.key(file)); this.media.set(this.key(file), expected);
    const real = await fs.promises.realpath(file);
    if (expected !== this.key(real) || !(await fs.promises.stat(real)).isFile()) throw new Error('素材路径目标已变更，请重新选择');
    return real;
  }
  allowReveal(file: string) { if (typeof file === 'string' && file && path.isAbsolute(file)) { this.reveals.add(this.key(file)); if (this.reveals.size > 4096) this.reveals.delete(this.reveals.values().next().value!); } }
  checkReveal(file: string) { localPath(file); if (!this.reveals.has(this.key(file))) throw new Error('目录定位请求未授权'); }
  clear() { this.media.clear(); this.reveals.clear(); }
}
