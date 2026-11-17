import path from 'path';
import { ProcessingError, ProcessingRequest } from '../../shared/processingTask';
import { validateCompress } from '../services/ProcessingValidation';
import type { CompressConfig } from '../../shared/types';

export const helpText = `VideoCutTool-cli compress --input <绝对路径> --output <完整文件路径> --data-dir <CLI 专用目录>
  [--preset balanced|high_quality|high_compression|scale_1080p|custom]
  [--encoder auto|cpu|nvenc|qsv] [--crf 0..51 --max-height 2..16384（仅 custom）] [--keep-cover]
VideoCutTool-cli cut --input <绝对路径> --output <完整文件路径> --data-dir <CLI 专用目录>
  --range <起点毫秒:终点毫秒> [--range ...] [--keep-cover]
VideoCutTool-cli --help | --version
无损剪切保全关键帧内容，实际起点可能提前、片尾可能扩出；多个区间可能因扩展重叠。
不覆盖已有文件。stdout 为唯一最终 JSON，进度和诊断在 stderr。Ctrl+C 取消并等待收尾。`;

export type CliArguments = { kind: 'help' | 'version' } | { kind: 'task'; dataDirectory: string; request: ProcessingRequest };
export function parseArguments(args: string[]): CliArguments {
  const invalid = (message: string): never => { throw new ProcessingError('INVALID_ARGUMENT', message, 2); };
  if (args.length === 1 && ['--help', '--version'].includes(args[0])) return { kind: args[0] === '--help' ? 'help' : 'version' };
  const operation = args[0];
  if (operation !== 'compress' && operation !== 'cut') return invalid('请指定 compress 或 cut；用 --help 查看用法');
  const values = new Map<string, string>(); const ranges: ProcessingRequest['ranges'] = [];
  const allowed = new Set(['--input', '--output', '--data-dir', '--keep-cover', ...(operation === 'cut' ? ['--range'] : ['--preset', '--crf', '--max-height', '--encoder'])]);
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key)) return invalid(`未知选项：${key}`);
    if (key !== '--range' && values.has(key)) return invalid(`重复选项：${key}`);
    if (key === '--keep-cover') { values.set(key, 'true'); continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) return invalid(`选项缺少值：${key}`);
    if (key === '--range') {
      if (!/^\d+:\d+$/.test(value)) return invalid('范围必须为非负整数毫秒 起点:终点');
      const [startMs, endMs] = value.split(':').map(Number);
      if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs >= endMs || (ranges.length && startMs < ranges[ranges.length - 1].endMs)) return invalid('范围必须递增、不重叠且起点小于终点');
      ranges.push({ startMs, endMs });
    } else values.set(key, value);
  }
  for (const key of ['--input', '--output', '--data-dir']) {
    const value = values.get(key);
    if (!value || value.includes('\0') || !path.isAbsolute(value)) return invalid(`${key} 必须为绝对路径`);
  }
  let compress: CompressConfig | undefined;
  if (operation === 'compress') {
    const preset = values.get('--preset') || 'balanced';
    if (preset !== 'custom' && (values.has('--crf') || values.has('--max-height'))) return invalid('--crf 和 --max-height 只允许用于 custom 预设');
    compress = { enabled: true, preset: preset as CompressConfig['preset'], encoder: (values.get('--encoder') || 'auto') as CompressConfig['encoder'] };
    for (const [key, field] of [['--crf', 'crf'], ['--max-height', 'maxHeight']] as const) {
      if (values.has(key)) { if (!/^\d+(\.\d+)?$/.test(values.get(key)!)) return invalid(`${key} 必须为数值`); compress[field] = Number(values.get(key)); }
    }
    try { validateCompress(compress); } catch (error) { return invalid(String(error)); }
  } else if (!ranges.length || ranges.length > 5000) return invalid('必须提供 1 至 5000 个有效范围');
  return { kind: 'task', dataDirectory: values.get('--data-dir')!, request: { operation, inputPath: values.get('--input')!, outputPath: values.get('--output')!, stripCover: !values.has('--keep-cover'), ...(compress ? { compress } : { ranges }) } };
}
