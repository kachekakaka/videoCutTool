import { ExecutionProgress, ExecutionStage } from '../../shared/types';

export interface ExecutionStep {
  key: string;
  stage: ExecutionStage;
  durationMs: number;
  current?: number;
  total?: number;
}

/** stdout 的块边界不是行边界；只保留有界尾行，不收集整段日志。 */
export function parseFfmpegProgress(onTime: (milliseconds: number) => void) {
  let tail = '', dropping = false;
  return (chunk: string) => {
    const lines = chunk.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const part = lines[i];
      if (!dropping) {
        if (tail.length + part.length > 16384) { tail = ''; dropping = true; }
        else tail += part;
      }
      if (i === lines.length - 1) break;
      if (!dropping) {
        const match = /^out_time_us=(\d+)\r?$/.exec(tail);
        if (match) {
          const microseconds = Number(match[1]);
          if (Number.isSafeInteger(microseconds)) onTime(microseconds / 1000);
        }
      }
      tail = ''; dropping = false;
    }
  };
}

/** 每次执行独立持有；百分比按处理量计算，不估算墙钟耗时。 */
export class ExecutionProgressTracker {
  private steps = new Map<string, ExecutionStep & { ratio: number; done: boolean }>();
  private finished = new Set<string>();
  private finalOperations = 0;
  private highWater = 0;
  private lastSentAt = 0;
  private snapshot: ExecutionProgress;

  constructor(planId: string, private readonly emit: (value: ExecutionProgress) => void) {
    this.snapshot = { planId, stage: 'preparing', percent: null };
    this.send(true);
  }

  configure(steps: ExecutionStep[], outputCount: number) {
    this.steps = new Map(steps.map(step => [step.key, { ...step, ratio: 0, done: false }]));
    this.finalOperations = outputCount * 2;
  }

  private percentage(): number | null {
    const steps = [...this.steps.values()];
    if (!steps.length) return null;
    const allDone = steps.every(step => step.done);
    if (!allDone && steps.some(step => !Number.isFinite(step.durationMs) || step.durationMs <= 0)) return null;
    const total = steps.reduce((sum, step) => sum + step.durationMs, 0);
    const value = allDone
      ? 95 + 4 * this.finished.size / Math.max(1, this.finalOperations)
      : 95 * steps.reduce((sum, step) => sum + step.durationMs * step.ratio, 0) / total;
    this.highWater = Math.max(this.highWater, Math.min(99, value));
    return Math.floor(this.highWater);
  }

  stage(stage: ExecutionStage, current?: number, total?: number) {
    this.snapshot = { planId: this.snapshot.planId, stage, percent: this.percentage(), current, total };
    this.send(true);
  }

  start(key: string, durationMs: number, cpuRetry = false, originMs = 0) {
    const step = this.steps.get(key);
    if (!step) throw new Error(`未登记的导出步骤：${key}`);
    // 重试从头计算该步骤，整体高水位保持；不再加一份步骤权重。
    step.ratio = 0; step.done = false;
    this.snapshot = { planId: this.snapshot.planId, stage: step.stage, percent: this.percentage(), current: step.current, total: step.total, cpuRetry };
    this.send(true);
    return parseFfmpegProgress(timeMs => {
      if (!(durationMs > 0) || !Number.isFinite(durationMs)) return;
      step.ratio = Math.max(step.ratio, Math.max(0, Math.min(0.999, (timeMs - originMs) / durationMs)));
      this.snapshot.percent = this.percentage();
      this.send(false);
    });
  }

  complete(key: string) {
    const step = this.steps.get(key);
    if (!step) throw new Error(`未登记的导出步骤：${key}`);
    step.ratio = 1; step.done = true;
    this.snapshot.percent = this.percentage(); this.send(true);
  }

  finishOperation(key: string) {
    this.finished.add(key);
    this.snapshot.percent = this.percentage(); this.send(true);
  }

  saving() {
    this.snapshot = { planId: this.snapshot.planId, stage: 'saving', percent: 99 };
    this.send(true);
  }

  failed() {
    this.snapshot = { planId: this.snapshot.planId, stage: 'failed', percent: this.snapshot.percent };
    this.send(true);
  }

  private send(force: boolean) {
    const now = performance.now();
    if (!force && now - this.lastSentAt < 200) return;
    this.lastSentAt = now;
    this.emit({ ...this.snapshot });
  }
}
