/**
 * VideoCutTool 共享领域模型契约 (Domain Contracts)
 * 对齐 CONTEXT.md 与 ADR-0001 / ADR-0003
 */

export type OutputDirectoryRule = 'sub_folder' | 'same_directory' | 'custom_fixed';

export interface AppConfig {
  version: string;
  dataDirectory?: string;
  outputDirectoryRule: OutputDirectoryRule;
  subFolderName: string;
  customOutputDirectory: string;
  keyframeSafetyGuaranteed: boolean;
  autoConcatSingleFile: boolean;
  stripOriginalCover: boolean;
  notifyOnExportComplete: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  plansStoragePath: string;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  version: '1.0.0',
  outputDirectoryRule: 'sub_folder',
  subFolderName: '_cut',
  customOutputDirectory: '',
  keyframeSafetyGuaranteed: true,
  autoConcatSingleFile: true,
  stripOriginalCover: true,
  notifyOnExportComplete: true,
  ffmpegPath: 'D:/Tools/ffmpeg/ffmpeg.exe',
  ffprobePath: 'D:/Tools/ffmpeg/ffprobe.exe',
  plansStoragePath: './plans',
};

export type RetentionDecision = 'keep' | 'discard';

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface Segment {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  decision: RetentionDecision;
}

export interface MediaMetadata {
  filePath: string;
  fileName: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  keyframes: number[]; // 全片关键帧毫秒时间戳有序列表
}

export interface PlanSegment {
  segmentId: string;
  userRange: TimeRange;
  safeRange: TimeRange;
  sourceKeyframeMs: number;
}

export interface MediaRetentionPlan {
  version: '1.0';
  sourcePath: string;
  durationMs: number;
  concatToSingleFile: boolean;
  stripOriginalCover: boolean;
  outputPath: string;
  planSegments: PlanSegment[];
  totalKeptDurationMs: number;
  blockers: string[];
}

export type ExecutionStatus = 'ready' | 'processing' | 'completed' | 'failed';

export interface PlanRecord {
  id: string;
  title: string;
  sourcePath: string;
  outputPath: string;
  totalDurationMs: number;
  keptDurationMs: number;
  cutsCount: number;
  status: ExecutionStatus;
  updatedAt: string;
  completedAt: string | null;
  cuts: number[];
  decisions: Record<string, RetentionDecision>;
  concatSingleFile?: boolean;
  stripOriginalCover?: boolean;
  error?: string;
}

export interface CutResult {
  success: boolean;
  outputPath: string;
  durationMs?: number;
  error?: string;
}
