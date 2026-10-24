import fs from 'fs';
import { KeyframePoint } from '../../shared/types';
import { addTime, rational, subtractTime, timeMs } from '../../shared/mediaTime';
import { abortError, ProbedFile } from './MediaTools';

type Box = { type: string; data: Buffer };
function boxes(data: Buffer): Box[] {
  const result: Box[] = [];
  for (let at = 0; at < data.length;) {
    if (at + 8 > data.length) throw new Error('MP4 索引区块不完整');
    let size = data.readUInt32BE(at), head = 8;
    if (size === 1) { if (at + 16 > data.length) throw new Error('MP4 索引头不完整'); size = Number(data.readBigUInt64BE(at + 8)); head = 16; }
    if (!size) size = data.length - at;
    if (!Number.isSafeInteger(size) || size < head || at + size > data.length) throw new Error('MP4 索引区块长度错误');
    result.push({ type: data.toString('ascii', at + 4, at + 8), data: data.subarray(at + head, at + size) }); at += size;
  }
  return result;
}
const get = (list: Box[], type: string) => list.find(b => b.type === type)?.data;
/** 读取非分片 MP4 的时间表，跳过 mdat；修复成品索引丢失时也无需重新解码整片。 */
export async function readMp4Keyframes(file: string, info: ProbedFile, signal?: AbortSignal): Promise<KeyframePoint[] | undefined> {
  const f = await fs.promises.open(file, 'r');
  try {
    const size = (await f.stat()).size, h = Buffer.alloc(16); let movie: Buffer | undefined;
    await f.read(h, 0, 16, 0);
    if (!['ftyp', 'moov', 'free', 'wide', 'mdat'].includes(h.toString('ascii', 4, 8))) return;
    for (let at = 0; at < size;) {
      if (signal?.aborted) throw abortError();
      const count = (await f.read(h, 0, 16, at)).bytesRead; if (count < 8) throw new Error('MP4 文件不完整');
      let length = h.readUInt32BE(), head = 8;
      if (length === 1) { if (count < 16) throw new Error('MP4 文件头不完整'); length = Number(h.readBigUInt64BE(8)); head = 16; }
      if (!length) length = size - at;
      if (!Number.isSafeInteger(length) || length < head || at + length > size) throw new Error('MP4 区块长度错误');
      const type = h.toString('ascii', 4, 8); if (type === 'moof') return;
      if (type === 'moov') {
        if (movie || length > 64 * 1024 ** 2) return;
        movie = Buffer.alloc(length - head); if ((await f.read(movie, 0, movie.length, at + head)).bytesRead !== movie.length) throw new Error('MP4 时间表读取不完整');
      }
      at += length;
    }
    if (!movie) return;
    const top = boxes(movie), mvhd = get(top, 'mvhd'); if (!mvhd || get(top, 'mvex')) return;
    const movieScale = mvhd.readUInt32BE(mvhd[0] === 1 ? 20 : 12);
    const tracks = top.filter(b => b.type === 'trak').map(b => boxes(b.data)).filter(t => { const media = get(t, 'mdia'); return media && get(boxes(media), 'hdlr')?.toString('ascii', 8, 12) === 'vide'; });
    if (tracks.length !== 1 || info.streams.filter(s => s.type === 'video').length !== 1) return;
    const track = tracks[0], media = boxes(get(track, 'mdia')!), mdhd = get(media, 'mdhd')!;
    const scale = mdhd.readUInt32BE(mdhd[0] === 1 ? 20 : 12); if (!scale || !movieScale) throw new Error('MP4 时间刻度无效');
    const minf = get(media, 'minf'); if (!minf) return;
    const table = get(boxes(minf), 'stbl'); if (!table) return;
    const samples = boxes(table), stts = get(samples, 'stts'), stsz = get(samples, 'stsz'), ctts = get(samples, 'ctts'), stss = get(samples, 'stss');
    if (!stts || !stsz) return;
    let offset = rational(0n, 1n);
    const edts = get(track, 'edts');
    if (edts) {
      const elst = get(boxes(edts), 'elst'); if (!elst || ![0, 1].includes(elst[0])) return;
      const wide = elst[0] === 1, count = elst.readUInt32BE(4), step = wide ? 20 : 12;
      if (elst.length !== 8 + count * step) throw new Error('MP4 编辑时间表不完整');
      let empty = 0n, mediaEdits = 0;
      for (let i = 0; i < count; i++) {
        const p = 8 + i * step, duration = wide ? elst.readBigUInt64BE(p) : BigInt(elst.readUInt32BE(p));
        const start = wide ? elst.readBigInt64BE(p + 8) : BigInt(elst.readInt32BE(p + 4));
        const rateAt = p + (wide ? 16 : 8); if (elst.readInt16BE(rateAt) !== 1 || elst.readInt16BE(rateAt + 2) !== 0) return;
        if (start === -1n && !mediaEdits) empty += duration;
        else { if (++mediaEdits !== 1 || i !== count - 1) return; offset = subtractTime(rational(empty, BigInt(movieScale)), rational(start, BigInt(scale))); }
      }
    }
    const count = stsz.readUInt32BE(8), keys = stss ? Array.from({ length: stss.readUInt32BE(4) }, (_, i) => stss.readUInt32BE(8 + i * 4)) : undefined;
    if (keys?.some((n, i) => n < 1 || n > count || (i && n <= keys[i - 1]))) throw new Error('MP4 关键帧样本编号无效');
    const runs = (b: Buffer, signed = false) => {
      const n = b.readUInt32BE(4); if (b.length !== 8 + n * 8) throw new Error('MP4 时间表长度无效');
      const r = Array.from({ length: n }, (_, i) => ({ count: b.readUInt32BE(8 + i * 8), value: signed ? b.readInt32BE(12 + i * 8) : b.readUInt32BE(12 + i * 8) }));
      if (r.some(x => !x.count) || r.reduce((sum, x) => sum + x.count, 0) !== count) throw new Error('MP4 样本与时间表数量不符'); return r;
    };
    const decode = runs(stts), composition = ctts ? runs(ctts, ctts[0] === 1) : [{ count, value: 0 }];
    let d = 0, c = 0, dl = decode[0].count, cl = composition[0].count, ticks = 0n, key = 0; const points: KeyframePoint[] = [];
    for (let i = 1; i <= count; i++) {
      if (!keys || keys[key] === i) {
        const time = subtractTime(addTime(rational(ticks + BigInt(composition[c].value), BigInt(scale)), offset), info.origin);
        const ms = timeMs(time); if (ms <= info.durationMs + 1000) points.push({ time, timeMs: ms }); key++;
      }
      ticks += BigInt(decode[d].value);
      if (--dl === 0 && d + 1 < decode.length) dl = decode[++d].count;
      if (--cl === 0 && c + 1 < composition.length) cl = composition[++c].count;
    }
    if (signal?.aborted) throw abortError();
    points.sort((a, b) => a.timeMs - b.timeMs);
    if (!points.length || points.some((p, i) => !Number.isFinite(p.timeMs) || (i > 0 && p.timeMs <= points[i - 1].timeMs))) throw new Error('MP4 关键帧时间表无效');
    return points;
  } finally { await f.close(); }
}
