/// <reference types="vite/client" />

import { AppConfig, MediaMetadata, MediaRetentionPlan, CutResult, PlanRecord } from './shared/types';

export interface ElectronAPI {
  getPathForFile: (file: File) => string;
  // 配置
  getConfig: () => Promise<AppConfig>;
  saveConfig: (config: Partial<AppConfig>) => Promise<AppConfig>;
  getConfigPath: () => Promise<string>;
  resolveOutputPath: (videoPath: string, isConcat?: boolean) => Promise<string>;

  // 媒体探测与对话框
  openVideoDialog: () => Promise<string | null>;
  selectDirectory: (defaultPath?: string) => Promise<string | null>;
  probeMedia: (filePath: string) => Promise<MediaMetadata>;
  probeBasic: (filePath: string) => Promise<MediaMetadata>;
  probeKeyframes: (filePath: string) => Promise<number[]>;

  // 剪辑执行
  executeCut: (plan: MediaRetentionPlan) => Promise<CutResult>;

  // 方案管理
  listPlans: () => Promise<PlanRecord[]>;
  savePlan: (record: PlanRecord) => Promise<PlanRecord>;
  deletePlan: (id: string) => Promise<boolean>;
  executePlan: (id: string) => Promise<CutResult>;
  batchExecutePlans: () => Promise<{ total: number; succeeded: number; failed: number }>;
  showItemInFolder: (fullPath: string) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
