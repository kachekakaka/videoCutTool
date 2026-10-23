import mpegts from '@stream-player';
import { frameAt, StreamPlaybackSnapshot } from '../../shared/streamPlayback';
import type { MediaMetadata } from '../../shared/types';

interface Observer {
  time: (sourceMs: number) => void; busy: (busy: boolean) => void;
  status: (text: string) => void; metadata?: (metadata: MediaMetadata) => void;
  error: (message: string) => void;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class StreamPlaybackController {
  private player?: ReturnType<typeof mpegts.createPlayer>;
  private snapshot: StreamPlaybackSnapshot;
  private externalIndex = { times: [] as number[], filepositions: [] as number[] };
  private closed = false;
  private epoch = 0;
  private frameCallback = 0;
  private presented?: { pts: number; at: number };
  private position = 0;
  private seeking = false;
  private desiredPlaying = false;
  private announcedMetadata = false;
  constructor(private video: HTMLVideoElement, snapshot: StreamPlaybackSnapshot, private observer: Observer) { this.snapshot = snapshot; }
  private adopt(snapshot: StreamPlaybackSnapshot) {
    this.snapshot = snapshot;
    this.externalIndex.times.splice(0, this.externalIndex.times.length, ...snapshot.index.times);
    this.externalIndex.filepositions.splice(0, this.externalIndex.filepositions.length, ...snapshot.index.filepositions);
    if (snapshot.error) throw new Error(snapshot.error);
    this.observer.status(snapshot.complete ? '' : `正在建立定位索引 ${Math.floor(snapshot.progress)}%`);
    if (snapshot.metadata && !this.announcedMetadata) { this.announcedMetadata = true; this.observer.metadata?.(snapshot.metadata); }
  }
  async start() {
    this.adopt(this.snapshot);
    while (!this.externalIndex.times.length && !this.closed) { await delay(100); if (!this.closed) this.adopt(await window.electronAPI!.streamStatus(this.snapshot.id)); }
    if (this.closed) return;
    if (!mpegts.isSupported()) throw new Error('当前环境不支持流式视频解码');
    const config = { enableWorker: false, enableWorkerForMSE: false, accurateSeek: true, lazyLoad: true, lazyLoadMaxDuration: 30, lazyLoadRecoverDuration: 10, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 20, autoCleanupMinBackwardDuration: 10, enableStashBuffer: false, fixAudioTimestampGap: false, vctExternalIndex: this.externalIndex, vctPreciseVideo: true };
    this.player = mpegts.createPlayer({ type: this.snapshot.container, isLive: false, url: this.snapshot.url, ...(this.snapshot.complete ? { duration: this.snapshot.durationMs + this.snapshot.offsetMs } : {}) }, config);
    this.player.on(mpegts.Events.ERROR, (_type: string, _detail: string, info: unknown) => { if (!this.closed) { this.pause(); this.observer.error(`流式播放失败：${typeof info === 'object' ? JSON.stringify(info) : String(info)}`); } });
    this.frameCallback = this.video.requestVideoFrameCallback(this.onFrame);
    this.player.attachMediaElement(this.video); this.player.load();
    // 首帧只由暂停定位解码，不通过播放数帧模拟确认。
    const first = this.snapshot.index.times[0];
    const initial = () => { if (!this.closed && !this.presented) this.player!.currentTime = Math.max(0, first + 0.5) / 1000; };
    this.video.addEventListener('loadedmetadata', initial, { once: true });
    if (!this.snapshot.complete) void this.poll();
  }
  private async poll() {
    try {
      while (!this.closed && !this.snapshot.complete) { await delay(500); if (!this.closed) this.adopt(await window.electronAPI!.streamStatus(this.snapshot.id)); }
    } catch (error) { if (!this.closed) { this.pause(); this.observer.error(String(error)); } }
  }
  private onFrame = (now: number, metadata: VideoFrameCallbackMetadata) => {
    if (this.closed) return;
    this.presented = { pts: metadata.mediaTime * 1000, at: now };
    if (!this.seeking) {
      const s = this.snapshot;
      if (s.frames?.length) { const at = frameAt(s.frames, Math.round((metadata.mediaTime * 1000 + s.baseMs) * 1000) + 999); this.position = Math.max(0, (s.frames[at] - s.originUs) / 1000); }
      else this.position = Math.max(0, metadata.mediaTime * 1000 - s.offsetMs);
      this.observer.time(this.position);
    }
    this.frameCallback = this.video.requestVideoFrameCallback(this.onFrame);
  };
  current() { return this.position; }
  play() { this.desiredPlaying = true; if (!this.seeking && !this.closed) void this.video.play().catch(error => this.observer.error(String(error))); }
  pause() { this.desiredPlaying = false; this.video.pause(); }
  suspend() { this.pause(); this.epoch++; this.player?.unload(); this.seeking = false; this.observer.busy(false); }
  async seek(sourceMs: number, direction: -1 | 0 | 1 = 0): Promise<boolean> {
    const epoch = ++this.epoch;
    this.seeking = true; this.observer.busy(true); this.video.pause();
    const valid = () => !this.closed && epoch === this.epoch;
    try {
      while (valid() && !this.snapshot.complete && sourceMs + 1 >= this.snapshot.indexedUntilMs) { this.observer.status('正在建立该位置的定位索引'); await delay(100); }
      if (!valid()) return false;
      const target = await window.electronAPI!.streamFrame(this.snapshot.id, Math.max(0, sourceMs), direction);
      if (!valid()) return false;
      if (target.atBoundary && this.presented && Math.abs(this.presented.pts - target.presentationMs) < 0.2) return true;
      const start = performance.now();
      this.player!.currentTime = Math.max(0, target.presentationMs + Math.min(1, (target.nextPresentationMs - target.presentationMs) / 2)) / 1000;
      while (valid()) {
        if (!this.video.seeking && this.presented && this.presented.at >= start && Math.abs(this.presented.pts - target.presentationMs) < 0.2) {
          this.position = target.sourceMs; this.observer.time(this.position); return true;
        }
        if (performance.now() - start > 10000) throw new Error('定位超时，尚未确认目标画面，请重试');
        await delay(10);
      }
      return false;
    } finally {
      if (valid()) { this.seeking = false; this.observer.busy(false); if (this.desiredPlaying) this.play(); }
    }
  }
  destroy() {
    if (this.closed) return;
    this.closed = true; this.epoch++; this.video.cancelVideoFrameCallback(this.frameCallback);
    this.player?.destroy(); this.player = undefined; this.video.removeAttribute('src'); this.video.load();
    void window.electronAPI!.closeStream(this.snapshot.id).catch(() => {});
  }
}
