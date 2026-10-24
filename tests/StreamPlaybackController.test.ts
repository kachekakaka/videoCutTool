import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamPlaybackController } from '../src/renderer/media/StreamPlaybackController';
import type { StreamPlaybackSnapshot } from '../src/shared/streamPlayback';

const backend = vi.hoisted(() => ({ player: {} as any }));
vi.mock('@stream-player', () => ({ default: { isSupported: () => true, Events: { ERROR: 'error' }, createPlayer: () => backend.player } }));

describe('流式定位与播放的交错', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  function setup() {
    let callback: VideoFrameRequestCallback;
    const video = {
      paused: true, seeking: false, readyState: 4, currentTime: 0,
      buffered: { length: 0 },
      play: vi.fn(async () => { video.paused = false; }), pause: vi.fn(() => { video.paused = true; }),
      requestVideoFrameCallback: vi.fn(fn => { callback = fn; return 1; }), cancelVideoFrameCallback: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(),
    };
    backend.player = { on: vi.fn(), attachMediaElement: vi.fn(), load: vi.fn(), destroy: vi.fn(), currentTime: 0 };
    const api = { closeStream: vi.fn(async () => {}), streamFrame: vi.fn(async () => ({ sourceMs: 600000, presentationMs: 600000, nextPresentationMs: 600040, atBoundary: false })) };
    vi.stubGlobal('window', { electronAPI: api });
    const observer = { time: vi.fn(), busy: vi.fn(), status: vi.fn(), error: vi.fn() };
    const snapshot = { id: 'test', container: 'flv', url: 'media://stream/test', complete: true, originUs: 0, baseMs: 0, offsetMs: 0, durationMs: 7200000, progress: 100, index: { times: [0, 600000], filepositions: [0, 1000] } } as StreamPlaybackSnapshot;
    const controller = new StreamPlaybackController(video as unknown as HTMLVideoElement, snapshot, observer);
    const frame = (ms: number) => callback(performance.now(), { mediaTime: ms / 1000 } as VideoFrameCallbackMetadata);
    const start = async () => { const pending = controller.start(); frame(0); await vi.advanceTimersByTimeAsync(20); await pending; };
    return { controller, video, api, observer, frame, start };
  }
  it('定位等待 IPC 时按播放，必须等目标画面确认后再播放', async () => {
    const f = setup(); await f.start();
    let resolve!: (target: any) => void;
    f.api.streamFrame.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const seeking = f.controller.seek(600000);
    f.controller.play();
    expect(f.video.play).not.toHaveBeenCalled();
    expect(f.observer.busy).toHaveBeenLastCalledWith(true);
    resolve({ sourceMs: 600000, presentationMs: 600000, nextPresentationMs: 600040 });
    await vi.advanceTimersByTimeAsync(10); f.frame(600000); await vi.advanceTimersByTimeAsync(10);
    expect(await seeking).toBe(true);
    expect(f.video.play).toHaveBeenCalledTimes(1);
    expect(f.controller.current()).toBe(600000);
    f.controller.destroy();
  });
  it('定位期间先播放再暂停，不会在目标确认后自行恢复', async () => {
    const f = setup(); await f.start();
    const seeking = f.controller.seek(600000); await vi.advanceTimersByTimeAsync(10);
    f.controller.play(); f.controller.pause(); f.frame(600000); await vi.advanceTimersByTimeAsync(10);
    expect(await seeking).toBe(true); expect(f.video.play).not.toHaveBeenCalled();
    f.controller.destroy();
  });
  it('关闭待定位会话后不再播放，且只释放一次', async () => {
    const f = setup(); await f.start();
    const seeking = f.controller.seek(600000); await vi.advanceTimersByTimeAsync(10);
    f.controller.destroy(); f.controller.play(); f.controller.destroy();
    await vi.advanceTimersByTimeAsync(10);
    expect(await seeking).toBe(false); expect(f.video.play).not.toHaveBeenCalled();
    expect(f.api.closeStream).toHaveBeenCalledTimes(1);
  });
  it('首帧准备期间的播放意图由首次定位确认后恢复', async () => {
    const f = setup(), starting = f.controller.start();
    f.controller.play(); expect(f.video.play).not.toHaveBeenCalled();
    expect(f.controller.hasNavigation()).toBe(false);
    f.frame(0); await vi.advanceTimersByTimeAsync(20); await starting;
    const seeking = f.controller.seek(600000); await vi.advanceTimersByTimeAsync(10);
    f.frame(600000); await vi.advanceTimersByTimeAsync(10);
    expect(await seeking).toBe(true); expect(f.video.play).toHaveBeenCalledTimes(1);
    f.controller.destroy();
  });
  it('目标画面超时后取消播放意图，不能从未确认的位置播放', async () => {
    const f = setup(); await f.start();
    const failed = expect(f.controller.seek(600000)).rejects.toThrow('定位超时');
    f.controller.play(); await vi.advanceTimersByTimeAsync(10020); await failed;
    expect(f.video.play).not.toHaveBeenCalled(); expect(f.observer.busy).toHaveBeenLastCalledWith(false);
    const seeking = f.controller.seek(600000); await vi.advanceTimersByTimeAsync(10);
    f.frame(600000); await vi.advanceTimersByTimeAsync(10); expect(await seeking).toBe(true);
    expect(f.video.play).not.toHaveBeenCalled(); f.controller.destroy();
  });
});
