import fs from 'fs';
import path from 'path';
import { formatTaskTimestamp } from '../../shared/timeUtils';

/** 产物始终跟随源文件；裁剪按方案归档，整片压缩共用一个目录。 */
export function resolveOutputDirectory(source: string, title?: string, compressionOnly = false): string {
  if (compressionOnly) return path.join(path.dirname(source), '压缩');
  const name = title?.trim() || path.basename(source, path.extname(source));
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) throw new Error('方案标题不能用于输出文件夹名称');
  return path.join(path.dirname(source), `cut_${name}`);
}

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
  const prefix = `${title}${base}`;
  const timestamp = options.timestamp || formatTaskTimestamp();
  const count = options.count || 1;
  for (let suffix = 0; suffix < 10000; suffix++) {
    const paths = Array.from({ length: count }, (_, i) => path.join(options.directory, `${prefix}${options.segmented ? `_seg${String(i + 1).padStart(2, '0')}` : title ? '' : '_cut'}_${timestamp}${suffix ? `_${String(suffix).padStart(2, '0')}` : ''}${extension}`));
    if (paths.every(candidate => path.resolve(candidate).toLowerCase() !== path.resolve(options.source).toLowerCase() && !fs.existsSync(candidate))) return paths;
  }
  throw new Error('同名产物过多，无法分配输出路径');
}
