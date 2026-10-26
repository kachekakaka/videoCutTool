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
  private failure?: string;
  private initial?: () => void;
  private initialized = false;
  hasNavigation() { return this.epoch > 0; }
  constructor(private video: HTMLVideoElement, snapshot: StreamPlaybackSnapshot, private observer: Observer) { this.snapshot = snapshot; }
  private adopt(snapshot: StreamPlaybackSnapshot) {
    this.snapshot = snapshot;
    // 保持库持有的数组引用；全关键帧长片不能用展开参数触发调用栈上限。
    this.externalIndex.times.length = 0; this.externalIndex.filepositions.length = 0;
    for (const value of snapshot.index.times) this.externalIndex.times.push(value);
    for (const value of snapshot.index.filepositions) this.externalIndex.filepositions.push(value);
    if (snapshot.error) throw new Error(snapshot.error);
    this.observer.status(snapshot.complete ? '' : `正在建立定位索引 ${Math.floor(snapshot.progress)}%`);
    if (snapshot.metadata && !this.announcedMetadata) { this.announcedMetadata = true; this.observer.metadata?.(snapshot.metadata); }
  }
  async start() {
    this.adopt(this.snapshot);
    // 首次与复用索引都从完整时长启动，避免文件头时长为零时留下半初始化播放器。
    while (!this.snapshot.complete && !this.closed) {
      await delay(300);
      if (this.closed) return;
      const progress = await window.electronAPI!.streamProgress(this.snapshot.id);
      if (this.closed) return;
      if (progress.error) throw new Error(progress.error);
      if (progress.complete) {
        const snapshot = await window.electronAPI!.streamStatus(this.snapshot.id);
        if (!this.closed) this.adopt(snapshot);
      } else this.observer.status(`正在建立定位索引 ${Math.floor(progress.progress)}%`);
    }
    if (this.closed) return;
    if (!this.externalIndex.times.length || !Number.isFinite(this.snapshot.durationMs) || !(this.snapshot.durationMs > 0)) throw new Error('完整定位索引缺少有效时长或关键帧');
    if (!mpegts.isSupported()) throw new Error('当前环境不支持流式视频解码');
    const config = { enableWorker: false, enableWorkerForMSE: false, accurateSeek: true, lazyLoad: true, lazyLoadMaxDuration: 30, lazyLoadRecoverDuration: 10, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 20, autoCleanupMinBackwardDuration: 10, enableStashBuffer: false, fixAudioTimestampGap: false, vctExternalIndex: this.externalIndex, vctPreciseVideo: true };
    this.player = mpegts.createPlayer({ type: this.snapshot.container, isLive: false, url: this.snapshot.url, duration: this.snapshot.durationMs + this.snapshot.offsetMs }, config);
    this.player.on(mpegts.Events.ERROR, (_type: string, _detail: string, info: unknown) => { if (!this.closed) { this.failure = `流式播放失败：${typeof info === 'object' ? JSON.stringify(info) : String(info)}`; this.pause(); this.observer.error(this.failure); } });
    this.frameCallback = this.video.requestVideoFrameCallback(this.onFrame);
    this.player.attachMediaElement(this.video); this.player.load();
    // 首帧只由暂停定位解码，不通过播放数帧模拟确认。
    const first = this.snapshot.index.times[0];
    this.initial = () => { if (!this.closed && !this.presented) this.player!.currentTime = Math.max(0, first + 0.5) / 1000; };
    this.video.addEventListener('loadedmetadata', this.initial, { once: true });
    const began = performance.now();
    while (!this.closed && !this.presented) {
      if (this.failure) throw new Error(this.failure);
      if (performance.now() - began > 15000) throw new Error('等待流式首帧超时');
      await delay(20);
    }
    this.initialized = !this.closed;
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
  play() {
    if (this.closed) return;
    this.desiredPlaying = true;
    // 播放只改变播放意图，不能取消尚未确认的定位或提前解除切点保护。
    if (this.seeking || !this.initialized) return;
    this.observer.busy(false);
    void this.video.play().catch(error => { if (!this.closed && this.desiredPlaying) this.observer.error(String(error)); });
  }
  pause() { this.desiredPlaying = false; this.video.pause(); }
  async seek(sourceMs: number, direction: -1 | 0 | 1 = 0): Promise<boolean> {
    if (this.closed) return false;
    const epoch = ++this.epoch;
    this.seeking = true; this.observer.busy(true); this.video.pause();
    const valid = () => !this.closed && epoch === this.epoch;
    try {
      const readyAt = performance.now();
      while (valid() && !this.initialized) {
        if (this.failure) throw new Error(this.failure);
        if (performance.now() - readyAt > 15000) throw new Error('等待流式首帧超时');
        await delay(20);
      }
      while (valid() && !this.snapshot.complete && sourceMs + 1 >= this.snapshot.indexedUntilMs) { if (this.failure) throw new Error(this.failure); this.observer.status('正在建立该位置的定位索引'); await delay(100); }
      if (!valid()) return false;
      const target = await window.electronAPI!.streamFrame(this.snapshot.id, Math.max(0, sourceMs), direction);
      if (!valid()) return false;
      if (this.presented && !this.video.seeking && Math.abs(this.presented.pts - target.presentationMs) < 0.2) { this.position = target.sourceMs; this.observer.time(this.position); return true; }
      const start = performance.now();
      let retried = false;
      this.player!.currentTime = Math.max(0, (target.presentationMs + target.nextPresentationMs) / 2) / 1000;
      while (valid()) {
        if (!this.video.seeking && this.presented && this.presented.at >= start && Math.abs(this.presented.pts - target.presentationMs) < 0.2) {
          this.position = target.sourceMs; this.observer.time(this.position); return true;
        }
        // 远距离跳转时 MSE 的旧缓冲删除与新数据追加异步进行；浏览器可能先报
        // seeked 却仍显示旧画面；TS 初始时长还可能把远端目标截到旧缓冲尾部。
        // 目标已缓冲后只重试一次，仍必须收到目标帧回调。
        const buffered = this.video.buffered;
        const targetBuffered = Array.from({ length: buffered.length }, (_, i) => i).some(i => buffered.start(i) * 1000 <= target.presentationMs && buffered.end(i) * 1000 > target.presentationMs);
        const outsideTarget = this.video.currentTime * 1000 < target.presentationMs || this.video.currentTime * 1000 >= target.nextPresentationMs;
        if (!retried && performance.now() - start > 500 && targetBuffered && (outsideTarget || !this.video.seeking && this.video.readyState >= 2)) {
          retried = true;
          this.player!.currentTime = Math.max(0, target.presentationMs + (target.nextPresentationMs - target.presentationMs) / 4) / 1000;
        }
        if (performance.now() - start > 10000) throw new Error('定位超时，尚未确认目标画面，请重试');
        await delay(10);
      }
      return false;
    } catch (error) {
      if (!valid()) return false;
      this.desiredPlaying = false;
      throw error;
    } finally {
      if (valid()) { this.seeking = false; this.observer.busy(false); this.observer.status(this.snapshot.complete ? '' : '正在建立定位索引'); if (this.desiredPlaying) this.play(); }
    }
  }
  destroy() {
    if (this.closed) return;
    this.closed = true; this.epoch++; this.video.cancelVideoFrameCallback(this.frameCallback);
    if (this.initial) this.video.removeEventListener('loadedmetadata', this.initial);
    this.player?.destroy(); this.player = undefined; this.video.removeAttribute('src'); this.video.load();
    void window.electronAPI!.closeStream(this.snapshot.id).catch(() => {});
  }
}
