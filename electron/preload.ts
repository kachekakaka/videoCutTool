import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { AppConfig, CompressConfig, MediaMetadata, PlanRecord, PreviewSample, ExecutionStatus } from '../src/shared/types';
import type { ElectronAPI } from '../src/vite-env';

const subscribe = <T>(channel: string, callback: (value: T) => void) => {
  const handler = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, handler); return () => { ipcRenderer.removeListener(channel, handler); };
};

contextBridge.exposeInMainWorld('electronAPI', {
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return (file as any).path || '';
    }
  },
  // 配置相关
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  saveConfig: (config: Partial<AppConfig>): Promise<AppConfig> => ipcRenderer.invoke('config:save', config),
  onConfigChanged: callback => subscribe('config:changed', callback),
  getConfigPath: (): Promise<string> => ipcRenderer.invoke('config:getPath'),
  resolveOutputPath: (videoPath, isConcat, planTitle, compress, stripCover) => ipcRenderer.invoke('config:resolveOutputPath', videoPath, isConcat, planTitle, compress, stripCover),

  // 媒体探测与对话框
  openVideoDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openVideo'),
  selectDirectory: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:selectDirectory', defaultPath),
  probeMedia: (filePath: string): Promise<MediaMetadata> => ipcRenderer.invoke('media:probe', filePath),
  probeBasic: (filePath: string): Promise<MediaMetadata> => ipcRenderer.invoke('media:probeBasic', filePath),
  probeKeyframes: (filePath: string): Promise<number[]> => ipcRenderer.invoke('media:probeKeyframes', filePath),
  adjacentFrame: (file, time, direction) => ipcRenderer.invoke('media:adjacentFrame', file, time, direction),
  preparePlayback: (file, convert, id) => ipcRenderer.invoke('media:preparePlayback', file, convert, id),
  cancelPlayback: id => ipcRenderer.invoke('media:cancelPlayback', id),
  onPreviewProgress: callback => subscribe('media:previewProgress', callback),

  // 降码与画质对比预览
  previewCompressionSamples: (videoPath: string, timestampsMs: number[], config: CompressConfig, id?: string): Promise<PreviewSample[]> =>
    ipcRenderer.invoke('compress:previewSamples', videoPath, timestampsMs, config, id),
  cancelCompressionPreview: id => ipcRenderer.invoke('compress:cancelPreview', id),
  probeHardwareEncoder: config => ipcRenderer.invoke('compress:probeEncoder', config),

  // 执行裁剪与后台引擎
  submitDraft: (record: PlanRecord): Promise<{ queued: boolean; active: boolean }> => ipcRenderer.invoke('engine:submitDraft', record),
  onPlanStatusChanged: (callback: (event: { planId: string; status: ExecutionStatus; outputPath?: string; error?: string; record?: PlanRecord }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('plan:statusChanged', handler);
    return () => {
      ipcRenderer.removeListener('plan:statusChanged', handler);
    };
  },
  onPlanCompleted: (callback: (event: { planId: string; status: 'completed'; outputPath?: string; record?: PlanRecord }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('plan:completed', handler);
    return () => {
      ipcRenderer.removeListener('plan:completed', handler);
    };
  },

  // 方案管理
  listPlans: (): Promise<PlanRecord[]> => ipcRenderer.invoke('plan:list'),
  getPlanDetails: () => ipcRenderer.invoke('plan:details'),
  refreshPlans: () => ipcRenderer.invoke('plan:refresh'),
  onPlanChanged: callback => subscribe('plan:changed', callback),
  getEngineState: () => ipcRenderer.invoke('engine:state'),
  onEngineStateChanged: callback => subscribe('engine:stateChanged', callback),
  retryPendingWrites: () => ipcRenderer.invoke('engine:retryPendingWrites'),
  savePlan: (record: PlanRecord): Promise<PlanRecord> => ipcRenderer.invoke('plan:save', record),
  deletePlan: (id: string): Promise<boolean> => ipcRenderer.invoke('plan:delete', id),
  executePlan: (id: string): Promise<{ success: boolean; message: string; queued?: boolean; active?: boolean }> => ipcRenderer.invoke('plan:execute', id),
  batchExecutePlans: (): Promise<{ total: number; queued: number }> => ipcRenderer.invoke('plan:batchExecute'),
  showItemInFolder: (fullPath: string): Promise<void> => ipcRenderer.invoke('shell:showItemInFolder', fullPath),
} satisfies ElectronAPI);
