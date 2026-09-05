import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { AppConfig, CompressConfig, MediaMetadata, PlanRecord, PreviewSample } from '../src/shared/types';

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
  getConfigPath: (): Promise<string> => ipcRenderer.invoke('config:getPath'),
  resolveOutputPath: (videoPath: string, isConcat?: boolean, planTitle?: string): Promise<string> => ipcRenderer.invoke('config:resolveOutputPath', videoPath, isConcat, planTitle),

  // 媒体探测与对话框
  openVideoDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openVideo'),
  selectDirectory: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:selectDirectory', defaultPath),
  probeMedia: (filePath: string): Promise<MediaMetadata> => ipcRenderer.invoke('media:probe', filePath),
  probeBasic: (filePath: string): Promise<MediaMetadata> => ipcRenderer.invoke('media:probeBasic', filePath),
  probeKeyframes: (filePath: string): Promise<number[]> => ipcRenderer.invoke('media:probeKeyframes', filePath),

  // 降码与画质对比预览
  previewCompressionSamples: (videoPath: string, timestampsMs: number[], config: CompressConfig): Promise<PreviewSample[]> =>
    ipcRenderer.invoke('compress:previewSamples', videoPath, timestampsMs, config),
  probeHardwareEncoder: () => ipcRenderer.invoke('compress:probeEncoder'),

  // 执行裁剪与后台引擎
  submitDraft: (record: PlanRecord): Promise<{ queued: boolean; active: boolean }> => ipcRenderer.invoke('engine:submitDraft', record),
  onPlanStatusChanged: (callback: (event: { planId: string; status: 'processing' | 'completed' | 'failed'; outputPath?: string; error?: string; record?: PlanRecord }) => void) => {
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
  savePlan: (record: PlanRecord): Promise<PlanRecord> => ipcRenderer.invoke('plan:save', record),
  deletePlan: (id: string): Promise<boolean> => ipcRenderer.invoke('plan:delete', id),
  executePlan: (id: string): Promise<{ success: boolean; message: string; queued?: boolean; active?: boolean }> => ipcRenderer.invoke('plan:execute', id),
  batchExecutePlans: (): Promise<{ total: number; queued: number }> => ipcRenderer.invoke('plan:batchExecute'),
  showItemInFolder: (fullPath: string): Promise<void> => ipcRenderer.invoke('shell:showItemInFolder', fullPath),
});
