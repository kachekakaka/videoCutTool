/// <reference types="vite/client" />

import { AppConfig, MediaMetadata, MediaRetentionPlan, CutResult, PlanRecord, CompressConfig } from './shared/types';

export interface ElectronAPI {
  getPathForFile: (file: File) => string;
  // 配置
  getConfig: () => Promise<AppConfig>;
  saveConfig: (config: Partial<AppConfig>) => Promise<AppConfig>;
  getConfigPath: () => Promise<string>;
  resolveOutputPath: (videoPath: string, isConcat?: boolean, planTitle?: string) => Promise<string>;

  // 媒体探测与对话框
  openVideoDialog: () => Promise<string | null>;
  selectDirectory: (defaultPath?: string) => Promise<string | null>;
  probeMedia: (filePath: string) => Promise<MediaMetadata>;
  probeBasic: (filePath: string) => Promise<MediaMetadata>;
  probeKeyframes: (filePath: string) => Promise<number[]>;

  // 降码与画质对比预览
  previewCompressionSamples: (
    videoPath: string,
    timestampsMs: number[],
    config: CompressConfig
  ) => Promise<Array<{
    index: number;
    timestampMs: number;
    originalBase64: string;
    compressedBase64: string;
    originalSizeBytes: number;
    compressedSizeBytes: number;
  }>>;
  probeHardwareEncoder: () => Promise<'cpu' | 'nvenc' | 'qsv'>;

  // 剪辑执行与后台引擎
  submitDraft: (record: PlanRecord) => Promise<{ queued: boolean; active: boolean }>;
  onPlanStatusChanged: (callback: (event: { planId: string; status: 'processing' | 'completed' | 'failed'; outputPath?: string; error?: string; record?: PlanRecord }) => void) => () => void;
  onPlanCompleted: (callback: (event: { planId: string; status: 'completed'; outputPath?: string; record?: PlanRecord }) => void) => () => void;

  // 方案管理
  listPlans: () => Promise<PlanRecord[]>;
  savePlan: (record: PlanRecord) => Promise<PlanRecord>;
  deletePlan: (id: string) => Promise<boolean>;
  executePlan: (id: string) => Promise<{ success: boolean; message: string; queued?: boolean; active?: boolean }>;
  batchExecutePlans: () => Promise<{ total: number; queued: number }>;
  showItemInFolder: (fullPath: string) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
