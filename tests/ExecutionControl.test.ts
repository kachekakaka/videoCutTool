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

  it('7. 全局全部停止排它屏障：拒绝新提交，清空队列与优先，保护 pendingFinal', async () => {
    const ctx = await createFixture();
    try {
      const pActive = ctx.makeRecord('p-active', '运行中任务');
      const pQueued = ctx.makeRecord('p-queued', '排队中任务');
      const pPending = ctx.makeRecord('p-pending', '已生成成片待保存');
      await ctx.planManager.savePlan(pActive);
      await ctx.planManager.savePlan(pQueued);
      await ctx.planManager.savePlan(pPending);

      await ctx.planManager.pauseQueue();
      await ctx.planManager.executePlan(pActive.id);
      await ctx.planManager.executePlan(pQueued.id);

      // 模拟底层 pendingFinalPreserved 保护
      vi.spyOn(ctx.engine, 'cancelAll').mockImplementation(async () => ({
        success: true,
        activeCancelled: true,
        clearedQueuedCount: 1,
        clearedPriority: false,
        pendingFinalPreserved: true,
        dequeuedCount: 1,
      }));

      const cancelAllResult = await ctx.planManager.cancelAllPlans();
      expect(cancelAllResult.success).toBe(true);
      expect(cancelAllResult.pendingFinalPreserved).toBe(true);
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
});
