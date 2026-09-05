import fs from 'fs';
import path from 'path';
import { PlanRecord } from '../../shared/types';
import { MediaCuttingEngine } from './MediaCuttingEngine';
import { KeyframeProber } from './KeyframeProber';

/**
 * PlanManager: 方案管理器
 * 遵循 CONTEXT.md 领域模型契约，管理 Retention Plan 记录的持久化 CRUD
 * 并与 MediaCuttingEngine 协同提供后台队列调度与状态机持久化
 */
export class PlanManager {
  private plansDir: string;
  private engine: MediaCuttingEngine;
  private prober: KeyframeProber;

  constructor(
    dataOrPlansDir: string = process.cwd(),
    engine: MediaCuttingEngine,
    prober: KeyframeProber
  ) {
    const resolved = path.resolve(dataOrPlansDir);
    this.plansDir = path.basename(resolved) === 'plans' ? resolved : path.join(resolved, 'plans');
    this.engine = engine;
    this.prober = prober;

    if (!fs.existsSync(this.plansDir)) {
      fs.mkdirSync(this.plansDir, { recursive: true });
    }

    // 绑定引擎的方案持久化落盘回调
    this.engine.setPlanSaver((record) => {
      this.savePlan(record);
    });
  }

  /**
   * 获取所有已保存的方案列表 (按更新时间倒序)
   */
  public listPlans(): PlanRecord[] {
    try {
      if (!fs.existsSync(this.plansDir)) return [];
      const files = fs.readdirSync(this.plansDir).filter((f) => f.endsWith('.json'));
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
   * 获取单个方案
   */
  public getPlan(id: string): PlanRecord | null {
    const filePath = path.join(this.plansDir, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as PlanRecord;
    } catch {
      return null;
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
   * 提交草稿至后台引擎执行（工作台“立即执行”入口）
   */
  public submitDraft(record: PlanRecord): { queued: boolean; active: boolean } {
    const saved = this.savePlan(record);
    return this.engine.submitPlan(saved, this.prober);
  }

  /**
   * 提交指定方案至后台引擎执行
   */
  public executePlan(id: string): { success: boolean; message: string; queued?: boolean; active?: boolean } {
    const record = this.getPlan(id);
    if (!record) {
      return { success: false, message: '方案文件不存在' };
    }
    if (!fs.existsSync(record.sourcePath)) {
      return { success: false, message: `原视频文件不存在: ${record.sourcePath}` };
    }

    const res = this.engine.submitPlan(record, this.prober);
    return {
      success: true,
      message: res.queued ? '已加入后台排队队列' : '已启动后台剪辑',
      queued: res.queued,
      active: res.active,
    };
  }

  /**
   * 批量执行所有待执行的方案
   */
  public batchExecute(): { total: number; queued: number } {
    const readyPlans = this.listPlans().filter((p) => p.status === 'ready');
    let queued = 0;

    for (const plan of readyPlans) {
      const res = this.engine.submitPlan(plan, this.prober);
      if (res.queued || res.active) {
        queued++;
      }
    }

    return {
      total: readyPlans.length,
      queued,
    };
  }
}
