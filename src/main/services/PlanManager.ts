import fs from 'fs';
import path from 'path';
import { PlanRecord, CutResult, MediaRetentionPlan, Segment } from '../../shared/types';
import { FFmpegExecutor } from './FFmpegExecutor';
import { planRetention } from '../../shared/RetentionPlanner';
import { KeyframeProber } from './KeyframeProber';

/**
 * PlanManager: 方案管理器
 * 遵循 CONTEXT.md 领域模型契约，管理 Retention Plan 记录的持久化 CRUD 与生命周期状态机
 */
export class PlanManager {
  private plansDir: string;
  private executor: FFmpegExecutor;
  private prober: KeyframeProber;

  constructor(dataOrPlansDir: string = process.cwd(), executor: FFmpegExecutor, prober: KeyframeProber) {
    const resolved = path.resolve(dataOrPlansDir);
    this.plansDir = path.basename(resolved) === 'plans' ? resolved : path.join(resolved, 'plans');
    this.executor = executor;
    this.prober = prober;

    if (!fs.existsSync(this.plansDir)) {
      fs.mkdirSync(this.plansDir, { recursive: true });
    }
  }

  /**
   * 获取所有已保存的方案列表 (按更新时间倒序)
   */
  public listPlans(): PlanRecord[] {
    try {
      if (!fs.existsSync(this.plansDir)) return [];
      const files = fs.readdirSync(this.plansDir).filter(f => f.endsWith('.json'));
      const plans: PlanRecord[] = [];

      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(this.plansDir, file), 'utf-8');
          const parsed = JSON.parse(raw) as PlanRecord;
          if (parsed && parsed.id) {
            plans.push(parsed);
          }
        } catch {
          // 忽略损坏的单个文件
        }
      }

      return plans.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    } catch (err) {
      console.error('读取方案列表失败:', err);
      return [];
    }
  }

  /**
   * 保存或更新方案记录
   */
  public savePlan(record: PlanRecord): PlanRecord {
    if (!fs.existsSync(this.plansDir)) {
      fs.mkdirSync(this.plansDir, { recursive: true });
    }

    const filePath = path.join(this.plansDir, `${record.id}.json`);
    const toSave: PlanRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf-8');
    return toSave;
  }

  /**
   * 删除指定方案
   */
  public deletePlan(id: string): boolean {
    const filePath = path.join(this.plansDir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  /**
   * 将持久化记录转换为物理可执行的无损切片规划契约
   */
  public buildRetentionPlanFromRecord(record: PlanRecord, durationMs: number, keyframes: number[]): MediaRetentionPlan {
    const cuts = [0, ...record.cuts, durationMs].sort((a, b) => a - b);
    const uniqueCuts = Array.from(new Set(cuts));
    const segments: Segment[] = [];

    for (let i = 0; i < uniqueCuts.length - 1; i++) {
      const segId = `seg_${i}`;
      const decision = record.decisions[segId] || 'keep';
      segments.push({
        id: segId,
        index: i + 1,
        startMs: uniqueCuts[i],
        endMs: uniqueCuts[i + 1],
        durationMs: uniqueCuts[i + 1] - uniqueCuts[i],
        decision,
      });
    }

    return planRetention(
      record.sourcePath,
      durationMs,
      segments,
      keyframes,
      record.outputPath,
      record.concatSingleFile ?? true,
      record.stripOriginalCover ?? true
    );
  }

  /**
   * 执行指定方案的无损剪辑，并更新状态机
   */
  public async executePlan(id: string): Promise<CutResult> {
    const filePath = path.join(this.plansDir, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return { success: false, outputPath: '', durationMs: 0, error: '方案文件不存在' };
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const record = JSON.parse(raw) as PlanRecord;

    if (!fs.existsSync(record.sourcePath)) {
      return { success: false, outputPath: record.outputPath, durationMs: 0, error: '原始视频文件不存在' };
    }

    // 重新探测关键帧以保证精度
    const meta = await this.prober.probe(record.sourcePath);

    // 构建物理切片计划
    const retentionPlan = this.buildRetentionPlanFromRecord(record, meta.durationMs, meta.keyframes);

    // 执行裁剪
    const result = await this.executor.executePlan(retentionPlan);

    // 成功后跃迁状态为 completed 并落盘
    if (result.success) {
      record.status = 'completed';
      record.completedAt = new Date().toISOString();
      record.outputPath = result.outputPath;
      this.savePlan(record);
    }

    return result;
  }

  /**
   * 批量执行所有待执行的方案
   */
  public async batchExecute(): Promise<{ total: number; succeeded: number; failed: number }> {
    const plans = this.listPlans().filter(p => p.status === 'ready');
    let succeeded = 0;
    let failed = 0;

    for (const plan of plans) {
      const res = await this.executePlan(plan.id);
      if (res.success) {
        succeeded++;
      } else {
        failed++;
      }
    }

    return {
      total: plans.length,
      succeeded,
      failed,
    };
  }
}
