import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { CacheMaintenanceService } from '../src/main/services/CacheMaintenanceService';
import { MediaCuttingEngine } from '../src/main/services/MediaCuttingEngine';
import { RetentionDraft } from '../src/shared/RetentionDraft';
import * as mediaTools from '../src/main/services/MediaTools';
import type { KeyframeProber } from '../src/main/services/KeyframeProber';
import type { MediaMetadata, PlanRecord } from '../src/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function executionFixture() {
  const base = path.resolve('../videoCutTool_tmp/20261029-导出原片版本绑定/unit');
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
    await fs.promises.writeFile(plan.sourcePath, '无保留片段的源文件');
    const data = { plan, source: { identity: await mediaTools.fileIdentityAsync(plan.sourcePath) }, compressionOnly: false };
    try {
      for (let i = 0; i < 3; i++) expect((await engine.executeRawPlan(data)).error).toBe('未选择任何保留片段');
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
    const plan = draft.toPlan([], { outputPath: directory });
    await fs.promises.writeFile(plan.sourcePath, '无保留片段的源文件');
    const data = { plan, source: { identity: await mediaTools.fileIdentityAsync(plan.sourcePath) }, compressionOnly: false };
    for (let i = 0; i < 2; i++) {
      const engine = new MediaCuttingEngine(undefined, slices);
      try { expect((await engine.executeRawPlan(data)).success).toBe(false); }
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
      const pending = engine.executeRawPlan({ plan: draft.toPlan([0], { outputPath: source }), source: { identity: await mediaTools.fileIdentityAsync(source) }, compressionOnly: false });
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

async function queuedFixture(compressionOnly = false) {
  const { directory, files: [ffmpeg, ffprobe, , , source] } = await executionFixture();
  const identity = await mediaTools.fileIdentityAsync(source);
  const info: mediaTools.ProbedFile = { durationMs: 1000, containerDurationMs: 1000, width: 640, height: 360, fps: 25, displayAspectRatio: 16 / 9, videoIndex: 0, videoStartMs: 0, timeBase: '1/1000', origin: { numerator: '0', denominator: '1' }, streams: [{ index: 0, type: 'video', codec: 'h264', attachedPicture: false, default: true }] };
  const metadata: MediaMetadata = { ...info, filePath: source, fileName: path.basename(source), sourceIdentity: identity, keyframes: [0] };
  const probeMetadata = vi.fn(async () => metadata);
  const prober = { probe: probeMetadata } as unknown as KeyframeProber;
  const maintenance = new CacheMaintenanceService(path.join(directory, 'registry'));
  const saved: PlanRecord[] = [];
  const saver = vi.fn(async (record: PlanRecord) => { saved.push(structuredClone(record)); });
  const finished = deferred<PlanRecord>(), blocked = deferred<void>();
  const engine = new MediaCuttingEngine(ffmpeg, path.join(directory, 'slices'), saver, event => {
    if (event.status === 'completed' || event.status === 'failed') finished.resolve(event.record!);
  }, maintenance);
  engine.updateTools(ffmpeg, ffprobe);
  engine.setStateListener(state => { if (state.storageError) blocked.resolve(); });
  const closeInput = vi.fn(async () => {});
  engine.setInputProvider(async () => ({ url: source, close: closeInput }));
  const draft = new RetentionDraft(source, info.durationMs);
  draft.compress = { enabled: true, preset: 'balanced', encoder: 'cpu', hardwareAcceleration: false };
  const record: PlanRecord = compressionOnly
    ? { id: 'compression', title: '整片压缩', compressionOnly: true, sourcePath: source, outputDirectory: path.join(directory, '压缩'), outputPath: null,
      totalDurationMs: null, keptDurationMs: null, cutsCount: 0, cuts: [], decisions: { seg_0: 'keep' }, compress: draft.compress,
      status: 'ready', updatedAt: new Date().toISOString(), completedAt: null }
    : { ...draft.toRecord({ id: 'cut', title: '裁剪' }), sourceIdentity: identity };
  const identityReads = vi.spyOn(mediaTools, 'fileIdentityAsync');
  const probe = vi.spyOn(mediaTools, 'probeFile').mockResolvedValue(info);
  vi.spyOn(mediaTools, 'needsTimestampRepair').mockResolvedValue(false);
  const run = vi.spyOn(mediaTools, 'runMediaTool').mockImplementation(async (_tool, args) => {
    if (args.includes('-show_packets')) return JSON.stringify({ packets: [{ pts_time: '0', dts_time: '0', flags: 'K', data_hash: 'CRC32:test' }] });
    const output = args.at(-1)!;
    await maintenance.allowTaskFile(path.dirname(output), output);
    await fs.promises.writeFile(output, '定向验证媒体产物');
    return '';
  });
  return { directory, source, identity, info, metadata, record, engine, maintenance, saved, saver, prober, probeMetadata, probe, run, identityReads, closeInput, finished, blocked,
    replace: () => fs.promises.appendFile(source, '模拟同路径的新原片版本'),
    submit: async () => { await engine.submitPlan(record, prober); return finished.promise; },
    close: async () => { try { await engine.shutdown(); await maintenance.close(); } finally { vi.restoreAllMocks(); } },
  };
}

describe('导出原片版本贯穿准备与发布', () => {
  it('未确认来源时不启动媒体准备', async () => {
    const f = await queuedFixture(); delete f.record.sourceIdentity;
    try {
      expect((await f.submit()).error).toContain('素材对应关系待确认');
      expect(f.probeMetadata).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
      expect(f.identityReads).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each(['缺失', '变化'])('探测返回的来源版本%s时拒绝生成计划', async kind => {
    const f = await queuedFixture();
    const plan = vi.spyOn(RetentionDraft.prototype, 'toPlan');
    f.probeMetadata.mockImplementationOnce(async () => {
      if (kind === '变化') await f.replace();
      return { ...f.metadata, sourceIdentity: kind === '缺失' ? undefined : mediaTools.fileIdentity(f.source) };
    });
    try {
      expect((await f.submit()).error).toContain('读取期间素材已变化');
      expect(plan).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
      expect(f.identityReads).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it.each([false, true])('临时目录等待时换片，执行入口拒绝建立新基准（整片压缩=%s）', async compressionOnly => {
    const f = await queuedFixture(compressionOnly), entered = deferred<void>(), resume = deferred<void>();
    const create = f.maintenance.create.bind(f.maintenance);
    vi.spyOn(f.maintenance, 'create').mockImplementation(async (...args) => { entered.resolve(); await resume.promise; return create(...args); });
    try {
      const pending = f.submit(); await entered.promise;
      await f.replace(); resume.resolve();
      expect((await pending).error).toContain('导出开始前原片发生变化');
      expect(f.run).not.toHaveBeenCalled();
      expect(f.probe).toHaveBeenCalledTimes(compressionOnly ? 1 : 0);
      expect(f.identityReads).toHaveBeenCalledTimes(compressionOnly ? 3 : 2);
      expect(await fs.promises.readdir(path.join(f.directory, 'slices/managed'))).not.toEqual(expect.arrayContaining([expect.stringMatching(/^asset_/)]));
    } finally { resume.resolve(); await f.close(); }
  });

  it('整片压缩准备信息保存期间换片，不使用旧摘要处理新原片', async () => {
    const f = await queuedFixture(true), entered = deferred<void>(), resume = deferred<void>();
    f.saver.mockImplementation(async record => {
      if (record.status === 'processing' && record.totalDurationMs !== null) { entered.resolve(); await resume.promise; }
    });
    try {
      const pending = f.submit(); await entered.promise;
      await f.replace(); resume.resolve();
      expect((await pending).error).toContain('导出开始前原片发生变化');
      expect(f.probe).toHaveBeenCalledTimes(1); expect(f.run).not.toHaveBeenCalled();
      expect(f.identityReads).toHaveBeenCalledTimes(3);
    } finally { resume.resolve(); await f.close(); }
  });

  it('处理期间换片，发布前拒绝产物并关闭输入和临时目录', async () => {
    const f = await queuedFixture();
    f.probe.mockImplementation(async file => {
      if (path.basename(file).startsWith('encoded_')) await f.replace();
      return f.info;
    });
    try {
      const final = await f.submit();
      expect(final.status).toBe('failed'); expect(final.error).toContain('导出期间原片发生变化');
      expect(await fs.promises.readdir(path.join(f.directory, 'cut'))).toEqual([]);
      expect(f.closeInput).toHaveBeenCalledTimes(1); expect(f.identityReads).toHaveBeenCalledTimes(3);
      expect((await fs.promises.readdir(path.join(f.directory, 'slices/managed'))).filter(name => name.startsWith('asset_'))).toEqual([]);
    } finally { await f.close(); }
  });

  it.each([false, true])('压缩准备保存失败后仍按当前版本复用或重新探测（换片=%s）', async changed => {
    const f = await queuedFixture(true); let rejected = false;
    f.saver.mockImplementation(async record => {
      if (!rejected && record.status === 'processing' && record.totalDurationMs !== null) { rejected = true; throw new Error('模拟准备状态保存失败'); }
    });
    try {
      await f.engine.submitPlan(f.record, f.prober); await f.blocked.promise;
      expect(f.engine.getQueueLength()).toBe(1); expect(f.run).not.toHaveBeenCalled();
      if (changed) await f.replace();
      await f.engine.retryPendingWrites();
      expect((await f.finished.promise).status).toBe('completed');
      expect(f.probe.mock.calls.filter(([file]) => file === f.source)).toHaveLength(changed ? 2 : 1);
      expect(f.identityReads).toHaveBeenCalledTimes(6);
      expect(f.run).toHaveBeenCalledTimes(1); expect(f.probeMetadata).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each([false, true])('正常导出维持身份读取次数和媒体工作量（整片压缩=%s）', async compressionOnly => {
    const f = await queuedFixture(compressionOnly);
    try {
      const final = await f.submit();
      expect(final.status).toBe('completed'); expect(fs.existsSync(final.outputPath!)).toBe(true);
      expect(f.saved.map(record => record.status)).toEqual(compressionOnly ? ['queued', 'processing', 'processing', 'completed'] : ['queued', 'processing', 'completed']);
      expect(f.identityReads).toHaveBeenCalledTimes(compressionOnly ? 4 : 3);
      expect(f.probe.mock.calls.filter(([file]) => file === f.source)).toHaveLength(1);
      expect(f.probe).toHaveBeenCalledTimes(compressionOnly ? 2 : 3);
      expect(f.run).toHaveBeenCalledTimes(compressionOnly ? 1 : 4);
      expect(f.closeInput).toHaveBeenCalledTimes(compressionOnly ? 0 : 1);
    } finally { await f.close(); }
  });

  it('完成结果保存失败后只重试保存，原片移除也不重新导出', async () => {
    const f = await queuedFixture(true); let rejected = false;
    f.saver.mockImplementation(async record => {
      f.saved.push(structuredClone(record));
      if (!rejected && record.status === 'completed') { rejected = true; throw new Error('模拟完成状态保存失败'); }
    });
    try {
      await f.engine.submitPlan(f.record, f.prober); await f.blocked.promise;
      expect(f.engine.isAccepted(f.record.id)).toBe(true);
      const output = f.saved.at(-1)!.outputPath;
      await f.engine.submitPlan(f.record, f.prober);
      await fs.promises.unlink(f.source);
      f.identityReads.mockClear(); f.probe.mockClear(); f.run.mockClear();
      await f.engine.retryPendingWrites();
      const final = await f.finished.promise;
      expect(final.status).toBe('completed'); expect(final.outputPath).toBe(output); expect(fs.existsSync(output!)).toBe(true);
      expect(f.engine.isAccepted(f.record.id)).toBe(false);
      expect(f.identityReads).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
      expect(f.saved.map(record => record.status)).toEqual(['queued', 'processing', 'processing', 'completed', 'completed']);
    } finally { await f.close(); }
  });
});
