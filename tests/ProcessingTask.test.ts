import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessingTaskService } from '../src/main/services/ProcessingTaskService';
import { ProcessingRuntime } from '../src/main/services/ProcessingRuntime';
import { ConfigService } from '../src/main/services/ConfigService';
import { fileIdentityAsync } from '../src/main/services/MediaTools';
import { PlanRecord } from '../src/shared/types';
import { ProcessingRequest } from '../src/shared/processingTask';
import { PlanManager } from '../src/main/services/PlanManager';
import * as MediaTools from '../src/main/services/MediaTools';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const root = path.resolve('../videoCutTool_tmp/20261117-cli/unit'); await fs.promises.mkdir(root, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(root, 'service-'));
  const runtime = new ProcessingRuntime({ config: new ConfigService(directory), registryDirectory: path.join(directory, 'registry'), startupPolicy: 'new-only' });
  await runtime.plans.ready;
  const source = path.join(directory, 'source.mp4'); await fs.promises.writeFile(source, 'fixture');
  const identity = await fileIdentityAsync(source), output = path.join(directory, 'exact.mp4');
  vi.spyOn(runtime.indexes.prober, 'probe').mockResolvedValue({ sourceIdentity: identity, durationMs: 10000, keyframes: [0, 2000, 4000, 6000, 8000], streams: [] } as any);
  const execute = vi.fn().mockResolvedValue({ success: true, outputPath: output, outputPaths: [output], resolvedEncoder: 'cpu' });
  vi.spyOn(runtime.engine as any, 'executionSnapshot').mockReturnValue({ executeSnapshot: execute });
  const service = new ProcessingTaskService(runtime);
  const record: PlanRecord = { id: 'placeholder', title: 'CLI', sourcePath: source, sourceIdentity: identity, requestedOutputPath: output, outputPath: '', outputMode: 'single', outputGroups: {}, cuts: [], cutsCount: 0, decisions: { seg_0: 'keep' }, totalDurationMs: 10000, keptDurationMs: 10000, status: 'ready', completedAt: null, updatedAt: new Date().toISOString() };
  vi.spyOn(service as any, 'prepare').mockImplementation(async () => ({ ...record, id: (service as any).currentId }));
  const request: ProcessingRequest = { operation: 'cut', inputPath: source, outputPath: output, stripCover: true, ranges: [{ startMs: 0, endMs: 10000 }] };
  return { runtime, service, request, execute, output, record };
}
describe('公共任务完成与存储故障边界', () => {
  it('完成通知早于提交返回仍能完成；返回快照是副本', async () => {
    const x = await fixture();
    try {
      const result = await x.service.submit(x.request); expect(result).toMatchObject({ ok: true, outputPaths: [x.output] });
      const snapshot = x.runtime.engine.getExecutionSnapshot(result.taskId!); snapshot.outputPaths.length = 0;
      expect(x.runtime.engine.getExecutionSnapshot(result.taskId!).outputPaths).toEqual([x.output]);
      x.service.cancel(); expect(x.runtime.engine.getExecutionSnapshot(result.taskId!).completedPersisted).toBe(true);
      expect(x.execute.mock.calls[0][0].plan.requestedOutputPath).toBe(x.output);
    } finally { await x.runtime.close(); }
  });
  it.each(['submit', 'start', 'final'])('%s 保存故障立即结束、不重做，发布后保留路径', async stage => {
    const x = await fixture();
    const persist = (x.runtime.plans as any).persist.bind(x.runtime.plans);
    x.runtime.engine.setPlanSaver(async record => {
      if ((stage === 'submit' && record.status === 'queued') || (stage === 'start' && record.status === 'processing') || (stage === 'final' && record.status === 'completed')) throw new Error('注入磁盘故障');
      return persist(record);
    });
    try {
      const result = await x.service.submit(x.request);
      expect(result).toMatchObject({ ok: false, error: { code: 'STORAGE_FAILED' }, outputPaths: stage === 'final' ? [x.output] : [] });
      expect(x.execute).toHaveBeenCalledTimes(stage === 'final' ? 1 : 0);
      if (stage === 'final') expect(x.runtime.engine.getExecutionSnapshot(result.taskId!).pendingFinal?.status).toBe('completed');
    } finally { await x.runtime.close(); }
  });
  it('取消期间保存失败不返回 130，也不无限等待', async () => {
    const x = await fixture();
    x.execute.mockImplementation(async (_data, signal: AbortSignal) => { x.service.cancel(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { success: false, outputPaths: [], error: '取消' }; });
    const persist = (x.runtime.plans as any).persist.bind(x.runtime.plans);
    x.runtime.engine.setPlanSaver(async record => { if (record.status === 'ready') throw new Error('取消保存故障'); return persist(record); });
    try { expect(await x.service.submit(x.request)).toMatchObject({ ok: false, status: 'failed', error: { code: 'STORAGE_FAILED' } }); }
    finally { await x.runtime.close(); }
  });
  it('压缩准备信息保存失败不派发编码，不等待桌面重试', async () => {
    const x = await fixture();
    vi.spyOn(MediaTools, 'probeFile').mockResolvedValue({ durationMs: 10000, streams: [] } as any);
    vi.mocked((x.service as any).prepare).mockImplementation(async () => ({ id: (x.service as any).currentId, title: 'CLI', sourcePath: x.record.sourcePath, requestedOutputPath: x.output, compressionOnly: true, compress: { enabled: true, preset: 'balanced' }, outputDirectory: path.dirname(x.output), outputPath: null, totalDurationMs: null, keptDurationMs: null, cutsCount: 0, cuts: [], decisions: { seg_0: 'keep' }, status: 'ready', updatedAt: new Date().toISOString(), completedAt: null }));
    const persist = (x.runtime.plans as any).persist.bind(x.runtime.plans);
    x.runtime.engine.setPlanSaver(async record => { if (record.status === 'processing' && record.totalDurationMs !== null) throw new Error('压缩准备信息保存故障'); return persist(record); });
    try { expect(await x.service.submit({ ...x.request, operation: 'compress' })).toMatchObject({ ok: false, error: { code: 'STORAGE_FAILED' }, outputPaths: [] }); expect(x.execute).not.toHaveBeenCalled(); }
    finally { await x.runtime.close(); }
  });
  it('CLI 不恢复历史排队任务，也不把它混入队列快照', async () => {
    const x = await fixture();
    try {
      const historic = { ...x.record, id: 'historic', status: 'queued' as const };
      await (x.runtime.plans as any).persist(historic);
      await x.runtime.plans.saveQueueState({ queuePaused: false, priorityPlanId: 'historic', queuedIds: ['historic'] });
      const manager = new PlanManager(x.runtime.config.getDataDirectory(), x.runtime.engine, x.runtime.indexes.prober, 'new-only');
      await manager.ready;
      expect(x.runtime.engine.getState().queuedIds).toEqual([]); expect(x.execute).not.toHaveBeenCalled();
      expect((await manager.getPlan('historic'))?.status).toBe('queued');
    } finally { await x.runtime.close(); }
  });
  it('发布完成但持久化前取消，保留完整产物并返回取消结果', async () => {
    const x = await fixture();
    x.execute.mockImplementation(async () => { x.service.cancel(); return { success: true, outputPath: x.output, outputPaths: [x.output] }; });
    try { expect(await x.service.submit(x.request)).toMatchObject({ ok: false, status: 'cancelled', outputPaths: [x.output] }); }
    finally { await x.runtime.close(); }
  });
  it('目标侧根正被其他进程使用，返回目录占用而非通用执行失败', async () => {
    const x = await fixture(); x.execute.mockRejectedValue(new Error('导出目录正由其他进程使用或无法确认归属'));
    try { expect(await x.service.submit(x.request)).toMatchObject({ ok: false, error: { code: 'DIRECTORY_BUSY' } }); }
    finally { await x.runtime.close(); }
  });
});
