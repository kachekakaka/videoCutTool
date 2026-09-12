import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { PlanRecord } from '../../shared/types';

type Recovery = { version: 1; id: string; deleted?: boolean; record?: PlanRecord; hash: string };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 恢复快照是用户数据；主文件写入失败时仍保留上一份经校验的完整记录。 */
export class PlanRecordStore {
  readonly recoveryDir: string;
  initializationIssue: string | null = null;
  constructor(readonly plansDir: string) { this.recoveryDir = path.join(path.dirname(plansDir), 'plans_recovery'); }
  async initialize() {
    this.initializationIssue = null;
    try { await Promise.all([fs.promises.mkdir(this.plansDir, { recursive: true }), fs.promises.mkdir(this.recoveryDir, { recursive: true })]); }
    catch (error) {
      if (!(await fs.promises.stat(this.plansDir).catch(() => null))?.isDirectory()) throw error;
      this.initializationIssue = `方案目录可读取，但恢复目录尚不可写；保存前请修复工作数据目录权限：${String(error)}`;
    }
  }
  private file(id: string, recovery = false) {
    if (!/^[\w-]+$/.test(id)) throw new Error('方案 ID 无效');
    return path.join(recovery ? this.recoveryDir : this.plansDir, `${id}.json`);
  }
  validate(record: PlanRecord, id = record?.id): PlanRecord {
    this.file(id);
    if (!record || record.id !== id || typeof record.sourcePath !== 'string' || !record.sourcePath || typeof record.title !== 'string' || !Array.isArray(record.cuts) || record.cuts.some(p => !Number.isFinite(p) || p < 0) || !record.decisions || typeof record.decisions !== 'object' || Object.values(record.decisions).some(value => value !== 'keep' && value !== 'discard') || !Number.isFinite(record.totalDurationMs) || record.totalDurationMs <= 0 || !['ready', 'queued', 'processing', 'completed', 'failed'].includes(record.status)) throw new Error(`方案 ${id} 内容无效`);
    return record;
  }
  private async recovery(id: string): Promise<Recovery | null> {
    try {
      const value = JSON.parse(await fs.promises.readFile(this.file(id, true), 'utf8')) as Recovery;
      if (value.version !== 1 || value.id !== id || value.hash !== digest(value.deleted ? { id, deleted: true } : value.record)) throw new Error('恢复快照校验失败');
      if (!value.deleted) this.validate(value.record!, id);
      return value;
    } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  }
  private async writeVerified(file: string, value: unknown) {
    const serialized = JSON.stringify(value, null, 2);
    JSON.parse(serialized);
    const handle = await fs.promises.open(file, 'w');
    try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    if (await fs.promises.readFile(file, 'utf8') !== serialized) throw new Error(`写入回读校验失败：${file}`);
  }
  async read(id: string): Promise<{ record: PlanRecord | null; issue?: string }> {
    let recovery: Recovery | null = null, recoveryError = '';
    try { recovery = await this.recovery(id); } catch (error) { recoveryError = String(error); }
    if (recovery?.deleted) return { record: null };
    try {
      const record = this.validate(JSON.parse(await fs.promises.readFile(this.file(id), 'utf8')), id);
      return { record, issue: recoveryError ? `${id} 恢复快照损坏，主记录完整：${recoveryError}` : undefined };
    } catch (error: any) {
      // 外部主动删除主文件时，不从旧快照复活记录。
      if (error.code === 'ENOENT') return { record: null };
      if (!recovery?.record) return { record: null, issue: `${id} 无法读取：${this.file(id)}；${String(error)}；${recoveryError || '无有效恢复快照'}` };
      try { await this.writeVerified(this.file(id), recovery.record); return { record: recovery.record, issue: `${id} 主记录损坏，已从完整快照恢复` }; }
      catch (repairError) { return { record: recovery.record, issue: `${id} 正在展示恢复快照，主文件修复失败：${String(repairError)}` }; }
    }
  }
  async save(record: PlanRecord) {
    this.validate(record);
    let recovery: Recovery | null = null;
    try { recovery = await this.recovery(record.id); } catch { /* 主记录仍完整时可重建损坏的快照。 */ }
    if (recovery?.deleted) throw new Error('方案已删除，请另存为新方案');
    let previous: PlanRecord | null = null;
    try { previous = this.validate(JSON.parse(await fs.promises.readFile(this.file(record.id), 'utf8')), record.id); }
    catch (error: any) {
      if (error.code !== 'ENOENT') {
        if (!recovery?.record) throw new Error('原方案与恢复快照均损坏，不能覆盖唯一记录');
        await this.writeVerified(this.file(record.id), recovery.record);
        previous = recovery.record;
      }
    }
    if (previous) await this.writeVerified(this.file(record.id, true), { version: 1, id: record.id, record: previous, hash: digest(previous) });
    await this.writeVerified(this.file(record.id), record);
    return record;
  }
  async delete(id: string) {
    const previous = await this.read(id);
    if (!previous.record && !await fs.promises.stat(this.file(id)).catch(() => null)) return false;
    if (previous.record) {
      try { this.validate(JSON.parse(await fs.promises.readFile(this.file(id), 'utf8')), id); }
      catch { await this.writeVerified(this.file(id), previous.record); }
    }
    // 标记写入失败时，主文件尚未触碰；标记成功后，即使清理中断也不能恢复。
    await this.writeVerified(this.file(id, true), { version: 1, id, deleted: true, hash: digest({ id, deleted: true }) });
    await fs.promises.unlink(this.file(id)).catch((error: any) => { if (error.code !== 'ENOENT') console.warn('已标记删除，主文件待下次清理：', error.message); });
    return true;
  }
}
