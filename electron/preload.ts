import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { AppConfig, MediaMetadata, MediaRetentionPlan, CutResult, PlanRecord } from '../src/shared/types';

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
  resolveOutputPath: (videoPath: string, isConcat?: boolean): Promise<string> => ipcRenderer.invoke('config:resolveOutputPath', videoPath, isConcat),

  // 媒体探测与对话框
  openVideoDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openVideo'),
  selectDirectory: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:selectDirectory', defaultPath),
  probeMedia: (filePath: string): Promise<MediaMetadata> => ipcRenderer.invoke('media:probe', filePath),
  probeBasic: (filePath: string): Promise<MediaMetadata> => ipcRenderer.invoke('media:probeBasic', filePath),
  probeKeyframes: (filePath: string): Promise<number[]> => ipcRenderer.invoke('media:probeKeyframes', filePath),

  // 执行裁剪
  executeCut: (plan: MediaRetentionPlan): Promise<CutResult> => ipcRenderer.invoke('cut:execute', plan),

  // 方案管理
  listPlans: (): Promise<PlanRecord[]> => ipcRenderer.invoke('plan:list'),
  savePlan: (record: PlanRecord): Promise<PlanRecord> => ipcRenderer.invoke('plan:save', record),
  deletePlan: (id: string): Promise<boolean> => ipcRenderer.invoke('plan:delete', id),
  executePlan: (id: string): Promise<CutResult> => ipcRenderer.invoke('plan:execute', id),
  batchExecutePlans: (): Promise<{ total: number; succeeded: number; failed: number }> => ipcRenderer.invoke('plan:batchExecute'),
  showItemInFolder: (fullPath: string): Promise<void> => ipcRenderer.invoke('shell:showItemInFolder', fullPath),
});
