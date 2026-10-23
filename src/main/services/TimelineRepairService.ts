import fs from 'fs';
import path from 'path';
import { abortError, fileIdentityAsync, runMediaTool } from './MediaTools';
import { REPAIR_CLOCK, RepairPacket, repairTimeline } from './RepairTimeline';
import { writeMp4Timeline } from './Mp4TimelineRepair';
import { CacheMaintenanceService } from './CacheMaintenanceService';

/** 显式修复任务入口。整片扫描只发生于此，不挂到导入、探测、保存或自动预览流程。 */
export async function repairToMp4(options: { source: string; output: string; temporaryRoot: string; ffmpeg: string; ffprobe: string; signal?: AbortSignal; maintenance?: CacheMaintenanceService }) {
  const { source, output, temporaryRoot, ffmpeg, ffprobe, signal } = options;
  const check = () => { if (signal?.aborted) throw abortError(); };
  check();
  if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('修复输出必须为新的 MP4 文件');
  const sourceIdentity = await fileIdentityAsync(source);
  // 输出已存在时立即退出；最终发布还会通过排他创建抵御竞争。
  try { await fs.promises.lstat(output); throw new Error('输出已存在，拒绝覆盖任何文件'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const info = JSON.parse(await runMediaTool(ffprobe, ['-v', 'error', '-show_entries', 'format=format_name:stream=index,codec_type,codec_name,sample_rate,time_base', '-of', 'json', source], { signal, timeoutMs: 30000 }));
  const video = info.streams?.find((s: any) => s.codec_type === 'video'), audio = info.streams?.find((s: any) => s.codec_type === 'audio');
  if (info.streams?.length !== 2 || video?.codec_name !== 'h264' || audio?.codec_name !== 'aac' || Number(audio.sample_rate) !== 48000 || !['mpegts', 'flv', 'live_flv'].includes(info.format?.format_name)) throw new Error('当前断点修复仅支持单路 H.264 视频和 48 kHz AAC 音频的 TS/FLV 原片');
  const streams = new Map<number, { packets: RepairPacket[]; num: number; den: number; position: number }>();
  for (const s of [video, audio]) { const [num, den] = s.time_base.split('/').map(Number); if (!num || !den || !Number.isInteger(REPAIR_CLOCK * num / den)) throw new Error('原片时基无法无损表达'); streams.set(s.index, { packets: [], num, den, position: 0 }); }
  let tail = '';
  const consume = (line: string) => {
    if (!line.trim()) return;
    const p = Object.fromEntries(line.split('|').map(field => field.split('='))), stream = streams.get(Number(p.stream_index));
    if (!stream) return;
    const ticks = (value: string) => { const number = Number(value), result = number * (REPAIR_CLOCK * stream.num / stream.den); if (!Number.isSafeInteger(number) || !Number.isSafeInteger(result)) throw new Error('原片缺少可靠时间戳'); return result; };
    const duration = Number(p.duration) > 0 ? ticks(p.duration) : 0;
    if (Number(p.stream_index) === audio.index && duration !== 15360) throw new Error('AAC 包时长异常，不能安全无损修复');
    if (Number.isSafeInteger(Number(p.pos)) && Number(p.pos) >= 0) stream.position = Number(p.pos);
    stream.packets.push({ pts: ticks(p.pts), dts: ticks(p.dts), duration, position: stream.position, key: p.flags?.includes('K') === true });
  };
  await runMediaTool(ffprobe, ['-v', 'error', '-show_packets', '-show_entries', 'packet=stream_index,pts,dts,duration,pos,flags', '-of', 'compact=p=0', source], { signal, captureOutput: false, onOutput: chunk => { const lines = (tail + chunk).split(/\r?\n/); tail = lines.pop() || ''; if (tail.length > 16384) throw new Error('原片索引输出异常'); lines.forEach(consume); } });
  if (tail) consume(tail);
  check(); const timeline = repairTimeline(streams.get(video.index)!.packets, streams.get(audio.index)!.packets);
  const maintenance = options.maintenance || new CacheMaintenanceService(path.join(temporaryRoot, '.cache-maintenance'));
  const root = path.join(temporaryRoot, 'slices', 'managed');
  maintenance.protect(source, output);
  let directory: string | undefined;
  try {
  await maintenance.registerRoot(root);
  directory = await maintenance.create(root, 'task', '');
  const carrier = path.join(directory, 'carrier.mp4');
  await maintenance.allowTaskFile(directory, carrier);
  return await maintenance.task(directory, async () => {
  let published: fs.Stats | undefined;
  try {
    await runMediaTool(ffmpeg, ['-v', 'error', '-n', '-dts_delta_threshold', '1', '-i', source, '-map', `0:${video.index}`, '-map', `0:${audio.index}`, '-c', 'copy', '-avoid_negative_ts', 'make_non_negative', carrier], { signal, captureOutput: false });
    check(); const handle = await fs.promises.open(carrier, 'r+');
    try { await writeMp4Timeline(handle, timeline); } finally { await handle.close(); }
    if (await fileIdentityAsync(source) !== sourceIdentity) throw new Error('处理期间原片发生变化，拒绝输出');
    check();
    // 同卷硬链接是排他的原子发布；跨卷使用排他句柄，取消时仅删除本次拥有的文件。
    try { await fs.promises.link(carrier, output); published = await fs.promises.stat(carrier); }
    catch (error: any) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
      const target = await fs.promises.open(output, 'wx'); published = await target.stat();
      try { await target.writeFile(fs.createReadStream(carrier), { signal }); await target.sync(); } finally { await target.close(); }
    }
    check();
    return { output, videoPackets: timeline.video.length, audioPackets: timeline.audio.length, boundaries: timeline.boundaries, adjustedDuplicates: timeline.adjustedDuplicates, audioOverlapRepairs: timeline.audioOverlapRepairs, maxAudioAdjustmentMs: timeline.maxAudioAdjustment / REPAIR_CLOCK * 1000 };
  } catch (error) {
    if (published) { const current = await fs.promises.lstat(output).catch(() => null); if (current?.ino === published.ino && current?.dev === published.dev) await fs.promises.unlink(output); }
    throw error;
  }
  });
  } finally {
    if (directory) { await maintenance.abandon(directory); maintenance.release(directory); await maintenance.sweep(); }
    if (!options.maintenance) await maintenance.close();
  }
}
