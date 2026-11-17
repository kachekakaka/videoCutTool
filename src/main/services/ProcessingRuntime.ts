import path from 'path';
import { ConfigService } from './ConfigService';
import { CacheMaintenanceService } from './CacheMaintenanceService';
import { MediaIndexService } from './MediaIndexService';
import { MediaCuttingEngine } from './MediaCuttingEngine';
import { PlanManager } from './PlanManager';
import { hasActiveMediaProcesses } from './MediaTools';

/** 媒体业务运行时不创建窗口、播放器或 IPC；队列恢复由调用方明确选择。 */
export class ProcessingRuntime {
  readonly config: ConfigService;
  readonly maintenance: CacheMaintenanceService;
  readonly indexes: MediaIndexService;
  readonly engine: MediaCuttingEngine;
  readonly plans: PlanManager;
  constructor(options: { config: ConfigService; registryDirectory: string; startupPolicy: 'restore' | 'new-only' }) {
    this.config = options.config;
    this.maintenance = new CacheMaintenanceService(options.registryDirectory, { busy: () => Boolean(this.engine?.getActivePlanId()) || hasActiveMediaProcesses() });
    this.maintenance.protect(this.config.getConfigPath(), path.join(this.config.getDataDirectory(), 'plans'));
    const settings = this.config.getConfig();
    this.indexes = new MediaIndexService(this.config.getDataDirectory(), this.maintenance, settings.ffprobePath);
    this.engine = new MediaCuttingEngine(settings.ffmpegPath, undefined, undefined, this.maintenance);
    this.engine.updateTools(settings.ffmpegPath, settings.ffprobePath);
    this.engine.setInputProvider((file, signal) => this.indexes.prober.input(file, signal));
    this.plans = new PlanManager(this.config.getDataDirectory(), this.engine, this.indexes.prober, options.startupPolicy);
  }
  async close() {
    const results = await Promise.allSettled([this.engine.shutdown(), this.indexes.prober.shutdown(), this.indexes.streams.shutdown()]);
    await this.maintenance.close();
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
