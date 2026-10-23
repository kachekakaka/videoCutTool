import { FileHandle } from 'fs/promises';
import { REPAIR_CLOCK, RepairTimeline } from './RepairTimeline';

type Box = { type: string; data: Buffer };
const box = (type: string, data: Buffer): Buffer => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length + 8); head.write(type, 4, 4, 'ascii'); return Buffer.concat([head, data]); };
function children(data: Buffer): Box[] {
  const result: Box[] = [];
  for (let at = 0; at < data.length;) {
    if (at + 8 > data.length) throw new Error('MP4 元数据不完整');
    const size = data.readUInt32BE(at);
    if (size < 8 || at + size > data.length) throw new Error('不支持此 MP4 元数据结构');
    result.push({ type: data.toString('ascii', at + 4, at + 8), data: data.subarray(at + 8, at + size) }); at += size;
  }
  return result;
}
const join = (items: Box[]) => Buffer.concat(items.map(b => box(b.type, b.data)));
const one = (items: Box[], type: string) => { const found = items.filter(b => b.type === type); if (found.length !== 1) throw new Error(`MP4 缺少或重复 ${type}`); return found[0]; };
function header(data: Buffer, scale: number, duration: number): Buffer {
  // mvhd/mdhd 统一使用版本 1，四小时以上也不溢出 32 位时间刻度。
  if (data[0] !== 0 && data[0] !== 1) throw new Error('不支持此 MP4 时间头版本');
  const out = data[0] === 1 ? Buffer.from(data) : Buffer.concat([data.subarray(0, 4), Buffer.alloc(8), Buffer.alloc(8), data.subarray(12, 16), Buffer.alloc(8), data.subarray(20)]);
  if (data[0] === 0) { out.writeBigUInt64BE(BigInt(data.readUInt32BE(4)), 4); out.writeBigUInt64BE(BigInt(data.readUInt32BE(8)), 12); }
  out[0] = 1; out.writeUInt32BE(scale, 20); out.writeBigUInt64BE(BigInt(duration), 24); return out;
}
function trackHeader(data: Buffer, duration: number): Buffer {
  if (data[0] !== 0 && data[0] !== 1) throw new Error('不支持此 MP4 轨道头版本');
  const out = data[0] === 1 ? Buffer.from(data) : Buffer.concat([data.subarray(0, 4), Buffer.alloc(16), data.subarray(12, 20), Buffer.alloc(8), data.subarray(24)]);
  if (data[0] === 0) { out.writeBigUInt64BE(BigInt(data.readUInt32BE(4)), 4); out.writeBigUInt64BE(BigInt(data.readUInt32BE(8)), 12); }
  out[0] = 1; out.writeBigUInt64BE(BigInt(duration), 28); return out;
}
function runs(values: number[]): Buffer {
  const pairs: number[][] = [];
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error('MP4 时间表超出支持范围');
    const last = pairs.at(-1); if (last && last[1] === value) last[0]++; else pairs.push([1, value]);
  }
  const out = Buffer.alloc(8 + pairs.length * 8); out.writeUInt32BE(pairs.length, 4);
  pairs.forEach(([count, value], i) => { out.writeUInt32BE(count, 8 + i * 8); out.writeUInt32BE(value, 12 + i * 8); }); return out;
}
function edit(firstDts: number, firstPts: number, duration: number): Buffer {
  const entries = firstPts > 0 ? [[firstPts, -1], [duration - firstPts, firstPts - firstDts]] : [[duration, -firstDts]];
  const data = Buffer.alloc(8 + entries.length * 20); data[0] = 1; data.writeUInt32BE(entries.length, 4);
  entries.forEach(([length, time], i) => { data.writeBigUInt64BE(BigInt(length), 8 + i * 20); data.writeBigInt64BE(BigInt(time), 16 + i * 20); data.writeUInt16BE(1, 24 + i * 20); }); return box('elst', data);
}

/** 只接收调用方独占的新文件句柄；保留 mdat 和所有采样位置，仅追加新 moov。 */
async function rewriteMovie(file: FileHandle, change: (movie: Box[]) => void): Promise<void> {
  const size = (await file.stat()).size, head = Buffer.alloc(16);
  let moovAt = -1, original: Buffer | undefined;
  for (let at = 0; at < size;) {
    if ((await file.read(head, 0, 16, at)).bytesRead < 8) throw new Error('MP4 文件不完整');
    let length = head.readUInt32BE(), prefix = 8;
    if (length === 1) { length = Number(head.readBigUInt64BE(8)); prefix = 16; }
    if (!length) length = size - at;
    if (!Number.isSafeInteger(length) || length < prefix || at + length > size) throw new Error('MP4 区块长度无效');
    const type = head.toString('ascii', 4, 8);
    if (type === 'moof') throw new Error('暂不支持分片 MP4 修复');
    if (type === 'moov') {
      if (original || length > 64 * 1024 * 1024) throw new Error('MP4 元数据超出支持范围');
      original = Buffer.alloc(length - prefix); if ((await file.read(original, 0, original.length, at + prefix)).bytesRead !== original.length) throw new Error('MP4 元数据读取不完整'); moovAt = at;
    }
    at += length;
  }
  if (!original) throw new Error('没有找到 MP4 时间表');
  const movie = children(original); change(movie);
  const replacement = box('moov', join(movie));
  const write = async (buffer: Buffer, position: number) => { for (let at = 0; at < buffer.length;) { const { bytesWritten } = await file.write(buffer, at, buffer.length - at, position + at); if (!bytesWritten) throw new Error('MP4 时间表写入不完整'); at += bytesWritten; } };
  await write(replacement, size); await file.sync();
  await write(Buffer.from('free'), moovAt + 4); await file.sync();
}

export async function writeMp4Timeline(file: FileHandle, timeline: Pick<RepairTimeline, 'video' | 'audio'>): Promise<void> {
  return rewriteMovie(file, movie => {
  const seen = new Set<string>(); let movieDuration = 0;
  for (const track of movie.filter(b => b.type === 'trak')) {
    const parts = children(track.data), mdia = one(parts, 'mdia'), media = children(mdia.data), type = one(media, 'hdlr').data.toString('ascii', 8, 12);
    if (!['vide', 'soun'].includes(type) || seen.has(type)) throw new Error('仅支持单路 H.264 视频和 AAC 音频'); seen.add(type);
    const times = type === 'vide' ? timeline.video : timeline.audio;
    if (!times.length) throw new Error('时间表不能为空');
    if (times.some(t => !Number.isSafeInteger(t.pts) || !Number.isSafeInteger(t.dts) || !Number.isSafeInteger(t.duration) || t.pts < 0 || t.duration <= 0)) throw new Error('修复时间表存在无效刻度');
    const minf = one(media, 'minf'), info = children(minf.data), stbl = one(info, 'stbl'), samples = children(stbl.data);
    if (one(samples, 'stsz').data.readUInt32BE(8) !== times.length) throw new Error('时间表与压缩包数量不一致，拒绝修复');
    const durations = times.map((t, i) => i + 1 < times.length ? times[i + 1].dts - t.dts : t.duration);
    if (durations.some(d => d <= 0)) throw new Error('解码时间必须严格递增');
    const duration = times.reduce((max, t) => Math.max(max, t.pts + t.duration), 0);
    const decodeDuration = durations.reduce((a, b) => a + b, 0);
    const cts = times.map(t => t.pts - t.dts);
    const sampleParts = samples.filter(b => !['stts', 'ctts'].includes(b.type)); sampleParts.push({ type: 'stts', data: runs(durations) }, { type: 'ctts', data: runs(cts) });
    stbl.data = join(sampleParts); minf.data = join(info);
    one(media, 'mdhd').data = header(one(media, 'mdhd').data, REPAIR_CLOCK, decodeDuration); mdia.data = join(media);
    one(parts, 'tkhd').data = trackHeader(one(parts, 'tkhd').data, duration);
    // 明确使用解码起点，不能由封装器把视频和音频分别归零。
    track.data = join([...parts.filter(b => b.type !== 'edts'), { type: 'edts', data: edit(times[0].dts, times[0].pts, duration) }]);
    movieDuration = Math.max(movieDuration, duration);
  }
  if (seen.size !== 2) throw new Error('缺少音视频轨道');
  one(movie, 'mvhd').data = header(one(movie, 'mvhd').data, REPAIR_CLOCK, movieDuration);
  });
}

/** 音视频共用展示起点，隐藏解码预留造成的片头空白；片尾参考帧仍保留以支持无损拼接。 */
export async function removeMp4Preroll(file: FileHandle, startUs: bigint): Promise<void> {
  return rewriteMovie(file, movie => {
    const mvhd = one(movie, 'mvhd'), scale = mvhd.data.readUInt32BE(mvhd.data[0] === 1 ? 20 : 12);
    const start = Number((startUs * BigInt(scale) + 500000n) / 1000000n);
    const target = (mvhd.data[0] === 1 ? Number(mvhd.data.readBigUInt64BE(24)) : mvhd.data.readUInt32BE(16)) - start;
    if (!Number.isSafeInteger(target) || target <= 0) throw new Error('MP4 展示时长无效');
    for (const track of movie.filter(b => b.type === 'trak')) {
      const parts = children(track.data), edts = one(parts, 'edts'), edits = children(edts.data), elst = one(edits, 'elst'), data = elst.data;
      if (![0, 1].includes(data[0])) throw new Error('不支持此 MP4 编辑表版本');
      const wide = data[0] === 1, size = wide ? 20 : 12, count = data.readUInt32BE(4), rows: Buffer[] = [];
      if (data.length !== 8 + count * size) throw new Error('MP4 编辑表长度异常');
      const media = children(one(parts, 'mdia').data), mdhd = one(media, 'mdhd').data, mediaScale = mdhd.readUInt32BE(mdhd[0] === 1 ? 20 : 12);
      let left = target, skip = start;
      for (let i = 0; i < count && left > 0; i++) {
        const row = Buffer.from(data.subarray(8 + i * size, 8 + (i + 1) * size));
        const old = wide ? Number(row.readBigUInt64BE()) : row.readUInt32BE();
        if (skip >= old) { skip -= old; continue; }
        const duration = Math.min(left, old - skip), mediaTime = wide ? Number(row.readBigInt64BE(8)) : row.readInt32BE(4);
        if (mediaTime >= 0) { const adjusted = mediaTime + Math.round(skip * mediaScale / scale); if (wide) row.writeBigInt64BE(BigInt(adjusted), 8); else row.writeInt32BE(adjusted, 4); }
        skip = 0;
        if (wide) row.writeBigUInt64BE(BigInt(duration)); else row.writeUInt32BE(duration);
        rows.push(row); left -= duration;
      }
      const prefix = Buffer.from(data.subarray(0, 8)); prefix.writeUInt32BE(rows.length, 4); elst.data = Buffer.concat([prefix, ...rows]); edts.data = join(edits);
      one(parts, 'tkhd').data = trackHeader(one(parts, 'tkhd').data, target - left); track.data = join(parts);
    }
    mvhd.data = header(mvhd.data, scale, target);
  });
}
