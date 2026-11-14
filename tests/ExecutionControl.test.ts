import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheMaintenanceService } from '../src/main/services/CacheMaintenanceService';
import { MediaCuttingEngine } from '../src/main/services/MediaCuttingEngine';
import { PlanManager } from '../src/main/services/PlanManager';
import { RetentionDraft } from '../src/shared/RetentionDraft';
import { fileIdentityAsync } from '../src/main/services/MediaTools';
import type { KeyframeProber } from '../src/main/services/KeyframeProber';
import type { PlanRecord } from '../src/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function createFixture() {
  const base = path.resolve('../videoCutTool_tmp/execution-control-tests');
  await fs.promises.mkdir(base, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(base, 'case-'));
  const slices = path.join(directory, 'slices');
  const registry = path.join(directory, 'registry');
  const plansDir = path.join(directory, 'plans');
  await fs.promises.mkdir(plansDir, { recursive: true });

  const maintenance = new CacheMaintenanceService(registry);
  const engine = new MediaCuttingEngine(undefined, slices, undefined, undefined, maintenance);

  const source = path.join(directory, 'source.mp4');
  await fs.promises.writeFile(source, '视频源测试内容');
  const identity = await fileIdentityAsync(source);

  const indexes = {
    ready: Promise.resolve(),
    find: vi.fn().mockResolvedValue(null),
    issues: [],
  };
  const prober = {
    store: indexes,
    input: async () => ({ url: source, close: async () => {} }),
    probe: async () => ({
      durationMs: 10000,
      keyframes: [0, 2000, 4000, 6000, 8000, 10000],
      sourceIdentity: identity,
      width: 640,
      height: 360,
      fps: 25,
      streams: [{ index: 0, type: 'video', codec: 'h264', attachedPicture: false, default: true }],
    }),
  } as unknown as KeyframeProber;

  const planManager = new PlanManager(directory, engine, prober);
  await planManager.ready;

  const makeRecord = (id: string, title: string): PlanRecord => {
    const draft = new RetentionDraft(source, 10000);
    draft.addCut(2000);
    draft.addCut(6000);
    return {
      ...draft.toRecord({ id, title, outputPath: path.join(directory, `${id}.mp4`) }),
      sourceIdentity: identity,
      status: 'ready',
    };
  };

  return {
    directory,
    slices,
    registry,
    plansDir,
    maintenance,
    engine,
    prober,
    planManager,
    source,
    identity,
    makeRecord,
    cleanup: async () => {
      await engine.shutdown();
      await maintenance.close();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('任务执行停止、队列暂停与手动优先调度 (ExecutionControl)', () => {
  it('1. 排队任务可直接移出队列并重置为 ready，更新 queue_state.json', async () => {
    const ctx = await createFixture();
    try {
      const planA = ctx.makeRecord('plan-a', '任务 A');
      const planB = ctx.makeRecord('plan-b', '任务 B');
      await ctx.planManager.savePlan(planA);
      await ctx.planManager.savePlan(planB);

      // 暂停队列以确保提交后任务处于排队状态 (queued)
      await ctx.planManager.pauseQueue();
      await ctx.planManager.executePlan(planA.id);
      await ctx.planManager.executePlan(planB.id);

      expect((await ctx.planManager.getPlan(planA.id))?.status).toBe('queued');
      expect((await ctx.planManager.getPlan(planB.id))?.status).toBe('queued');

      // 将 planA 移出队列
      const result = await ctx.planManager.cancelPlan(planA.id);
      expect(result.success).toBe(true);

      const updatedA = await ctx.planManager.getPlan(planA.id);
      expect(updatedA?.status).toBe('ready');

      // 检查持久化状态中 planA 已被移除，仅剩 planB
      const queueStateRaw = await fs.promises.readFile(path.join(ctx.directory, 'queue_state.json'), 'utf8');
      const queueState = JSON.parse(queueStateRaw);
      expect(queueState.queuedIds).toEqual([planB.id]);
    } finally {
      await ctx.cleanup();
    }
  });

  it('2. 正在处理任务中断停止，临时切片物理删除（核验 ENOENT）并恢复为 ready', async () => {
    const ctx = await createFixture();
    try {
      const planA = ctx.makeRecord('plan-active', '正在执行的任务');
      await ctx.planManager.savePlan(planA);

      const taskDirCreated = deferred<string>();
      const runDeferred = deferred<void>();

      // 拦截 executionSnapshot 模拟底层执行挂起并创建临时目录
      vi.spyOn(ctx.engine as any, 'executionSnapshot').mockImplementation((_tracker: any, onTaskDir?: any) => {
        return {
          ffprobePath: 'ffprobe',
          executeSnapshot: async (_data: any, signal?: AbortSignal) => {
            const managedRoot = path.join(ctx.slices, 'managed');
            const taskDir = await ctx.maintenance.create(managedRoot, 'task', '');
            const tempSlice = path.join(taskDir, 'slice_0.mp4');
            await ctx.maintenance.allowTaskFile(taskDir, tempSlice);
            await fs.promises.writeFile(tempSlice, '临时分片二进制数据');
            onTaskDir?.(taskDir);
            taskDirCreated.resolve(taskDir);

            if (signal) {
              signal.addEventListener('abort', () => runDeferred.resolve());
            }
            await runDeferred.promise;
            return { success: false, error: 'canceled' };
          },
        };
      });

      // 提交并启动执行
      void ctx.planManager.executePlan(planA.id);
      const allocatedDir = await taskDirCreated.promise;
      expect(fs.existsSync(allocatedDir)).toBe(true);
      expect(ctx.engine.getActivePlanId()).toBe(planA.id);

      // 执行主动中断停止
      const cancelResult = await ctx.planManager.cancelPlan(planA.id);
      expect(cancelResult.success).toBe(true);

      // 验证临时目录确实返回 ENOENT（已物理删除）
      let exists = true;
      try {
        await fs.promises.stat(allocatedDir);
      } catch (err: any) {
        if (err.code === 'ENOENT') exists = false;
      }
      expect(exists).toBe(false);

      // 验证方案状态重置为 ready，而不是 failed 或 cancelled
      const record = await ctx.planManager.getPlan(planA.id);
      expect(record?.status).toBe('ready');
      expect(ctx.engine.getActivePlanId()).toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  it('3. 全局队列暂停与恢复：暂停时不派发新任务，恢复后顺序自动派发', async () => {
    const ctx = await createFixture();
    try {
      const planA = ctx.makeRecord('plan-1', '任务 1');
      const planB = ctx.makeRecord('plan-2', '任务 2');
      await ctx.planManager.savePlan(planA);
      await ctx.planManager.savePlan(planB);

      const plan1Done = deferred<void>();
      const plan2Started = deferred<void>();

      vi.spyOn(ctx.engine as any, 'executionSnapshot').mockImplementation(() => {
        return {
          ffprobePath: 'ffprobe',
          executeSnapshot: async (data: any) => {
            if (data.plan.title === '任务 1') {
              await plan1Done.promise;
              return { success: true, outputPath: path.join(ctx.directory, 'out1.mp4') };
            }
            if (data.plan.title === '任务 2') {
              plan2Started.resolve();
              return { success: true, outputPath: path.join(ctx.directory, 'out2.mp4') };
            }
            return { success: true };
          },
        };
      });

      // 1. 先提交 planA 开始执行
      void ctx.planManager.executePlan(planA.id);
      for (let i = 0; i < 50; i++) {
        if (ctx.engine.getActivePlanId() === planA.id) break;
        await new Promise(r => setTimeout(r, 20));
      }
      expect(ctx.engine.getActivePlanId()).toBe(planA.id);

      // 2. 暂停队列
      await ctx.planManager.pauseQueue();
      expect(ctx.engine.getState().queuePaused).toBe(true);

      // 3. 提交 planB 进入排队
      await ctx.planManager.executePlan(planB.id);
      expect((await ctx.planManager.getPlan(planB.id))?.status).toBe('queued');

      // 4. 让 planA 完成
      plan1Done.resolve();
      await new Promise(r => setTimeout(r, 100));

      // 5. 验证处于暂停状态，planB 绝不会自动启动
      expect(ctx.engine.getActivePlanId()).toBeNull();
      expect((await ctx.planManager.getPlan(planB.id))?.status).toBe('queued');

      // 6. 恢复队列
      await ctx.planManager.resumeQueue();
      // 等待 planB 被自动派发
      await plan2Started.promise;
      expect(ctx.engine.getActivePlanId()).toBe(planB.id);
    } finally {
      await ctx.cleanup();
    }
  });

  it('4. 暂停期间手动优先执行（单独启动）：执行完成后依然保持暂停', async () => {
    const ctx = await createFixture();
    try {
      const planA = ctx.makeRecord('plan-p1', '普通排队 1');
      const planB = ctx.makeRecord('plan-p2', '普通排队 2');
      await ctx.planManager.savePlan(planA);
      await ctx.planManager.savePlan(planB);

      await ctx.planManager.pauseQueue();
      await ctx.planManager.executePlan(planA.id);
      await ctx.planManager.executePlan(planB.id);

      const planBStarted = deferred<void>();
      const planBDone = deferred<void>();

      vi.spyOn(ctx.engine as any, 'executionSnapshot').mockImplementation(() => {
        return {
          ffprobePath: 'ffprobe',
          executeSnapshot: async (data: any) => {
            if (data.plan.title === '普通排队 2') {
              planBStarted.resolve();
              await planBDone.promise;
              return { success: true, outputPath: path.join(ctx.directory, 'out-p2.mp4') };
            }
            return { success: true };
          },
        };
      });

      // 在暂停状态下单独启动 planB（设置优先）
      const priorityResult = await ctx.planManager.setPriorityPlan(planB.id);
      expect(priorityResult.success).toBe(true);

      // planB 应该立即被派发执行（即便当前处于暂停）
      await planBStarted.promise;
      expect(ctx.engine.getActivePlanId()).toBe(planB.id);

      // planB 执行完成
      planBDone.resolve();
      await new Promise(r => setTimeout(r, 100));

      // 验证：planB 完成后，队列依然保持暂停，planA 依然留在队列中未被派发
      expect(ctx.engine.getState().queuePaused).toBe(true);
      expect(ctx.engine.getActivePlanId()).toBeNull();
      expect((await ctx.planManager.getPlan(planA.id))?.status).toBe('queued');
    } finally {
      await ctx.cleanup();
    }
  });

  it('5. 多次指定不同优先任务：指针标记法不破坏原普通队列物理顺序', async () => {
    const ctx = await createFixture();
    try {
      const p1 = ctx.makeRecord('p1', '任务 1');
      const p2 = ctx.makeRecord('p2', '任务 2');
      const p3 = ctx.makeRecord('p3', '任务 3');
      await ctx.planManager.savePlan(p1);
      await ctx.planManager.savePlan(p2);
      await ctx.planManager.savePlan(p3);

      await ctx.planManager.pauseQueue();
      // 设置 busy 状态模拟当前有任务在执行中
      (ctx.engine as any).active = { record: { id: 'busy-task' } };

      await ctx.planManager.executePlan(p1.id);
      await ctx.planManager.executePlan(p2.id);
      await ctx.planManager.executePlan(p3.id);

      // 原普通队列顺序为 [p1, p2, p3]
      expect(ctx.engine.getState().queuedIds).toEqual(['p1', 'p2', 'p3']);

      // 第一次指定优先：p2
      await ctx.planManager.setPriorityPlan(p2.id);
      expect(ctx.engine.getPriorityPlanId()).toBe(p2.id);
      expect(ctx.engine.getState().queuedIds).toEqual(['p1', 'p2', 'p3']);

      // 第二次指定优先：p3
      await ctx.planManager.setPriorityPlan(p3.id);
      expect(ctx.engine.getPriorityPlanId()).toBe(p3.id);
      // p1, p2, p3 的相对物理顺序完全未变，未发生位移或重复
      expect(ctx.engine.getState().queuedIds).toEqual(['p1', 'p2', 'p3']);
    } finally {
      (ctx.engine as any).active = null;
      await ctx.cleanup();
    }
  });

  it('6. 取消排队中的优先任务：优先指针安全置空且队列保持暂停', async () => {
    const ctx = await createFixture();
    try {
      const p1 = ctx.makeRecord('p-pri', '优先任务');
      await ctx.planManager.savePlan(p1);

      await ctx.planManager.pauseQueue();
      // 模拟繁忙执行中
      (ctx.engine as any).active = { record: { id: 'busy-task' } };
      await ctx.planManager.executePlan(p1.id);
      await ctx.planManager.setPriorityPlan(p1.id);

      expect(ctx.engine.getPriorityPlanId()).toBe(p1.id);

      // 取消该优先任务
      const cancelResult = await ctx.planManager.cancelPlan(p1.id);
      expect(cancelResult.success).toBe(true);

      // 验证优先指针已清空，且队列依然保持暂停
      expect(ctx.engine.getPriorityPlanId()).toBeNull();
      expect(ctx.engine.getState().queuePaused).toBe(true);
      expect((await ctx.planManager.getPlan(p1.id))?.status).toBe('ready');
    } finally {
      (ctx.engine as any).active = null;
      await ctx.cleanup();
    }
  });

  it('7. 全局全部停止排它屏障：真实 cancelAll 测试，中止活动任务，清空排队与优先，更新快照', async () => {
    const ctx = await createFixture();
    try {
      const pActive = ctx.makeRecord('p-active', '运行中任务');
      const pQueued = ctx.makeRecord('p-queued', '排队中任务');
      await ctx.planManager.savePlan(pActive);
      await ctx.planManager.savePlan(pQueued);

      const runDeferred = deferred<void>();
      const taskDirCreated = deferred<string>();

      vi.spyOn(ctx.engine as any, 'executionSnapshot').mockImplementation((_tracker: any, onTaskDir?: any) => {
        return {
          ffprobePath: 'ffprobe',
          executeSnapshot: async (_data: any, signal?: AbortSignal) => {
            const managedRoot = path.join(ctx.slices, 'managed');
            const taskDir = await ctx.maintenance.create(managedRoot, 'task', '');
            onTaskDir?.(taskDir);
            taskDirCreated.resolve(taskDir);
            if (signal) {
              signal.addEventListener('abort', () => runDeferred.resolve());
            }
            await runDeferred.promise;
            return { success: false, error: 'canceled' };
          },
        };
      });

      // 启动 pActive 执行
      void ctx.planManager.executePlan(pActive.id);
      await taskDirCreated.promise;
      expect(ctx.engine.getActivePlanId()).toBe(pActive.id);

      // 提交 pQueued 进入排队
      await ctx.planManager.executePlan(pQueued.id);
      expect((await ctx.planManager.getPlan(pQueued.id))?.status).toBe('queued');

      // 调用真实的 cancelAllPlans()（严格不 Mock）
      const cancelAllResult = await ctx.planManager.cancelAllPlans();
      expect(cancelAllResult.success).toBe(true);
      expect(cancelAllResult.activeCancelled).toBe(true);
      expect(cancelAllResult.dequeuedCount).toBe(1);

      // 验证内存状态清空
      expect(ctx.engine.getActivePlanId()).toBeNull();
      expect(ctx.engine.getState().queuedIds).toEqual([]);
      expect(ctx.engine.getPriorityPlanId()).toBeNull();

      // 验证持久化状态全部恢复为 ready
      expect((await ctx.planManager.getPlan(pActive.id))?.status).toBe('ready');
      expect((await ctx.planManager.getPlan(pQueued.id))?.status).toBe('ready');

      // 验证快照文件清空
      const queueStateRaw = await fs.promises.readFile(path.join(ctx.directory, 'queue_state.json'), 'utf8');
      const queueState = JSON.parse(queueStateRaw);
      expect(queueState.queuedIds).toEqual([]);
      expect(queueState.priorityPlanId).toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  it('8. 应用重启与持久化恢复：原 queued 保持 queued，原 processing 恢复为 failed，暂停与优先准确还原', async () => {
    const ctx = await createFixture();
    try {
      const pQueued = ctx.makeRecord('p-q', '排队任务');
      const pProc = ctx.makeRecord('p-proc', '崩溃前处理中的任务');
      await ctx.planManager.savePlan(pQueued);
      await ctx.planManager.savePlan(pProc);

      // 人工构造崩溃前的磁盘数据：p-q 为 queued，p-proc 为 processing
      await fs.promises.writeFile(
        path.join(ctx.plansDir, `${pQueued.id}.json`),
        JSON.stringify({ ...pQueued, status: 'queued' })
      );
      await fs.promises.writeFile(
        path.join(ctx.plansDir, `${pProc.id}.json`),
        JSON.stringify({ ...pProc, status: 'processing' })
      );

      // 人工构造 queue_state.json
      const persistedState = {
        version: 1,
        queuePaused: true,
        queuedIds: [pQueued.id],
        priorityPlanId: pQueued.id,
      };
      await fs.promises.writeFile(
        path.join(ctx.directory, 'queue_state.json'),
        JSON.stringify(persistedState)
      );

      // 模拟应用重启：创建新的 PlanManager 实例
      const restartedEngine = new MediaCuttingEngine(undefined, ctx.slices, undefined, undefined, ctx.maintenance);
      const restartedManager = new PlanManager(ctx.directory, restartedEngine, ctx.prober);
      await restartedManager.ready;

      // 验证：原 queued 保持 queued；原 processing 改为 failed
      expect((await restartedManager.getPlan(pQueued.id))?.status).toBe('queued');
      expect((await restartedManager.getPlan(pProc.id))?.status).toBe('failed');

      // 验证：恢复暂停标志与优先任务
      const engineState = restartedEngine.getState();
      expect(engineState.queuePaused).toBe(true);
      expect(engineState.priorityPlanId).toBe(pQueued.id);
      expect(engineState.queuedIds).toEqual([pQueued.id]);

      await restartedEngine.shutdown();
    } finally {
      await ctx.cleanup();
    }
  });

  it('9. 素材准备/探测阶段触发停止：等待探测退出，方案安全恢复为 ready', async () => {
    const ctx = await createFixture();
    try {
      const planA = ctx.makeRecord('plan-probe-stop', '探测阶段停止任务');
      await ctx.planManager.savePlan(planA);

      const probeStarted = deferred<void>();
      const probeAbortDeferred = deferred<void>();

      // 拦截 prober.probe 模拟耗时探测并在 abort 时退出
      (ctx.prober as any).probe = vi.fn().mockImplementation(async (_source: string, signal?: AbortSignal) => {
        probeStarted.resolve();
        if (signal) {
          signal.addEventListener('abort', () => probeAbortDeferred.resolve());
        }
        await probeAbortDeferred.promise;
        throw new Error('操作已取消');
      });

      void ctx.planManager.executePlan(planA.id);
      await probeStarted.promise;

      // 验证当前任务已处于 active
      expect(ctx.engine.getActivePlanId()).toBe(planA.id);

      // 触发取消
      const cancelResult = await ctx.planManager.cancelPlan(planA.id);
      expect(cancelResult.success).toBe(true);

      // 验证方案状态恢复为 ready，且未被写成 failed
      expect(ctx.engine.getActivePlanId()).toBeNull();
      const record = await ctx.planManager.getPlan(planA.id);
      expect(record?.status).toBe('ready');
      expect(record?.error).toBeUndefined();
    } finally {
      await ctx.cleanup();
    }
  });

  it('10. FFmpeg 启动与登记竞态时触发停止：子进程安全中止不遗留孤儿', async () => {
    const ctx = await createFixture();
    try {
      const planA = ctx.makeRecord('plan-race', '启动竞态任务');
      await ctx.planManager.savePlan(planA);

      let abortSignaled = false;
      vi.spyOn(ctx.engine as any, 'executionSnapshot').mockImplementation((_tracker: any, onTaskDir?: any) => {
        return {
          ffprobePath: 'ffprobe',
          executeSnapshot: async (_data: any, signal?: AbortSignal) => {
            const managedRoot = path.join(ctx.slices, 'managed');
            const taskDir = await ctx.maintenance.create(managedRoot, 'task', '');
            onTaskDir?.(taskDir);
            if (signal?.aborted) {
              abortSignaled = true;
              throw new Error('操作已取消');
            }
            signal?.addEventListener('abort', () => {
              abortSignaled = true;
            });
            await new Promise(r => setTimeout(r, 20));
            throw new Error('操作已取消');
          },
        };
      });

      const execPromise = ctx.planManager.executePlan(planA.id);
      // 等待任务进入 active 执行状态
      for (let i = 0; i < 50; i++) {
        if (ctx.engine.getActivePlanId() === planA.id) break;
        await new Promise(r => setTimeout(r, 10));
      }
      const cancelResult = await ctx.planManager.cancelPlan(planA.id);
      await execPromise.catch(() => {});

      expect(abortSignaled).toBe(true);
      expect(cancelResult.success).toBe(true);
      expect(ctx.engine.getActivePlanId()).toBeNull();
      expect((await ctx.planManager.getPlan(planA.id))?.status).toBe('ready');
    } finally {
      await ctx.cleanup();
    }
  });

  it('11. FFmpeg 尚未退出时禁止提前清理：严格等待执行链落地后才清理', async () => {
    const ctx = await createFixture();
    try {
      const planA = ctx.makeRecord('plan-wait-exit', '延迟退出任务');
      await ctx.planManager.savePlan(planA);

      let processExited = false;
      let sweepCalledBeforeExit = false;

      const taskDirCreated = deferred<string>();
      const runDeferred = deferred<void>();

      vi.spyOn(ctx.engine as any, 'executionSnapshot').mockImplementation((_tracker: any, onTaskDir?: any) => {
        return {
          ffprobePath: 'ffprobe',
          executeSnapshot: async (_data: any, signal?: AbortSignal) => {
            const managedRoot = path.join(ctx.slices, 'managed');
            const taskDir = await ctx.maintenance.create(managedRoot, 'task', '');
            onTaskDir?.(taskDir);
            taskDirCreated.resolve(taskDir);

            if (signal) {
              signal.addEventListener('abort', async () => {
                // 模拟子进程退出耗时 60ms
                await new Promise(r => setTimeout(r, 60));
                processExited = true;
                runDeferred.resolve();
              });
            }
            await runDeferred.promise;
            return { success: false, error: 'canceled' };
          },
        };
      });

      // 监听 maintenance.abandonAndSweep 调用时子进程是否已退出
      const originalSweep = ctx.maintenance.abandonAndSweep.bind(ctx.maintenance);
      vi.spyOn(ctx.maintenance, 'abandonAndSweep').mockImplementation(async (dir: string) => {
        if (!processExited) {
          sweepCalledBeforeExit = true;
        }
        return originalSweep(dir);
      });

      void ctx.planManager.executePlan(planA.id);
      await taskDirCreated.promise;

      const cancelResult = await ctx.planManager.cancelPlan(planA.id);
      expect(cancelResult.success).toBe(true);
      expect(sweepCalledBeforeExit).toBe(false);
      expect(processExited).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  it('12. 临时资产物理清理失败时不得报告停止成功，保留资产登记与错误状态', async () => {
    const ctx = await createFixture();
    try {
      const planA = ctx.makeRecord('plan-clean-fail', '清理失败任务');
      await ctx.planManager.savePlan(planA);

      const taskDirCreated = deferred<string>();
      const runDeferred = deferred<void>();

      vi.spyOn(ctx.engine as any, 'executionSnapshot').mockImplementation((_tracker: any, onTaskDir?: any) => {
        return {
          ffprobePath: 'ffprobe',
          executeSnapshot: async (_data: any, signal?: AbortSignal) => {
            const managedRoot = path.join(ctx.slices, 'managed');
            const taskDir = await ctx.maintenance.create(managedRoot, 'task', '');
            onTaskDir?.(taskDir);
            taskDirCreated.resolve(taskDir);

            if (signal) {
              signal.addEventListener('abort', () => runDeferred.resolve());
            }
            await runDeferred.promise;
            return { success: false, error: 'canceled' };
          },
        };
      });

      // 模拟物理清理失败（例如 Windows 文件占用导致无法删除）
      vi.spyOn(ctx.maintenance, 'abandonAndSweep').mockResolvedValue(false);

      void ctx.planManager.executePlan(planA.id);
      await taskDirCreated.promise;

      const cancelResult = await ctx.planManager.cancelPlan(planA.id);
      // 必须报告失败！
      expect(cancelResult.success).toBe(false);
      expect(cancelResult.message).toContain('临时资产目录物理清理失败');

      // 验证方案状态没有被错误恢复为 ready，而是记录为 failed 并附带清理失败错误
      const record = await ctx.planManager.getPlan(planA.id);
      expect(record?.status).toBe('failed');
      expect(record?.error).toContain('临时文件清理未完成');

      expect(ctx.engine.getActivePlanId()).toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  it('13. 全部停止时某个排队任务持久化失败：返回部分成功结果且不丢弃失败任务', async () => {
    const ctx = await createFixture();
    try {
      const p1 = ctx.makeRecord('plan-s1', '排队任务 1');
      const p2 = ctx.makeRecord('plan-s2', '排队任务 2');
      const p3 = ctx.makeRecord('plan-s3', '排队任务 3');
      await ctx.planManager.savePlan(p1);
      await ctx.planManager.savePlan(p2);
      await ctx.planManager.savePlan(p3);

      await ctx.planManager.pauseQueue();
      await ctx.planManager.executePlan(p1.id);
      await ctx.planManager.executePlan(p2.id);
      await ctx.planManager.executePlan(p3.id);

      // 模拟 p2 持久化为 ready 时磁盘报错
      const originalSave = (ctx.planManager as any).store.save.bind((ctx.planManager as any).store);
      vi.spyOn((ctx.planManager as any).store, 'save').mockImplementation(async (record: any) => {
        if (record.id === p2.id && record.status === 'ready') {
          throw new Error('EIO: 磁盘写入失败');
        }
        return originalSave(record);
      });

      // 调用真实的 cancelAllPlans()
      const result = await ctx.planManager.cancelAllPlans();
      // 返回部分成功语义
      expect(result.success).toBe(false);
      expect(result.dequeuedCount).toBe(2); // p1 和 p3 成功移出
      expect(result.failedPlanIds).toContain(p2.id);

      // 验证 p2 依然保留在引擎队列与 accepted 中，没有丢弃
      expect(ctx.engine.getState().queuedIds).toContain(p2.id);
      expect(ctx.engine.isAccepted(p2.id)).toBe(true);

      // p1 和 p3 成功恢复为 ready
      expect((await ctx.planManager.getPlan(p1.id))?.status).toBe('ready');
      expect((await ctx.planManager.getPlan(p3.id))?.status).toBe('ready');
    } finally {
      await ctx.cleanup();
    }
  });

  it('14. 调度快照写入失败时异常冒泡传递且内存状态回滚', async () => {
    const ctx = await createFixture();
    try {
      const p1 = ctx.makeRecord('plan-snap-fail', '快照写入测试任务');
      await ctx.planManager.savePlan(p1);

      // 模拟 saveQueueState 写入失败
      vi.spyOn(ctx.planManager, 'saveQueueState').mockRejectedValue(new Error('磁盘只读，快照无法写入'));

      // 1. 测试 pauseQueue 持久化失败向外抛错且回滚
      await expect(ctx.planManager.pauseQueue()).rejects.toThrow('磁盘只读，快照无法写入');
      expect(ctx.engine.getState().queuePaused).toBe(false);

      // 手动置为 pause 测试 setPriorityPlan 失败
      (ctx.engine as any).queuePaused = true;
      (ctx.engine as any).queue = [{ record: p1, prober: ctx.prober }];

      // 2. 测试 setPriorityPlan 持久化失败
      const priorityResult = await ctx.planManager.setPriorityPlan(p1.id);
      expect(priorityResult.success).toBe(false);
      expect(priorityResult.message).toContain('调度状态持久化失败');
      expect(ctx.engine.getPriorityPlanId()).toBeNull();

      // 3. 测试 resumeQueue 持久化失败向外抛错且回滚
      await expect(ctx.planManager.resumeQueue()).rejects.toThrow('磁盘只读，快照无法写入');
      expect(ctx.engine.getState().queuePaused).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  it('15. 排队任务移出失败后事务回滚：恢复原队列位置、accepted 记录和 priorityPlanId', async () => {
    const ctx = await createFixture();
    try {
      const p1 = ctx.makeRecord('p-roll-1', '任务 1');
      const p2 = ctx.makeRecord('p-roll-2', '任务 2');
      const p3 = ctx.makeRecord('p-roll-3', '任务 3');
      await ctx.planManager.savePlan(p1);
      await ctx.planManager.savePlan(p2);
      await ctx.planManager.savePlan(p3);

      await ctx.planManager.pauseQueue();
      // 模拟繁忙防止立即派发优先任务，使 p2 稳定停留在排队队列中作为优先任务
      (ctx.engine as any).active = { record: { id: 'busy-task' } };
      await ctx.planManager.executePlan(p1.id);
      await ctx.planManager.executePlan(p2.id);
      await ctx.planManager.executePlan(p3.id);

      // 将 p2 设为优先任务
      await ctx.planManager.setPriorityPlan(p2.id);
      expect(ctx.engine.getPriorityPlanId()).toBe(p2.id);
      expect(ctx.engine.getState().queuedIds).toEqual([p1.id, p2.id, p3.id]);

      // 拦截 store.save 模拟 p2 移出持久化失败
      const originalSave = (ctx.planManager as any).store.save.bind((ctx.planManager as any).store);
      vi.spyOn((ctx.planManager as any).store, 'save').mockImplementation(async (record: any) => {
        if (record.id === p2.id && record.status === 'ready') {
          throw new Error('EIO 模拟持久化失败');
        }
        return originalSave(record);
      });

      const cancelRes = await ctx.planManager.cancelPlan(p2.id);
      expect(cancelRes.success).toBe(false);
      expect(cancelRes.message).toContain('移出队列失败');

      // 验证事务回滚：p2 回到原索引 1，队列顺序保持 [p1, p2, p3]
      expect(ctx.engine.getState().queuedIds).toEqual([p1.id, p2.id, p3.id]);
      // 验证 accepted 恢复
      expect(ctx.engine.isAccepted(p2.id)).toBe(true);
      // 验证 priorityPlanId 恢复
      expect(ctx.engine.getPriorityPlanId()).toBe(p2.id);
    } finally {
      (ctx.engine as any).active = null;
      await ctx.cleanup();
    }
  });

  it('16. pendingFinal 脱离 active 后触发全部停止：保护成片与待保存结果，保留 retryPendingWrites', async () => {
    const ctx = await createFixture();
    try {
      const p1 = ctx.makeRecord('p-final', '成片已生成的任务');
      const p2 = ctx.makeRecord('p-wait', '等待中的排队任务');
      await ctx.planManager.savePlan(p1);
      await ctx.planManager.savePlan(p2);

      await ctx.planManager.pauseQueue();
      await ctx.planManager.executePlan(p1.id);
      await ctx.planManager.executePlan(p2.id);

      // 构造 pendingFinal 脱离 active 的状态（active 为 null，但 pendingFinal 存活）
      const completedRecord: PlanRecord = {
        ...p1,
        status: 'completed',
        outputPath: path.join(ctx.directory, 'final.mp4'),
        completedAt: new Date().toISOString(),
      };
      (ctx.engine as any).active = null;
      (ctx.engine as any).pendingFinal = completedRecord;
      (ctx.engine as any).storageError = '模拟磁盘临时保存阻塞';

      // 此时触发真实 cancelAllPlans
      const cancelAllResult = await ctx.planManager.cancelAllPlans();
      expect(cancelAllResult.pendingFinalPreserved).toBe(true);
      expect(cancelAllResult.message).toContain('待保存结果未破坏');

      // 验证成片和 pendingFinal 记录未被破坏或重置为 ready
      expect((ctx.engine as any).pendingFinal).toBe(completedRecord);

      // 验证排队任务 p2 被成功清空重置为 ready
      expect((await ctx.planManager.getPlan(p2.id))?.status).toBe('ready');

      // 验证 retryPendingWrites() 机制完好，重试后正常完成落盘
      await ctx.engine.retryPendingWrites();
      expect((ctx.engine as any).pendingFinal).toBeNull();
      expect((await ctx.planManager.getPlan(p1.id))?.status).toBe('completed');
    } finally {
      await ctx.cleanup();
    }
  });

  it('17. 全部停止屏障期间拒绝新任务提交', async () => {
    const ctx = await createFixture();
    try {
      const p1 = ctx.makeRecord('p-barrier-1', '长任务');
      const p2 = ctx.makeRecord('p-barrier-2', '试图在停止期间提交的任务');
      await ctx.planManager.savePlan(p1);
      await ctx.planManager.savePlan(p2);

      const barrierActive = deferred<void>();
      const runDeferred = deferred<void>();

      vi.spyOn(ctx.engine as any, 'executionSnapshot').mockImplementation((_tracker: any, onTaskDir?: any) => {
        return {
          ffprobePath: 'ffprobe',
          executeSnapshot: async (_data: any, signal?: AbortSignal) => {
            const managedRoot = path.join(ctx.slices, 'managed');
            const taskDir = await ctx.maintenance.create(managedRoot, 'task', '');
            onTaskDir?.(taskDir);
            barrierActive.resolve();
            if (signal) {
              signal.addEventListener('abort', async () => {
                // 延迟完成以保持 barrier 处于激活状态
                await new Promise(r => setTimeout(r, 60));
                runDeferred.resolve();
              });
            }
            await runDeferred.promise;
            return { success: false, error: 'canceled' };
          },
        };
      });

      void ctx.planManager.executePlan(p1.id);
      await barrierActive.promise;

      // 启动 cancelAllPlans（异步进行中，drainingBarrier 生效）
      const cancelPromise = ctx.planManager.cancelAllPlans();

      // 在 barrier 生效期间提交新任务
      const submitResult = await ctx.planManager.executePlan(p2.id);
      expect(submitResult.success).toBe(false);
      expect(submitResult.message).toContain('当前正在执行全部停止，未接受新任务');

      // 验证优先设置也被拒绝
      const priorityResult = await ctx.planManager.setPriorityPlan(p2.id);
      expect(priorityResult.success).toBe(false);
      expect(priorityResult.message).toContain('当前正在执行全部停止');

      await cancelPromise;
    } finally {
      await ctx.cleanup();
    }
  });

  it('18. 快照缺失但存在 queued 记录时安全降级为暂停，不意外自动派发', async () => {
    const ctx = await createFixture();
    try {
      const p1 = ctx.makeRecord('p-orphan-1', '遗留排队任务');
      await ctx.planManager.savePlan(p1);

      // 人工写入 queued 状态的方案文件
      await fs.promises.writeFile(
        path.join(ctx.plansDir, `${p1.id}.json`),
        JSON.stringify({ ...p1, status: 'queued' })
      );

      // 确保 queue_state.json 不存在
      const stateFile = path.join(ctx.directory, 'queue_state.json');
      await fs.promises.unlink(stateFile).catch(() => {});

      // 模拟启动重启
      const newEngine = new MediaCuttingEngine(undefined, ctx.slices, undefined, undefined, ctx.maintenance);
      const newManager = new PlanManager(ctx.directory, newEngine, ctx.prober);
      await newManager.ready;

      // 验证：存在排队任务但快照缺失时，安全降级为暂停！
      expect(newEngine.getState().queuePaused).toBe(true);
      expect(newEngine.getActivePlanId()).toBeNull(); // 绝不自动开跑抢占 CPU
      expect(newEngine.getState().queuedIds).toEqual([p1.id]);

      // 验证降级状态已安全落盘
      const savedState = JSON.parse(await fs.promises.readFile(stateFile, 'utf8'));
      expect(savedState.queuePaused).toBe(true);

      await newEngine.shutdown();
    } finally {
      await ctx.cleanup();
    }
  });

  it('19. 快照损坏后安全降级为暂停且不自动派发', async () => {
    const ctx = await createFixture();
    try {
      const p1 = ctx.makeRecord('p-corrupt-1', '排队任务');
      await ctx.planManager.savePlan(p1);

      await fs.promises.writeFile(
        path.join(ctx.plansDir, `${p1.id}.json`),
        JSON.stringify({ ...p1, status: 'queued' })
      );

      // 写入损坏的非法 JSON 到 queue_state.json
      const stateFile = path.join(ctx.directory, 'queue_state.json');
      await fs.promises.writeFile(stateFile, '{ corrupted json content ... !@#$');

      const newEngine = new MediaCuttingEngine(undefined, ctx.slices, undefined, undefined, ctx.maintenance);
      const newManager = new PlanManager(ctx.directory, newEngine, ctx.prober);
      await newManager.ready;

      // 验证：安全降级为暂停，不自动派发
      expect(newEngine.getState().queuePaused).toBe(true);
      expect(newEngine.getActivePlanId()).toBeNull();
      expect((await newManager.getPlan(p1.id))?.status).toBe('queued'); // 方案未被误修改

      await newEngine.shutdown();
    } finally {
      await ctx.cleanup();
    }
  });

  it('20. 连续切换优先任务后普通队列顺序严格保持不变，恢复后优先执行最后指定任务', async () => {
    const ctx = await createFixture();
    try {
      const p1 = ctx.makeRecord('p-sw-1', '队列 1');
      const p2 = ctx.makeRecord('p-sw-2', '队列 2');
      const p3 = ctx.makeRecord('p-sw-3', '队列 3');
      await ctx.planManager.savePlan(p1);
      await ctx.planManager.savePlan(p2);
      await ctx.planManager.savePlan(p3);

      await ctx.planManager.pauseQueue();
      // 模拟繁忙防止立即消费
      (ctx.engine as any).active = { record: { id: 'busy' } };

      await ctx.planManager.executePlan(p1.id);
      await ctx.planManager.executePlan(p2.id);
      await ctx.planManager.executePlan(p3.id);

      expect(ctx.engine.getState().queuedIds).toEqual([p1.id, p2.id, p3.id]);

      // 连续切换：先 p2，后 p3，最后 p1
      await ctx.planManager.setPriorityPlan(p2.id);
      expect(ctx.engine.getState().queuedIds).toEqual([p1.id, p2.id, p3.id]);

      await ctx.planManager.setPriorityPlan(p3.id);
      expect(ctx.engine.getState().queuedIds).toEqual([p1.id, p2.id, p3.id]);

      await ctx.planManager.setPriorityPlan(p1.id);
      expect(ctx.engine.getPriorityPlanId()).toBe(p1.id);
      expect(ctx.engine.getState().queuedIds).toEqual([p1.id, p2.id, p3.id]);

      // 恢复队列：p1 作为优先任务移到最前，其余保持相对顺序
      await ctx.planManager.resumeQueue();
      expect(ctx.engine.getState().queuedIds).toEqual([p1.id, p2.id, p3.id]);
    } finally {
      (ctx.engine as any).active = null;
      await ctx.cleanup();
    }
  });
});
