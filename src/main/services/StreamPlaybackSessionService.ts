import fs from 'fs';
import { Readable } from 'stream';
import { StreamPlaybackIndexService, StreamIndexLease } from './StreamPlaybackIndexService';
import { StreamPlaybackSnapshot, StreamPreparationSnapshot } from '../../shared/streamPlayback';
import { abortError } from './MediaTools';

interface Session { id: string; owner: number; file: string; controller: AbortController; lease?: StreamIndexLease; streams: Set<fs.ReadStream>; ready: Promise<boolean> }
export class StreamPlaybackSessionService {
  private sessions = new Map<string, Session>();
  private closing = false;
  constructor(readonly indexes: StreamPlaybackIndexService) {}
  private async openSession(owner: number, file: string, id: string): Promise<Session | null> {
    if (this.closing) throw abortError();
    if (this.sessions.has(id)) throw new Error('播放会话已存在');
    if ([...this.sessions.values()].filter(s => s.owner === owner).length >= 4) throw new Error('打开的播放视图过多');
    const s: Session = { id, owner, file, controller: new AbortController(), streams: new Set(), ready: Promise.resolve(false) };
    this.sessions.set(id, s);
    s.ready = (async () => {
      const container = await this.indexes.identify(file);
      if (s.controller.signal.aborted) throw abortError();
      if (!container) { this.close(owner, id); return false; }
      s.lease = await this.indexes.acquire(file, container, s.controller.signal);
      if (s.controller.signal.aborted) throw abortError();
      // 会话只保存就绪结果，按调用用途生成返回值，不保留派生快照。
      return true;
    })().catch(error => { this.close(owner, id); throw error; });
    if (!await s.ready) return null;
    if (s.controller.signal.aborted) throw abortError();
    return s;
  }
  async open(owner: number, file: string, id: string): Promise<StreamPlaybackSnapshot | null> {
    const s = await this.openSession(owner, file, id);
    return s ? this.snapshot(s) : null;
  }
  async openPreparation(owner: number, file: string, id: string): Promise<StreamPreparationSnapshot | null> {
    const s = await this.openSession(owner, file, id);
    return s ? this.indexes.preparation(s.lease!) : null;
  }
  private session(owner: number, id: string) {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner || !s.lease || s.controller.signal.aborted) throw new Error('播放会话不存在或已失效');
    return s;
  }
  private snapshot(s: Session): StreamPlaybackSnapshot { return { id: s.id, url: `media://stream/${s.id}`, ...this.indexes.snapshot(s.lease!) }; }
  async status(owner: number, id: string) { const s = this.session(owner, id); await this.indexes.check(s.lease!); return this.snapshot(s); }
  async preparation(owner: number, id: string) { const s = this.session(owner, id); await this.indexes.check(s.lease!); return this.indexes.preparation(s.lease!); }
  async progress(owner: number, id: string) { const s = this.session(owner, id); await this.indexes.check(s.lease!); return this.indexes.progress(s.lease!); }
  async frame(owner: number, id: string, time: number, direction: -1 | 0 | 1) { const s = this.session(owner, id); await this.indexes.check(s.lease!); return this.indexes.frame(s.lease!, time, direction); }
  close(owner: number, id: string) {
    const s = this.sessions.get(id); if (!s || s.owner !== owner) return;
    this.sessions.delete(id); s.controller.abort(); s.lease?.release(); for (const stream of s.streams) stream.destroy();
  }
  closeOwner(owner: number) { for (const s of this.sessions.values()) if (s.owner === owner) this.close(owner, s.id); }
  async respond(owner: number, request: Request): Promise<Response> {
    const id = new URL(request.url).pathname.slice(1);
    let s: Session;
    try { s = this.session(owner, id); await this.indexes.check(s.lease!); }
    catch { return new Response('播放会话无效', { status: 403 }); }
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const total = (await fs.promises.stat(s.file)).size, range = request.headers.get('range');
    let start = 0, end = total - 1;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
      start = Number(match[1]); if (match[2]) end = Number(match[2]);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end >= total || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    if (s.controller.signal.aborted || request.signal.aborted) return new Response(null, { status: 410 });
    const stream = fs.createReadStream(s.file, { start, end, highWaterMark: 64 * 1024 }); s.streams.add(stream);
    const cancel = () => stream.destroy(); request.signal.addEventListener('abort', cancel, { once: true });
    stream.once('close', () => { s.streams.delete(stream); request.signal.removeEventListener('abort', cancel); });
    const headers: Record<string, string> = { 'Content-Type': s.lease!.job.data!.container === 'flv' ? 'video/x-flv' : 'video/mp2t', 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    return new Response(Readable.toWeb(stream, { strategy: { highWaterMark: 256 * 1024, size: (chunk: Buffer) => chunk.length } }) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
  }
  async shutdown() { this.closing = true; const pending = [...this.sessions.values()].map(s => s.ready); for (const s of this.sessions.values()) this.close(s.owner, s.id); await Promise.allSettled(pending); await this.indexes.shutdown(); }
}
