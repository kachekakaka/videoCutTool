import fs from 'fs';
import path from 'path';
import { formatTaskTimestamp } from '../../shared/timeUtils';

function titlePart(title: string | undefined, sourceBase: string): string {
  const clean = title?.trim();
  if (!clean || clean === sourceBase || /^plan_\d+$/.test(clean)) return '';
  if (/[<>:"/\\|?*\x00-\x1f]/.test(clean)) throw new Error('方案标题包含 Windows 文件名不支持的字符');
  return `[${clean}]`;
}
export function resolveOutputBatch(options: { directory: string; source: string; extension?: string; count?: number; segmented?: boolean; title?: string; timestamp?: string }): string[] {
  const extension = options.extension || path.extname(options.source) || '.mp4';
  const base = path.basename(options.source, path.extname(options.source));
  const title = titlePart(options.title, base);
  const prefix = `${options.timestamp || formatTaskTimestamp()}_${title}${base}`;
  const count = options.count || 1;
  for (let suffix = 0; suffix < 10000; suffix++) {
    const paths = Array.from({ length: count }, (_, i) => path.join(options.directory, `${prefix}${options.segmented ? `_seg${String(i + 1).padStart(2, '0')}` : title ? '' : '_cut'}${suffix ? `_${String(suffix).padStart(2, '0')}` : ''}${extension}`));
    if (paths.every(candidate => path.resolve(candidate).toLowerCase() !== path.resolve(options.source).toLowerCase() && !fs.existsSync(candidate))) return paths;
  }
  throw new Error('同名产物过多，无法分配输出路径');
}
