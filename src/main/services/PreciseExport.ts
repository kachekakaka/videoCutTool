import fs from 'fs';
import path from 'path';
import { MediaRetentionPlan, MediaStreamInfo, OutputFilePlan } from '../../shared/types';
import { buildSpatialFiltergraph, spatialOutputSize } from '../../shared/spatialFiltergraph';
import { ceilMicroseconds } from '../../shared/mediaTime';
import { ProbedFile, runMediaTool } from './MediaTools';

type Run = (key: string, args: string[], durationMs: number, signal?: AbortSignal) => Promise<void>;
const seconds = (value: number) => (value / 1000).toFixed(6);

/** 切点保存为毫秒；半毫秒容差恢复逐帧操作保存的原始帧，其他时间向后一帧对齐。 */
export function selectFrameBoundary(pointsMs: number[], requestedMs: number): number | undefined {
  return [...pointsMs].sort((a, b) => a - b).find(value => value >= requestedMs - 0.501);
}

async function frameBoundary(source: string, requestedMs: number, info: ProbedFile, ffprobe: string, signal?: AbortSignal): Promise<number> {
  const originMs = Number(ceilMicroseconds(info.origin)) / 1000;
  if (requestedMs >= info.durationMs - 0.501) return originMs + info.durationMs;
  const target = originMs + requestedMs;
  // 普通素材只检查邻近两秒；稀疏帧按需扩大窗口，不把固定两秒误当成下一帧必然存在。
  const mediaEnd = originMs + info.durationMs;
  for (const windowMs of [2000, 8000, 32000, 128000]) {
    const end = Math.min(target + windowMs, mediaEnd + 1000);
    const result = JSON.parse(await runMediaTool(ffprobe, ['-v', 'error', '-select_streams', String(info.videoIndex), '-read_intervals', `${seconds(Math.max(0, target - 1000))}%${seconds(end)}`, '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,duration_time,pkt_duration_time', '-of', 'json', source], { signal, timeoutMs: 30000 }));
    const frames = (result.frames ?? []).map((frame: any) => ({ pts: Number(frame.best_effort_timestamp_time) * 1000, duration: Number(frame.duration_time ?? frame.pkt_duration_time) * 1000 })).filter((frame: { pts: number }) => Number.isFinite(frame.pts));
    const boundary = selectFrameBoundary(frames.map((frame: { pts: number }) => frame.pts), target);
    if (boundary !== undefined) return boundary;
    if (end >= mediaEnd) {
      const tail = frames.reduce((last: number, frame: { pts: number; duration: number }) => Number.isFinite(frame.duration) && frame.duration > 0 ? Math.max(last, frame.pts + frame.duration) : last, -Infinity);
      // 终点位于最后一帧的显示区间内时，向后对齐到视频末尾；起点落入此处会由空区间检查拒绝。
      if (tail >= target - 0.501) return Math.min(tail, mediaEnd);
      break;
    }
  }
  throw new Error('切点附近没有可确认的显示帧，无法精确导出');
}

/** 顺序处理所选区间；视频只编码一次，音频先保留 PCM，拼接后统一编码，避免每段 AAC 延迟累积。 */
export async function exportPreciseFile(options: {
  plan: MediaRetentionPlan; filePlan: OutputFilePlan; fileIndex: number; info: ProbedFile;
  streams: MediaStreamInfo[]; directory: string; ffprobe: string; signal?: AbortSignal;
  run: Run; allowFile: (file: string) => Promise<void>;
}): Promise<string> {
  const { plan, filePlan, fileIndex, info, streams, directory, ffprobe, signal, run } = options;
  const videos = streams.filter(stream => stream.type === 'video' && !stream.attachedPicture);
  if (videos.length !== 1 || streams.some(stream => !['video', 'audio'].includes(stream.type) || stream.attachedPicture)) throw new Error('精确导出支持一路视频及全部音轨；请剥离封面，含字幕或附加流的素材请使用快速无损导出');
  const audio = streams.filter(stream => stream.type === 'audio');
  const size = { width: info.width, height: info.height };
  const target = spatialOutputSize(size, filePlan.spatialSegments[0]?.spatialConfig);
  const pieces: Array<{ file: string; durationMs: number }> = [];
  for (const [index, segment] of filePlan.spatialSegments.entries()) {
    if (signal?.aborted) throw new Error('操作已取消');
    const startMs = await frameBoundary(plan.sourcePath, segment.userRange.startMs, info, ffprobe, signal);
    const endMs = await frameBoundary(plan.sourcePath, segment.userRange.endMs, info, ffprobe, signal);
    const durationMs = endMs - startMs;
    if (durationMs <= 0) throw new Error('保留区间内没有完整显示帧');
    const seekMs = Math.max(0, startMs - 2000);
    const spatial = buildSpatialFiltergraph(size, segment.spatialConfig, target, `exact${index}_`)[1];
    const graph = [`[0:${info.videoIndex}]trim=start=${seconds(startMs)}:end=${seconds(endMs)},setpts=PTS-${seconds(startMs)}/TB${spatial ? ',' + spatial : ''},setsar=${(info.displayAspectRatio / (info.width / info.height)).toFixed(9)}[v]`];
    audio.forEach((stream, i) => graph.push(`[0:${stream.index}]atrim=start=${seconds(startMs)}:end=${seconds(endMs)},asetpts=PTS-${seconds(startMs)}/TB,aresample=48000:async=1:first_pts=0,apad,atrim=duration=${seconds(durationMs)}[a${i}]`));
    const file = path.join(directory, `precise_${fileIndex}_${index}.nut`);
    // 关闭输入自动裁剪，避免非零起始素材再次叠加起点；实际边界由绝对 PTS 滤镜控制。
    await run(`exact:${fileIndex}:${index}`, ['-n', '-copyts', '-noaccurate_seek', '-seek_timestamp', '1', '-ss', seconds(seekMs), '-i', plan.sourcePath,
      '-filter_complex', graph.join(';'), '-map', '[v]', ...audio.flatMap((_, i) => ['-map', `[a${i}]`]),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-bf', '0', '-pix_fmt', 'yuv420p', '-fps_mode:v', 'vfr', '-enc_time_base:v', '1:720000',
      '-c:a', 'pcm_s32le', '-t', seconds(durationMs), '-map_metadata', '-1', file], durationMs, signal);
    pieces.push({ file, durationMs });
  }
  const list = path.join(directory, `precise_${fileIndex}.ffconcat`);
  await options.allowFile(list);
  await fs.promises.writeFile(list, 'ffconcat version 1.0\n' + pieces.map(piece => `file '${piece.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\nduration ${seconds(piece.durationMs)}`).join('\n'), 'utf8');
  const totalMs = pieces.reduce((sum, piece) => sum + piece.durationMs, 0);
  const output = path.join(directory, `precise_${fileIndex}.mp4`);
  await run(`exact-final:${fileIndex}`, ['-n', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    // 每段时长可能不是整数音频采样数；以拼接 PTS 补齐/裁掉采样舍入量，避免随段数累计偏移。
    ...(audio.length ? ['-af', `aresample=48000:async=1:min_comp=0:min_hard_comp=0:first_pts=0,apad,atrim=duration=${seconds(totalMs)}`] : []),
    // 无 B 帧输出中 PTS 顺序即解码顺序；最后一帧持续至选定终点，不能套用名义帧率。
    '-bsf:v', `setts=duration=if(eq(NEXT_PTS\\,NOPTS)\\,round(${seconds(totalMs)}/TB)-PTS\\,NEXT_PTS-PTS)`,
    ...audio.flatMap((stream, i) => [...(stream.language ? [`-metadata:s:a:${i}`, `language=${stream.language}`] : []), `-disposition:a:${i}`, stream.default ? 'default' : '0']),
    '-t', seconds(totalMs), '-movie_timescale', '720000', '-video_track_timescale', '720000', '-map_metadata', '-1', output], totalMs, signal);
  const measured = JSON.parse(await runMediaTool(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,duration,start_time', '-of', 'json', output], { signal, timeoutMs: 30000 }));
  const video = measured.streams?.find((stream: any) => stream.codec_type === 'video');
  if (!video || !Number.isFinite(Number(video.duration)) || !Number.isFinite(Number(video.start_time)) || Math.abs(Number(video.duration) * 1000 - totalMs) > 1 || Math.abs(Number(video.start_time) * 1000) > 1) throw new Error('精确导出首尾时长校验失败，产物未发布');
  if (measured.streams.some((stream: any) => stream.codec_type === 'audio' && (!Number.isFinite(Number(stream.duration)) || !Number.isFinite(Number(stream.start_time)) || Math.abs(Number(stream.duration) * 1000 - totalMs) > 1 || Math.abs(Number(stream.start_time) * 1000) > 1))) throw new Error('精确导出音轨首尾时间与画面不一致，产物未发布');
  return output;
}
