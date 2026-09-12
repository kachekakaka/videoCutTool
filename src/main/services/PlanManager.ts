import fs from 'fs';
import path from 'path';
import { PlanRecord, PlanChange, PlanListResult } from '../../shared/types';
import { MediaCuttingEngine } from './MediaCuttingEngine';
import { KeyframeProber } from './KeyframeProber';
import { PlanRecordStore } from './PlanRecordStore';

export class PlanManager {
  private store: PlanRecordStore;
  private records = new Map<string, PlanRecord>();
  private issues: string[] = [];
  private deleting = new Set<string>();
  private operations: Promise<unknown> = Promise.resolve();
  private listener?: (change: PlanChange) => void;
  readonly ready: Promise<void>;
  constructor(directory: string, private engine: MediaCuttingEngine, private prober: KeyframeProber) {
    const resolved = path.resolve(directory);
    this.store = new PlanRecordStore(path.basename(resolved) === 'plans' ? resolved : path.join(resolved, 'plans'));
    this.ready = this.store.initialize().then(() => this.scan(true));
    this.engine.setPlanSaver(record => this.persist(record));
  }
  setChangeListener(listener: (change: PlanChange) => void) { this.listener = listener; }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation); this.operations = task.catch(() => {}); return task;
  }
  private async scan(startup = false) {
    const files = (await fs.promises.readdir(this.store.plansDir)).filter(file => file.endsWith('.json'));
    const next = new Map<string, PlanRecord>(), issues: string[] = this.store.initializationIssue ? [this.store.initializationIssue] : [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
      while (cursor < files.length) {
        const id = files[cursor++].slice(0, -5);
        try {
          const result = await this.store.read(id);
          if (result.issue) issues.push(result.issue);
          let record = result.record;
          if (record && (startup || !this.engine.isAccepted(id)) && ['queued', 'processing'].includes(record.status)) {
            const recovered = { ...record, status: 'failed' as const, error: '上次执行中断，可重试', updatedAt: new Date().toISOString() };
            try { record = await this.store.save(recovered); } catch (error) { issues.push(`${id} 中断状态保存失败：${String(error)}`); }
          }
          if (record) next.set(id, record);
        } catch (error) { issues.push(`${id} 读取失败：${String(error)}`); }
      }
    }));
    this.records = next; this.issues = issues;
  }
  async listPlans(): Promise<PlanRecord[]> { await this.ready; return structuredClone([...this.records.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))); }
  async refreshPlans(): Promise<PlanListResult> { await this.ready; await this.serial(async () => { await this.store.initialize(); await this.scan(); }); return this.details(); }
  async details(): Promise<PlanListResult> { return { records: await this.listPlans(), issues: [...this.issues] }; }
  async getPlan(id: string) { await this.ready; return structuredClone(this.records.get(id) || null); }
  private async persist(record: PlanRecord) {
    await this.ready;
    return this.serial(async () => {
      if (this.deleting.has(record.id)) throw new Error('方案正在删除');
      const saved = await this.store.save({ ...record, updatedAt: new Date().toISOString() });
      this.records.set(saved.id, saved); this.listener?.({ record: structuredClone(saved) }); return saved;
    });
  }
  async savePlan(record: PlanRecord) {
    await this.ready;
    return this.serial(async () => {
      if (this.engine.isAccepted(record.id) || this.deleting.has(record.id)) throw new Error('方案正在排队或处理中，请完成后保存，或另存为新方案');
      const saved = await this.store.save({ ...record, status: 'ready', updatedAt: new Date().toISOString() });
      this.records.set(saved.id, saved); this.listener?.({ record: structuredClone(saved) }); return saved;
    });
  }
  async deletePlan(id: string) {
    if (this.deleting.has(id)) throw new Error('方案正在删除');
    this.deleting.add(id);
    let removed: ReturnType<MediaCuttingEngine['removeQueued']>;
    try {
      removed = this.engine.removeQueued(id);
      await this.ready;
      return await this.serial(async () => {
        const deleted = await this.store.delete(id);
        this.records.delete(id); this.listener?.({ deletedId: id }); return deleted;
      });
    } catch (error) { if (removed!) this.engine.restoreQueued(removed); throw error; }
    finally { this.deleting.delete(id); }
  }
  async submitDraft(record: PlanRecord) {
    await this.ready;
    if (this.deleting.has(record.id)) throw new Error('方案正在删除');
    this.store.validate(record);
    await fs.promises.access(record.sourcePath);
    if (this.deleting.has(record.id)) throw new Error('方案正在删除');
    return this.engine.submitPlan(record, this.prober);
  }
  async executePlan(id: string) {
    const record = await this.getPlan(id);
    if (!record) return { success: false, message: '方案文件不存在' };
    try { const result = await this.submitDraft(record); return { success: true, message: result.queued ? '已加入后台排队队列' : '已启动后台剪辑', ...result }; }
    catch (error) { return { success: false, message: String(error) }; }
  }
  async batchExecute() {
    const plans = (await this.listPlans()).filter(record => record.status === 'ready');
    let queued = 0; const errors: string[] = [];
    for (const plan of plans) { const result = await this.executePlan(plan.id); if (result.success) queued++; else errors.push(`${plan.title}：${result.message}`); }
    return { total: plans.length, queued, errors };
  }
}
