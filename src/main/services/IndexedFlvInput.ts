import fs from 'fs';
import http from 'http';
import { randomUUID } from 'crypto';
import { abortError, fileIdentityAsync } from './MediaTools';

const word = (n: number, bytes: number) => { const b = Buffer.alloc(bytes); b.writeUIntBE(n, 0, bytes); return b; };
function amf(value: number | string | number[] | Record<string, unknown>): Buffer {
  if (typeof value === 'number') { const b = Buffer.alloc(9); b.writeDoubleBE(value, 1); return b; }
  if (typeof value === 'string') return Buffer.concat([Buffer.from([2]), word(Buffer.byteLength(value), 2), Buffer.from(value)]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([10]), word(value.length, 4), ...value.map(amf)]);
  return Buffer.concat([Buffer.from([3]), ...Object.entries(value).flatMap(([k, v]) => [word(Buffer.byteLength(k), 2), Buffer.from(k), amf(v as Parameters<typeof amf>[0])]), Buffer.from([0, 0, 9])]);
}

/** 在只读虚拟文件头中补齐寻址目录；视频数据仍按 Range 直接读取原片。 */
export async function openIndexedFlv(file: string, keys: Array<{ position: number; dtsMs: number }>, durationMs: number, signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
  const identity = await fileIdentityAsync(file), handle = await fs.promises.open(file, 'r');
  const streams = new Set<fs.ReadStream>(), token = randomUUID();
  let server: http.Server | undefined, closed = false, closing: Promise<void> | undefined;
  const metrics = { sourceBytes: 0, ranges: [] as Array<{ start: number; end: number }> };
  const close = () => closing ??= (async () => {
    closed = true; signal?.removeEventListener('abort', cancel);
    const stopped = [...streams].map(stream => new Promise<void>(resolve => { stream.once('close', resolve); stream.destroy(); }));
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await Promise.all(stopped); await handle.close();
  })();
  const cancel = () => { void close().catch(error => console.warn('索引输入关闭失败：', error)); };
  try {
    const size = (await handle.stat()).size, head = Buffer.alloc(13);
    if ((await handle.read(head, 0, 13, 0)).bytesRead !== 13 || head.toString('ascii', 0, 3) !== 'FLV' || head.readUInt32BE(5) !== 9) throw new Error('不支持此 FLV 文件头，不能安全建立寻址输入');
    let start = 13;
    // 去掉最前面的旧脚本元数据，保留所有音视频 Tag；不扫描媒体负载。
    const tag = Buffer.alloc(11);
    while (start + 11 <= size) {
      if ((await handle.read(tag, 0, 11, start)).bytesRead !== 11) throw new Error('FLV 文件头不完整');
      if (tag[0] !== 18) break;
      const next = start + 15 + tag.readUIntBE(1, 3);
      if (next > size || next <= start) throw new Error('FLV 元数据长度无效');
      start = next;
    }
    if (!keys.length || keys.some((k, i) => !Number.isSafeInteger(k.position) || k.position < start || k.position >= size || !Number.isFinite(k.dtsMs) || (i > 0 && (k.position <= keys[i - 1].position || k.dtsMs <= keys[i - 1].dtsMs)))) throw new Error('FLV 寻址索引无效');
    const metadata = (length: number) => {
      const data = Buffer.concat([amf('onMetaData'), amf({ duration: durationMs / 1000, keyframes: { times: keys.map(k => k.dtsMs / 1000), filepositions: keys.map(k => k.position - start + 13 + length) } })]);
      if (data.length > 0xffffff) throw new Error('FLV 原生寻址目录超出格式范围');
      const h = Buffer.alloc(11); h[0] = 18; h.writeUIntBE(data.length, 1, 3);
      return Buffer.concat([h, data, word(data.length + 11, 4)]);
    };
    const prefix = Buffer.concat([head, metadata(metadata(0).length)]), total = prefix.length + size - start;
    server = http.createServer(async (request, response) => {
      if (closed || request.url !== `/${token}.flv` || !['GET', 'HEAD'].includes(request.method || '')) { response.writeHead(403); response.end(); return; }
      try { if (await fileIdentityAsync(file) !== identity) throw new Error('素材已变化'); }
      catch { response.writeHead(409); response.end(); return; }
      if (closed || response.destroyed) { response.destroy(); return; }
      const range = request.headers.range, match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      const first = match ? Number(match[1]) : 0, last = match?.[2] ? Number(match[2]) : total - 1;
      if ((range && !match) || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last >= total || first > last) { response.writeHead(416, { 'Content-Range': `bytes */${total}` }); response.end(); return; }
      response.writeHead(match ? 206 : 200, { 'Content-Type': 'video/x-flv', 'Content-Length': last - first + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...(match ? { 'Content-Range': `bytes ${first}-${last}/${total}` } : {}) });
      if (request.method === 'HEAD') { response.end(); return; }
      if (first < prefix.length) response.write(prefix.subarray(first, Math.min(last + 1, prefix.length)));
      if (last < prefix.length) { response.end(); return; }
      const a = Math.max(first, prefix.length) - prefix.length + start, z = last - prefix.length + start;
      if (metrics.ranges.length < 10000) metrics.ranges.push({ start: a, end: z });
      const stream = fs.createReadStream(file, { start: a, end: z, highWaterMark: 64 * 1024 });
      streams.add(stream); stream.on('data', chunk => { metrics.sourceBytes += chunk.length; });
      const stop = () => stream.destroy(); response.once('close', stop);
      stream.once('close', () => { streams.delete(stream); response.off('close', stop); });
      stream.once('error', error => response.destroy(error)); stream.pipe(response);
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    if (signal?.aborted || await fileIdentityAsync(file) !== identity) throw abortError();
    signal?.addEventListener('abort', cancel, { once: true });
    return { url: `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}/${token}.flv`, metrics, close };
  } catch (error) { await close(); throw error; }
}
