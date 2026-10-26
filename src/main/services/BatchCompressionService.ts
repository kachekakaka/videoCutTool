import path from 'path';
import fs from 'fs';
import { CompressionFile, CompressionSaveRequest, PlanRecord } from '../../shared/types';
import { ConfigService } from './ConfigService';
import { PlanManager } from './PlanManager';
import { FileAccessRegistry, localPath, requestId, textValue, validateCompress } from './IpcSecurity';
import { resolveOutputDirectory } from './OutputPathResolver';
import { abortError, fileIdentityAsync, MediaLimiter, probeCompressionFile, resolveTool } from './MediaTools';

/** 整片压缩的检查和记录构造；存储和执行仍由方案管理器负责。 */
export class BatchCompressionService {
  private limiter = new MediaLimiter(() => 2);
  private invalid = new Map<string, { identity: string; message: string }>();
  private saves: Promise<unknown> = Promise.resolve();
  constructor(private config: ConfigService, private plans: PlanManager, private files: FileAccessRegistry) {}

  async inspect(sourcePath: string, signal?: AbortSignal): Promise<CompressionFile> {
    return this.limiter.run(async () => {
      const normalized = await this.files.check(sourcePath);
      const handle = await fs.promises.open(normalized, 'r'); await handle.close();
      const identity = await fileIdentityAsync(normalized);
      const info = await probeCompressionFile(normalized, resolveTool('ffprobe', this.config.getConfig().ffprobePath), signal);
      if (signal?.aborted) throw abortError();
      if (await fileIdentityAsync(normalized) !== identity) {
        info.check = 'pending'; info.width = null; info.height = null; info.message = '素材已变化，执行时重新确认';
      }
      const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      if (info.check === 'invalid') this.invalid.set(key, { identity, message: info.message! });
      else this.invalid.delete(key);
      return { sourcePath: normalized, pathKey: key, fileName: path.basename(normalized), durationMs: null, ...info };
    }, signal);
  }

  save(request: CompressionSaveRequest): Promise<PlanRecord> {
    const snapshot = structuredClone(request);
    const operation = this.saves.then(() => this.saveOne(snapshot));
    this.saves = operation.catch(() => {});
    return operation;
  }

  private async saveOne(request: CompressionSaveRequest): Promise<PlanRecord> {
    if (!request || typeof request !== 'object') throw new Error('压缩保存请求无效');
    requestId(request.id); localPath(request.sourcePath);
    textValue(request.title, '方案标题', 256);
    const title = request.title.trim();
    if (!title || /[<>:"/\\|?*\x00-\x1f]/.test(title)) throw new Error('方案标题为空或包含文件名不支持的字符');
    validateCompress(request.compress);
    if (!request.compress?.enabled || typeof request.stripOriginalCover !== 'boolean') throw new Error('整片压缩参数无效');
    const existing = await this.plans.getPlan(request.id);
    const sourcePath = await this.files.check(request.sourcePath);
    const handle = await fs.promises.open(sourcePath, 'r'); await handle.close();
    const identity = await fileIdentityAsync(sourcePath);
    const invalid = this.invalid.get(process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath);
    if (invalid?.identity === identity) throw new Error(invalid.message);
    const directory = resolveOutputDirectory(sourcePath, true);
    const same = existing?.compressionOnly && existing.sourcePath === sourcePath && existing.title === title && JSON.stringify(existing.compress) === JSON.stringify(request.compress) && existing.stripOriginalCover === request.stripOriginalCover && existing.outputDirectory === directory;
    // 成功回执丢失后的同 ID 重试只返回原记录，绝不重置已排队或已完成状态。
    if (same && (!request.expectedUpdatedAt || request.expectedUpdatedAt !== existing!.updatedAt)) return existing!;
    if (request.expectedUpdatedAt !== undefined) {
      if (!existing?.compressionOnly || existing.updatedAt !== request.expectedUpdatedAt || existing.sourcePath !== sourcePath) throw new Error('方案已变化，请重新打开后编辑');
    } else if (existing) throw new Error('方案 ID 已存在，请刷新后重试');
    const record: PlanRecord = {
      id: request.id, compressionOnly: true, title, sourcePath, outputDirectory: directory, outputPath: null,
      totalDurationMs: null, keptDurationMs: null, cutsCount: 0,
      cuts: [], decisions: { seg_0: 'keep' },
      stripOriginalCover: request.stripOriginalCover, compress: structuredClone(request.compress),
      status: 'ready', updatedAt: new Date().toISOString(), completedAt: null,
    };
    return this.plans.savePlan(record);
  }
}
