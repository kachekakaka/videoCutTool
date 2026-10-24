import fs from 'fs';
import path from 'path';
import { PlanRecord, PlanChange, PlanListResult } from '../../shared/types';
import { MediaCuttingEngine } from './MediaCuttingEngine';
import { KeyframeProber } from './KeyframeProber';
import { PlanRecordStore } from './PlanRecordStore';
import { randomUUID } from 'crypto';
import { fileIdentityAsync } from './MediaTools';

export class PlanManager {
  private store: PlanRecordStore;
  private records = new Map<string, PlanRecord>();
  private issues: string[] = [];
  private deleting = new Set<string>();
  private operations: Promise<unknown> = Promise.resolve();
  private listener?: (change: PlanChange) => void;
  private confirmations = new Map<string, { id: string; record: string; identity: string }>();
  readonly ready: Promise<void>;
  constructor(directory: string, private engine: MediaCuttingEngine, private prober: KeyframeProber) {
    const resolved = path.resolve(directory);
    this.store = new PlanRecordStore(path.basename(resolved) === 'plans' ? resolved : path.join(resolved, 'plans'));
    this.ready = this.store.initialize().then(async () => { await this.scan(true); await this.reconcileIndexes(); });
    if (prober.store) prober.store.onPublished = () => { void this.ready.then(() => this.serial(() => this.reconcileIndexes())).catch(error => this.issues.push(`索引关联待恢复：${String(error)}`)); };
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
  async refreshPlans(): Promise<PlanListResult> { await this.ready; await this.serial(async () => { await this.store.initialize(); await this.scan(); await this.reconcileIndexes(); }); return this.details(); }
  async details(): Promise<PlanListResult> { return { records: await this.listPlans(), issues: [...this.issues, ...(this.prober.store?.issues || [])] }; }
  async getPlan(id: string) { await this.ready; return structuredClone(this.records.get(id) || null); }
  private async persist(record: PlanRecord) {
    await this.ready;
    return this.serial(async () => {
      if (this.deleting.has(record.id)) throw new Error('方案正在删除');
      const current = this.records.get(record.id);
      if (!record.mediaIndexId && current?.mediaIndexId && current.sourceIdentity === record.sourceIdentity && current.contentRevision === record.contentRevision) record = { ...record, mediaIndexId: current.mediaIndexId };
      const saved = await this.store.save({ ...record, updatedAt: new Date().toISOString() });
      this.records.set(saved.id, saved); this.listener?.({ record: structuredClone(saved) }); return saved;
    });
  }
  private async reconcileIndexes() {
    if (!this.prober.store) return;
    for (const record of this.records.values()) {
      if (!record.sourceIdentity || !record.contentRevision || this.deleting.has(record.id)) continue;
      try {
        const index = await this.prober.store.find(record.sourcePath, { waitForPublication: false });
        if (!index?.usable || index.identity !== record.sourceIdentity || record.mediaIndexId === index.id) continue;
        const saved = await this.store.save({ ...record, mediaIndexId: index.id });
        this.records.set(record.id, saved); this.listener?.({ record: structuredClone(saved) });
      } catch (error) { this.issues.push(`${record.id} 索引关联待恢复：${String(error)}`); }
    }
  }
  private async indexForSave(file: string, identity: string, previousId?: string) {
    try {
      const index = await this.prober.store?.find(file, { waitForPublication: false });
      return index?.usable && index.identity === identity ? index.id : undefined;
    } catch (error) {
      const message = `${file} 索引关联待恢复，方案内容仍可保存：${String(error)}`;
      if (!this.issues.includes(message)) this.issues.push(message);
      return previousId;
    }
  }
  async sourceBinding(id: string) {
    const record = await this.getPlan(id); if (!record) throw new Error('方案不存在');
    const identity = await fileIdentityAsync(record.sourcePath);
    if (record.sourceIdentity && record.sourceIdentity !== identity) throw new Error('素材已变化，不能将旧方案切点应用到新视频；原方案与索引已保留');
    if (record.sourceIdentity) return { record, identity };
    const stat = await fs.promises.stat(record.sourcePath);
    if (await fileIdentityAsync(record.sourcePath) !== identity) throw new Error('读取期间素材变化，请重新打开');
    const token = randomUUID(); if (this.confirmations.size >= 32) this.confirmations.delete(this.confirmations.keys().next().value!);
    this.confirmations.set(token, { id, record: JSON.stringify(record), identity });
    return { record, identity, token, fileInfo: { size: stat.size, modifiedAt: stat.mtime.toISOString() } };
  }
  async confirmSource(id: string, token: string) {
    await this.ready;
    return this.serial(async () => {
      const request = this.confirmations.get(token); this.confirmations.delete(token);
      const record = this.records.get(id);
      if (!request || request.id !== id || !record || this.deleting.has(id) || this.engine.isAccepted(id) || request.record !== JSON.stringify(record)) throw new Error('方案已变化，请重新打开后确认');
      if (await fileIdentityAsync(record.sourcePath) !== request.identity) throw new Error('确认期间素材已变化，未绑定');
      const mediaIndexId = await this.indexForSave(record.sourcePath, request.identity);
      if (await fileIdentityAsync(record.sourcePath) !== request.identity) throw new Error('确认期间素材已变化，未绑定');
      const saved = await this.store.save({ ...record, sourceIdentity: request.identity, contentRevision: randomUUID(), mediaIndexId });
      this.records.set(id, saved); this.listener?.({ record: structuredClone(saved) }); return saved;
    });
  }
  async savePlan(record: PlanRecord) {
    await this.ready;
    return this.serial(async () => {
      if (this.engine.isAccepted(record.id) || this.deleting.has(record.id)) throw new Error('方案正在排队或处理中，请完成后保存，或另存为新方案');
      if (this.prober.store && !record.compressionOnly) {
        const previous = this.records.get(record.id), identity = await fileIdentityAsync(record.sourcePath);
        if (previous && (!previous.sourceIdentity || previous.sourceIdentity !== identity)) throw new Error('素材对应关系待确认或已变化，请回载方案检查；原方案保留');
        if (!record.sourceIdentity || record.sourceIdentity !== identity) throw new Error('编辑期间素材已变化，请重新打开');
        if (previous && previous.contentRevision !== record.contentRevision) throw new Error('方案已被修改，请重新回载后保存');
        const mediaIndexId = await this.indexForSave(record.sourcePath, identity, previous?.mediaIndexId);
        if (await fileIdentityAsync(record.sourcePath) !== identity) throw new Error('保存期间素材已变化，请重新打开');
        record = { ...record, contentRevision: randomUUID(), mediaIndexId };
      }
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
  async submitDraft(record: PlanRecord, saveContent = true) {
    await this.ready;
    if (this.deleting.has(record.id)) throw new Error('方案正在删除');
    this.store.validate(record);
    if (this.prober.store && !record.compressionOnly) {
      if (!record.sourceIdentity) throw new Error('素材对应关系待确认，请回载方案确认后执行');
      if (record.sourceIdentity !== await fileIdentityAsync(record.sourcePath)) throw new Error('素材已变化，旧切点未执行');
      if (saveContent) record = await this.savePlan(record);
    }
    await fs.promises.access(record.sourcePath);
    const accepted = await this.serial(async () => {
      if (this.deleting.has(record.id)) throw new Error('方案正在删除');
      if (this.prober.store && !record.compressionOnly) {
        const current = this.records.get(record.id);
        if (!current || current.contentRevision !== record.contentRevision || current.sourceIdentity !== record.sourceIdentity) throw new Error('方案已变化，未执行旧内容，请重新回载');
      }
      // 在串行边界内同步占用执行状态，持久化在退出该边界后完成。
      return { pending: this.engine.submitPlan(record, this.prober) };
    });
    return { ...await accepted.pending, contentRevision: record.contentRevision };
  }
  async executePlan(id: string) {
    const record = await this.getPlan(id);
    if (!record) return { success: false, message: '方案文件不存在' };
    try { const result = await this.submitDraft(record, false); return { success: true, message: result.queued ? '已加入后台排队队列' : '已启动后台剪辑', ...result }; }
    catch (error) { return { success: false, message: String(error) }; }
  }
  async batchExecute() {
    const plans = (await this.listPlans()).filter(record => record.status === 'ready');
    let queued = 0; const errors: string[] = [];
    for (const plan of plans) { const result = await this.executePlan(plan.id); if (result.success) queued++; else errors.push(`${plan.title}：${result.message}`); }
    return { total: plans.length, queued, errors };
  }
  async executeSelected(ids: string[]) {
    const unique = [...new Set(ids)];
    let queued = 0; const errors: string[] = [];
    for (const id of unique) {
      const record = await this.getPlan(id);
      if (!record || !['ready', 'failed'].includes(record.status)) { errors.push(`${record?.title || id}：当前不可提交`); continue; }
      const result = await this.executePlan(id);
      if (result.success) queued++; else errors.push(`${record.title}：${result.message}`);
    }
    return { total: unique.length, queued, errors };
  }
}
