/** 音视频共用 720 kHz 时基，可精确表示 90 kHz 视频和 48 kHz 音频。 */
export const REPAIR_CLOCK = 720000;
export interface RepairPacket { pts: number; dts: number; duration: number; position: number; key: boolean }
export interface RepairBoundary { video: number; audio: number; offset: number; videoDelta: number; audioDelta: number }
export interface RepairTimeline { video: Array<{ pts: number; dts: number; duration: number }>; audio: Array<{ pts: number; dts: number; duration: number }>; boundaries: RepairBoundary[]; adjustedDuplicates: number; decodeDelay: number; audioOverlapRepairs: number; maxAudioAdjustment: number }
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

/** 先配对两路断点，再统一平移；不让交错到达的包各自触发一次时钟纠正。 */
export function repairTimeline(video: RepairPacket[], audio: RepairPacket[]): RepairTimeline {
  if (!video.length || !audio.length) throw new Error('修复需要完整的单路视频和音频索引');
  const jumps = (packets: RepairPacket[], isAudio: boolean) => packets.flatMap((p, i) => {
    if (!i) return [];
    const delta = (isAudio ? p.pts - packets[i - 1].pts : p.dts - packets[i - 1].dts);
    return delta < -REPAIR_CLOCK / 1000 || delta > REPAIR_CLOCK / 4 ? [{ i, delta, position: p.position }] : [];
  });
  const aj = jumps(audio, true), matched = new Set<number>();
  const boundaries: RepairBoundary[] = [{ video: 0, audio: 0, offset: -Math.min(video[0].pts, audio[0].pts), videoDelta: 0, audioDelta: 0 }];
  for (const v of jumps(video, false)) {
    const candidates = aj.filter(a => !matched.has(a.i) && Math.sign(a.delta) === Math.sign(v.delta) && Math.abs(a.delta - v.delta) < REPAIR_CLOCK / 3 && Math.abs(a.position - v.position) < 2 * 1024 * 1024);
    candidates.sort((a, b) => Math.abs(a.position - v.position) - Math.abs(b.position - v.position));
    const a = candidates[0];
    if (!a) { if (v.delta < 0) throw new Error('音视频回退断点无法配对'); continue; }
    matched.add(a.i);
    let first = v.i;
    // B 帧的展示时刻可能先跨过正向断点，而解码时刻仍落在断点前。
    if (v.delta > 0) {
      const threshold = Math.min(video[v.i].dts, audio[a.i].pts);
      while (first > boundaries.at(-1)!.video + 1 && first > v.i - 16 && video[first - 1].pts >= threshold) first--;
    }
    if (first <= boundaries.at(-1)!.video || a.i <= boundaries.at(-1)!.audio) throw new Error('断点次序无效');
    boundaries.push({ video: first, audio: a.i, offset: 0, videoDelta: v.delta, audioDelta: a.delta });
  }
  if (aj.some(a => !matched.has(a.i))) throw new Error('存在无法配对的音频断点，不能保证无损同步修复');
  const vp = new Array<number>(video.length), ap = new Array<number>(audio.length);
  let audioOverlapRepairs = 0, maxAudioAdjustment = 0;
  for (let e = 0; e < boundaries.length; e++) {
    const current = boundaries[e], next = boundaries[e + 1] ?? { video: video.length, audio: audio.length };
    if (e) {
      const previous = [...vp.slice(Math.max(0, current.video - 32), current.video)].sort((a, b) => a - b);
      const intervals = previous.slice(1).map((p, i) => p - previous[i]).filter(d => d > 0 && d < REPAIR_CLOCK / 4);
      if (!intervals.length) throw new Error('断点前缺少可靠的画面间隔');
      const end = previous.at(-1)! + median(intervals);
      const firstVideo = Math.min(...video.slice(current.video, Math.min(next.video, current.video + 16)).map(p => p.pts));
      current.offset = Math.max(end - firstVideo, ap[current.audio - 1] + audio[current.audio - 1].duration - audio[current.audio].pts);
    }
    for (let i = current.video; i < next.video; i++) vp[i] = video[i].pts + current.offset;
    for (let i = current.audio; i < next.audio; i++) {
      const requested = audio[i].pts + current.offset;
      ap[i] = i ? Math.max(requested, ap[i - 1] + audio[i - 1].duration) : requested;
      const adjustment = ap[i] - requested;
      if (adjustment > REPAIR_CLOCK / 10) throw new Error('片内音频重叠超过 100 毫秒，无法自动判断原始同步关系');
      if (adjustment > 1) audioOverlapRepairs++;
      maxAudioAdjustment = Math.max(maxAudioAdjustment, adjustment);
    }
  }
  // 相同展示时刻的不同画面平分到下一画面的间隔，避免微秒长的帧无法定位。
  const order = vp.map((pts, i) => ({ pts, i })).sort((a, b) => a.pts - b.pts || a.i - b.i);
  let adjustedDuplicates = 0;
  for (let j = 0; j < order.length;) {
    let end = j + 1;
    while (end < order.length && order[end].pts === order[j].pts) end++;
    if (end - j > 1) {
      const span = end < order.length ? order[end].pts - order[j].pts : REPAIR_CLOCK / 30;
      if (span < end - j) throw new Error('重复画面时刻无法安全展开');
      for (let k = j + 1; k < end; k++) { order[k].pts += Math.floor(span * (k - j) / (end - j)); vp[order[k].i] = order[k].pts; adjustedDuplicates++; }
    }
    j = end;
  }
  const durations = new Array<number>(vp.length);
  for (let j = 0; j < order.length; j++) durations[order[j].i] = j + 1 < order.length ? order[j + 1].pts - order[j].pts : median(order.slice(-16).slice(1).map((p, i) => p.pts - order.slice(-16)[i].pts).filter(d => d > 0));
  let decode = order[0].pts, decodeDelay = 0;
  const vt = vp.map((pts, i) => { const dts = decode; decodeDelay = Math.max(decodeDelay, dts - pts); decode += durations[i]; return { pts, dts, duration: durations[i] }; });
  for (const p of vt) p.dts -= decodeDelay;
  const at = ap.map((pts, i) => ({ pts, dts: pts, duration: audio[i].duration }));
  for (let i = 1; i < at.length; i++) if (at[i].pts < at[i - 1].pts + at[i - 1].duration - 1) throw new Error('音频原时轴存在片内重叠');
  return { video: vt, audio: at, boundaries, adjustedDuplicates, decodeDelay, audioOverlapRepairs, maxAudioAdjustment };
}
