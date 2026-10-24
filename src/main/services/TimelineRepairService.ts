import fs from 'fs';
import path from 'path';
import { abortError, fileIdentityAsync, probeFile, runMediaTool } from './MediaTools';
import { StreamPlaybackIndexService } from './StreamPlaybackIndexService';
import { frameTime, timeMs } from '../../shared/mediaTime';
import { REPAIR_CLOCK, RepairPacket, repairTimeline } from './RepairTimeline';
import { writeMp4Timeline } from './Mp4TimelineRepair';
import { CacheMaintenanceService } from './CacheMaintenanceService';
import { publishRepairOutput } from './RepairOutput';
import { TimelineRepairProgress } from '../../shared/timelineRepair';

/** 只读有限流摘要；已有后台分析由共享索引服务持有。 */
export async function inspectRepairSource(source: string, ffprobe: string, signal?: AbortSignal) {
  const info = JSON.parse(await runMediaTool(ffprobe, ['-v', 'error', '-probesize', '1048576', '-analyzeduration', '1000000', '-show_entries', 'format=format_name:stream=index,codec_type,codec_name,sample_rate,time_base', '-of', 'json', source], { signal, timeoutMs: 30000 }));
  const video = info.streams?.find((s: any) => s.codec_type === 'video'), audio = info.streams?.find((s: any) => s.codec_type === 'audio');
  if (info.streams?.length !== 2 || video?.codec_name !== 'h264' || audio?.codec_name !== 'aac' || Number(audio.sample_rate) !== 48000 || !['mpegts', 'flv', 'live_flv'].includes(info.format?.format_name)) throw new Error('当前断点修复仅支持单路 H.264 视频和 48 kHz AAC 音频的 TS/FLV 原片，不会自动转码或丢弃其他轨道');
  return { video, audio };
}

/** 显式修复任务入口；复用后台只读分析，用户确认后才生成新 MP4。 */
export async function repairToMp4(options: { source: string; output: string; temporaryRoot: string; ffmpeg: string; ffprobe: string; signal?: AbortSignal; maintenance?: CacheMaintenanceService; indexes?: StreamPlaybackIndexService; progress?: (progress: Omit<TimelineRepairProgress, 'requestId'>) => void }) {
  const { source, output, temporaryRoot, ffmpeg, ffprobe, signal } = options;
  const check = () => { if (signal?.aborted) throw abortError(); };
  check();
  if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('修复输出必须为新的 MP4 文件');
  const sourceIdentity = await fileIdentityAsync(source);
  // 输出已存在时立即退出；最终发布还会通过排他创建抵御竞争。
  try { await fs.promises.lstat(output); throw new Error('输出已存在，拒绝覆盖任何文件'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  options.progress?.({ stage: 'checking' });
  const { video, audio } = await inspectRepairSource(source, ffprobe, signal);
  const sourceSize = (await fs.promises.stat(source)).size;
  await fs.promises.mkdir(temporaryRoot, { recursive: true });
  for (const directory of [temporaryRoot, path.dirname(output)]) {
    const space = await fs.promises.statfs(directory);
    if (space.bavail * space.bsize < sourceSize * 1.1 + 64 * 1024 ** 2) throw new Error(`磁盘可用空间不足，需为完整修复副本预留空间：${directory}`);
  }
  options.progress?.({ stage: 'scanning', percent: 0 });
  let lastProgress = 0;
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
    if (Date.now() - lastProgress > 250) { lastProgress = Date.now(); options.progress?.({ stage: 'scanning', percent: Math.min(99, stream.position / sourceSize * 100) }); }
    stream.packets.push({ pts: ticks(p.pts), dts: ticks(p.dts), duration, position: stream.position, key: p.flags?.includes('K') === true });
  };
  if (options.indexes) {
    const shared = await options.indexes.complete(source, signal);
    if (!shared?.repair?.supported) throw new Error('已有分析结果不足以可靠修复此素材，不会重复扫描或自动转码');
    streams.get(video.index)!.packets = shared.repair.video; streams.get(audio.index)!.packets = shared.repair.audio;
  } else {
    await runMediaTool(ffprobe, ['-v', 'error', '-show_packets', '-show_entries', 'packet=stream_index,pts,dts,duration,pos,flags', '-of', 'compact=p=0', source], { signal, captureOutput: false, onOutput: chunk => { const lines = (tail + chunk).split(/\r?\n/); tail = lines.pop() || ''; if (tail.length > 16384) throw new Error('原片索引输出异常'); lines.forEach(consume); } });
    if (tail) consume(tail);
  }
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
    options.progress?.({ stage: 'remuxing' });
    await runMediaTool(ffmpeg, ['-v', 'error', '-n', '-dts_delta_threshold', '1', '-i', source, '-map', `0:${video.index}`, '-map', `0:${audio.index}`, '-c', 'copy', '-avoid_negative_ts', 'make_non_negative', carrier], { signal, captureOutput: false });
    check(); const handle = await fs.promises.open(carrier, 'r+');
    try { await writeMp4Timeline(handle, timeline); } finally { await handle.close(); }
    options.progress?.({ stage: 'validating' });
    const checked = JSON.parse(await runMediaTool(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,nb_frames,duration:format=duration', '-of', 'json', carrier], { signal, timeoutMs: 30000 }));
    const checkedVideo = checked.streams?.find((s: any) => s.codec_type === 'video'), checkedAudio = checked.streams?.find((s: any) => s.codec_type === 'audio');
    if (checked.streams?.length !== 2 || checkedVideo?.codec_name !== 'h264' || checkedAudio?.codec_name !== 'aac' || Number(checkedVideo.nb_frames) !== timeline.video.length || Number(checkedAudio.nb_frames) !== timeline.audio.length || !(Number(checked.format?.duration) > 0)) throw new Error('修复副本的轨道或帧数检查失败，未保存成品');
    if (await fileIdentityAsync(source) !== sourceIdentity) throw new Error('处理期间原片发生变化，拒绝输出');
    check();
    options.progress?.({ stage: 'publishing' });
    await publishRepairOutput(carrier, output, maintenance, signal, percent => options.progress?.({ stage: 'copying', percent }));
    if (options.indexes?.store) {
      try {
        const info = await probeFile(output, ffprobe), identity = await fileIdentityAsync(output);
        const points = timeline.video.flatMap((p, i) => { if (!streams.get(video.index)!.packets[i].key) return []; const time = frameTime(p.pts, `1/${REPAIR_CLOCK}`, info.origin); return [{ time, timeMs: timeMs(time) }]; });
        await options.indexes.store.publish(output, identity, 'frames', info, { version: 5, identity: `${ffprobe}:${identity}`, points });
      } catch (error) { throw new Error(`视频已无损保存至 ${output}，索引准备未完成：${String(error)}。已保存文件保留。`); }
    }
    return { output, videoPackets: timeline.video.length, audioPackets: timeline.audio.length, boundaries: timeline.boundaries, adjustedDuplicates: timeline.adjustedDuplicates, audioOverlapRepairs: timeline.audioOverlapRepairs, maxAudioAdjustmentMs: timeline.maxAudioAdjustment / REPAIR_CLOCK * 1000 };
  });
  } finally {
    if (directory) { await maintenance.abandon(directory); maintenance.release(directory); await maintenance.sweep(); }
    if (!options.maintenance) await maintenance.close();
  }
}
