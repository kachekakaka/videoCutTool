import { MediaIndexStore } from './MediaIndexStore';
import { StreamPlaybackIndexService } from './StreamPlaybackIndexService';
import { KeyframeProber } from './KeyframeProber';
import { CacheMaintenanceService } from './CacheMaintenanceService';
import { setMediaIndexLookup } from './MediaTools';

/** 编辑和导出共用一个分析任务入口与用户数据目录中的完整索引。 */
export class MediaIndexService {
  readonly store: MediaIndexStore;
  readonly streams: StreamPlaybackIndexService;
  readonly prober: KeyframeProber;
  constructor(dataDirectory: string, maintenance: CacheMaintenanceService, tool?: string) {
    this.store = new MediaIndexStore(dataDirectory, maintenance);
    this.streams = new StreamPlaybackIndexService(this.store, maintenance, tool);
    this.prober = new KeyframeProber(this.store, this.streams, maintenance, tool);
    setMediaIndexLookup(async file => { const record = await this.store.find(file); return record?.usable ? record.info : undefined; });
  }
}
