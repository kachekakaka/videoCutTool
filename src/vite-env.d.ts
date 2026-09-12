/// <reference types="vite/client" />

import { AppConfig, MediaMetadata, PlanRecord, CompressConfig, PreviewSample, PlanChange, PlanListResult, EngineState, ExecutionStatus, PreviewProgress } from './shared/types';

export interface ElectronAPI {
  getPathForFile: (file: File) => string;
  // 配置
  getConfig: () => Promise<AppConfig>;
  saveConfig: (config: Partial<AppConfig>) => Promise<AppConfig>;
  onConfigChanged: (callback: (config: AppConfig) => void) => () => void;
  getConfigPath: () => Promise<string>;
  resolveOutputPath: (videoPath: string, isConcat?: boolean, planTitle?: string, compress?: CompressConfig, stripCover?: boolean) => Promise<string>;

  // 媒体探测与对话框
  openVideoDialog: () => Promise<string | null>;
  selectDirectory: (defaultPath?: string) => Promise<string | null>;
  probeMedia: (filePath: string) => Promise<MediaMetadata>;
  probeBasic: (filePath: string) => Promise<MediaMetadata>;
  probeKeyframes: (filePath: string) => Promise<number[]>;
  adjacentFrame: (file: string, time: number, direction: -1 | 1) => Promise<number>;
  preparePlayback: (file: string, convert: boolean, id: string) => Promise<{ path?: string; needsConversion?: boolean; timeOffsetMs?: number }>;
  cancelPlayback: (id: string) => Promise<void>;
  onPreviewProgress: (callback: (progress: PreviewProgress) => void) => () => void;

  // 降码与画质对比预览
  previewCompressionSamples: (
    videoPath: string,
    timestampsMs: number[],
    config: CompressConfig,
    requestId?: string
  ) => Promise<PreviewSample[]>;
  cancelCompressionPreview: (id: string) => Promise<void>;
  probeHardwareEncoder: (config?: CompressConfig) => Promise<'cpu' | 'nvenc' | 'qsv'>;

  // 剪辑执行与后台引擎
  submitDraft: (record: PlanRecord) => Promise<{ queued: boolean; active: boolean }>;
  onPlanStatusChanged: (callback: (event: { planId: string; status: ExecutionStatus; outputPath?: string; error?: string; record?: PlanRecord }) => void) => () => void;
  onPlanCompleted: (callback: (event: { planId: string; status: 'completed'; outputPath?: string; record?: PlanRecord }) => void) => () => void;

  // 方案管理
  listPlans: () => Promise<PlanRecord[]>;
  getPlanDetails: () => Promise<PlanListResult>;
  refreshPlans: () => Promise<PlanListResult>;
  onPlanChanged: (callback: (change: PlanChange) => void) => () => void;
  getEngineState: () => Promise<EngineState>;
  onEngineStateChanged: (callback: (state: EngineState) => void) => () => void;
  retryPendingWrites: () => Promise<void>;
  savePlan: (record: PlanRecord) => Promise<PlanRecord>;
  deletePlan: (id: string) => Promise<boolean>;
  executePlan: (id: string) => Promise<{ success: boolean; message: string; queued?: boolean; active?: boolean }>;
  batchExecutePlans: () => Promise<{ total: number; queued: number; errors?: string[] }>;
  showItemInFolder: (fullPath: string) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
