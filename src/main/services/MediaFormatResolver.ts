import path from 'path';
import { CompressConfig, ExportFormats, MediaStreamInfo } from '../../shared/types';

export const retainedStreams = (streams: MediaStreamInfo[], stripCover = true) => stripCover
  ? streams.filter(stream => (stream.type === 'video' && !stream.attachedPicture) || stream.type === 'audio')
  : streams;

const mp4Video = new Set(['h264', 'hevc', 'av1', 'mpeg4', 'mpeg2video', 'mjpeg', 'png']);
const mp4Audio = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);
function fitsMp4(streams: MediaStreamInfo[]): boolean {
  return streams.every(stream => stream.type === 'video' ? mp4Video.has(stream.codec) : stream.type === 'audio' ? mp4Audio.has(stream.codec) : stream.type === 'subtitle' && stream.codec === 'mov_text');
}
function fitsMkv(streams: MediaStreamInfo[]): boolean {
  return streams.every(stream => ['video', 'audio', 'attachment'].includes(stream.type) || (stream.type === 'subtitle' && ['subrip', 'ass', 'ssa', 'webvtt', 'hdmv_pgs_subtitle', 'dvd_subtitle'].includes(stream.codec)));
}
function fitsSource(extension: string, streams: MediaStreamInfo[]) {
  if (extension === '.mp4') return fitsMp4(streams);
  if (extension === '.mkv') return fitsMkv(streams);
  if (extension === '.webm') return streams.every(stream => stream.type === 'video' ? ['vp8', 'vp9', 'av1'].includes(stream.codec) : stream.type === 'audio' && ['opus', 'vorbis'].includes(stream.codec));
  if (extension === '.flv') return streams.filter(stream => stream.type === 'video').length <= 1 && streams.filter(stream => stream.type === 'audio').length <= 1 && streams.every(stream => stream.type === 'video' ? ['flv1', 'h264', 'vp6f', 'vp6a'].includes(stream.codec) : stream.type === 'audio' && ['aac', 'mp3', 'speex', 'nellymoser', 'adpcm_swf'].includes(stream.codec));
  // 原片已由这些容器承载其原始流，沿用同一布局。
  return ['.mov', '.avi', '.ts'].includes(extension);
}
export function resolveNormalizationExtension(streams: MediaStreamInfo[]): string {
  if (fitsMp4(streams)) return '.mp4';
  if (fitsMkv(streams)) return '.mkv';
  throw new Error('素材缺少展示时间戳，所选流没有可无损整理的容器');
}
export function resolveFormats(source: string, streams: MediaStreamInfo[], compress?: CompressConfig, stripCover = true): ExportFormats {
  const original = retainedStreams(streams, stripCover);
  const sourceExtension = path.extname(source).toLowerCase() || '.mkv';
  const intermediateExtension = fitsSource(sourceExtension, original) ? sourceExtension : fitsMkv(original) ? '.mkv' : null;
  if (!intermediateExtension) throw new Error('所选原始流没有可无损承载的中间容器，请检查附加流或素材格式');
  if (!compress?.enabled) return { intermediateExtension, outputExtension: intermediateExtension };
  const finalStreams = original.map(stream => stream.type === 'video' && !stream.attachedPicture ? { ...stream, codec: compress.preset === 'high_compression' ? 'hevc' : 'h264' } : stream);
  const outputExtension = fitsMp4(finalStreams) ? '.mp4' : fitsMkv(finalStreams) ? '.mkv' : null;
  if (!outputExtension) throw new Error('所选视频、音轨或附加流没有兼容的压缩输出容器；请启用首帧封面选项剥离附加流，或使用无损导出');
  return { intermediateExtension, outputExtension };
}
