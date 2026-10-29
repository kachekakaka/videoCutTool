import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { CacheMaintenanceService } from '../src/main/services/CacheMaintenanceService';
import { MediaCuttingEngine } from '../src/main/services/MediaCuttingEngine';
import { RetentionDraft } from '../src/shared/RetentionDraft';
import * as mediaTools from '../src/main/services/MediaTools';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function executionFixture() {
  const base = path.resolve('../videoCutTool_tmp/20261029-单次导出轻量执行类/unit');
  await fs.promises.mkdir(base, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(base, 'execution-'));
  const files = ['ffmpeg-old.exe', 'ffprobe-old.exe', 'ffmpeg-new.exe', 'ffprobe-new.exe', 'source.mp4'].map(name => path.join(directory, name));
  await Promise.all(files.map(file => fs.promises.writeFile(file, '仅用于工具路径与生命周期检查')));
  return { directory, files };
}

describe('导出快照的缓存归属', () => {
  it('同一引擎连续失败后仍复用可发现的登记根，关闭引擎不关闭外部维护服务', async () => {
    const base = path.resolve('../videoCutTool_tmp/precise-review-20261023/unit');
    await fs.promises.mkdir(base, { recursive: true });
    const directory = await fs.promises.mkdtemp(path.join(base, 'case-'));
    const registry = path.join(directory, 'registry'), slices = path.join(directory, 'slices'), root = path.join(slices, 'managed');
    const manager = new CacheMaintenanceService(registry);
    const engine = new MediaCuttingEngine(undefined, slices, undefined, undefined, manager);
    const draft = new RetentionDraft(path.join(directory, 'source.mp4'), 1000);
    draft.setDecision('seg_0', 'discard');
    const plan = draft.toPlan([], { outputPath: directory });
    try {
      for (let i = 0; i < 3; i++) expect((await engine.executeRawPlan(plan)).error).toBe('未选择任何保留片段');
      expect(fs.existsSync(path.join(root, 'managed'))).toBe(false);
      expect((await fs.promises.readdir(registry)).filter(name => name.endsWith('.json'))).toHaveLength(1);
      expect((await fs.promises.readdir(root)).filter(name => name.startsWith('asset_'))).toEqual([]);
      await engine.shutdown();
      const task = await manager.create(root, 'task', '');
      const partial = path.join(task, 'precise_0_0.nut');
      await manager.allowTaskFile(task, partial); await fs.promises.writeFile(partial, '未完成的媒体');
      manager.release(task);
      await manager.close();
      const recovered = new CacheMaintenanceService(registry);
      try { await recovered.discover(); await recovered.sweep(); expect(fs.existsSync(task)).toBe(false); expect(recovered.issues).toEqual([]); }
      finally { await recovered.close(); }
    } finally { await engine.shutdown(); await manager.close(); }
  });
  it('引擎自建的维护服务在关闭后释放所有权，可以在同进程重新打开', async () => {
    const base = path.resolve('../videoCutTool_tmp/precise-review-20261023/unit');
    await fs.promises.mkdir(base, { recursive: true });
    const directory = await fs.promises.mkdtemp(path.join(base, 'owned-')), slices = path.join(directory, 'slices');
    const draft = new RetentionDraft(path.join(directory, 'source.mp4'), 1000); draft.setDecision('seg_0', 'discard');
    for (let i = 0; i < 2; i++) {
      const engine = new MediaCuttingEngine(undefined, slices);
      try { expect((await engine.executeRawPlan(draft.toPlan([], { outputPath: directory }))).success).toBe(false); }
      finally { await engine.shutdown(); }
      expect(fs.existsSync(path.join(slices, 'managed/.vct-owner.json'))).toBe(false);
    }
  });
});

describe('单次导出的工具快照与共享探测', () => {
  it('中途更新配置后，本次探测与媒体处理仍使用旧工具，后续探测使用新工具', async () => {
    const { directory, files: [oldFfmpeg, oldFfprobe, nextFfmpeg, nextFfprobe, source] } = await executionFixture();
    const engine = new MediaCuttingEngine(oldFfmpeg, path.join(directory, 'slices'));
    engine.updateTools(oldFfmpeg, oldFfprobe);
    const entered = deferred<void>(), resume = deferred<void>(), close = vi.fn(async () => {});
    engine.setInputProvider(async () => { entered.resolve(); await resume.promise; return { url: source, close }; });
    const info: mediaTools.ProbedFile = { durationMs: 1000, containerDurationMs: 1000, width: 640, height: 360, fps: 25, displayAspectRatio: 16 / 9, videoIndex: 0, videoStartMs: 0, timeBase: '1/1000', origin: { numerator: '0', denominator: '1' }, streams: [{ index: 0, type: 'video', codec: 'h264', attachedPicture: false, default: true }] };
    const probe = vi.spyOn(mediaTools, 'probeFile').mockResolvedValue(info);
    vi.spyOn(mediaTools, 'needsTimestampRepair').mockResolvedValue(false);
    const run = vi.spyOn(mediaTools, 'runMediaTool').mockImplementation(async (_tool, args) => {
      if (args.includes('lavfi')) return '';
      if (args.includes('-show_packets')) return JSON.stringify({ packets: [{ pts_time: '0', dts_time: '0', flags: 'K', data_hash: 'CRC32:test' }] });
      throw new Error('定向检查在媒体处理入口停止');
    });
    try {
      const draft = new RetentionDraft(source, 1000); draft.compress = { enabled: true, preset: 'balanced' };
      const pending = engine.executeRawPlan(draft.toPlan([0], { outputPath: source }));
      await entered.promise;
      engine.updateTools(nextFfmpeg, nextFfprobe); resume.resolve();
      expect((await pending).error).toBe('定向检查在媒体处理入口停止');
      expect(probe).toHaveBeenCalledWith(source, oldFfprobe, undefined);
      expect(run.mock.calls.map(call => call[0])).toEqual([oldFfmpeg, oldFfprobe, oldFfmpeg]);
      expect(close).toHaveBeenCalledTimes(1);
      expect(await engine.probeEncoderSupport()).toBe('nvenc');
      expect(run.mock.calls.at(-1)![0]).toBe(nextFfmpeg);
      expect(await engine.probeEncoderSupport()).toBe('nvenc');
      expect(run).toHaveBeenCalledTimes(4);
    } finally { resume.resolve(); await engine.shutdown(); vi.restoreAllMocks(); }
  });

  it('同键消费者共享一次探测，取消其中一个不影响另一个及后续缓存命中', async () => {
    const { directory, files: [ffmpeg] } = await executionFixture();
    const engine = new MediaCuttingEngine(ffmpeg, path.join(directory, 'slices'));
    const complete = deferred<string>(), canceled = new AbortController();
    const run = vi.spyOn(mediaTools, 'runMediaTool').mockImplementation(() => complete.promise);
    try {
      const first = engine.probeEncoderSupport(undefined, canceled.signal);
      const second = engine.probeEncoderSupport();
      const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
      canceled.abort(); await rejected;
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][2]?.signal?.aborted).toBe(false);
      complete.resolve('');
      expect(await second).toBe('nvenc');
      expect(await engine.probeEncoderSupport()).toBe('nvenc');
      expect(run).toHaveBeenCalledTimes(1);
    } finally { complete.resolve(''); await engine.shutdown(); vi.restoreAllMocks(); }
  });
});
