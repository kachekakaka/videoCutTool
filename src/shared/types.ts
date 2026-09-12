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
  keyframePoints?: KeyframePoint[];
  timeOrigin?: MediaTime;
  streams?: MediaStreamInfo[];
}

/** 秒的有理数表示；整数用字符串存储，避免 JSON 往返丢失寻址精度。 */
export interface MediaTime { numerator: string; denominator: string }
export interface KeyframePoint { time: MediaTime; timeMs: number }
export interface MediaStreamInfo {
  index: number;
  type: string;
  codec: string;
  language?: string;
  attachedPicture: boolean;
  default: boolean;
}
export interface ExportFormats { intermediateExtension: string; outputExtension: string }

export interface PlanSegment {
  segmentId: string;
  userRange: TimeRange;
  safeRange: TimeRange;
  sourceKeyframeMs: number;
  seekTime?: MediaTime;
}

export type CompressPresetId = 'high_quality' | 'balanced' | 'high_compression' | 'scale_1080p' | 'custom';

export interface CompressConfig {
  enabled: boolean;
  preset: CompressPresetId;
  crf?: number;         // 18 ~ 35 (默认 22)
  maxHeight?: number;   // 分辨率限制 (如 1080, 720)
  encoder?: 'auto' | 'cpu' | 'nvenc' | 'qsv';
  hardwareAcceleration?: boolean; // 硬件加速开关 (默认 true)
}

export interface MediaRetentionPlan {
  version: '1.0';
  title?: string;
  sourcePath: string;
  durationMs: number;
  concatToSingleFile: boolean;
  stripOriginalCover: boolean;
  outputPath: string;
  planSegments: PlanSegment[];
  totalKeptDurationMs: number;
  blockers: string[];
  compress?: CompressConfig;
}

export type ExecutionStatus = 'ready' | 'queued' | 'processing' | 'completed' | 'failed';

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
  compress?: CompressConfig;
  error?: string;
  outputPaths?: string[];
  resolvedEncoder?: 'cpu' | 'nvenc' | 'qsv';
}

export interface CutResult {
  success: boolean;
  outputPath: string;
  durationMs?: number;
  error?: string;
  outputPaths?: string[];
  resolvedEncoder?: 'cpu' | 'nvenc' | 'qsv';
}

export interface PlanChange { record?: PlanRecord; deletedId?: string }
export interface EngineState { activePlanId: string | null; queuedIds: string[]; storageError: string | null }
export interface PlanListResult { records: PlanRecord[]; issues: string[] }
export interface PreviewProgress { requestId: string; percent: number; message: string }

/**
 * 降码画质 A/B 对比抽样画格数据契约 (Visual Compression Preview Sample)
 */
export interface PreviewSample {
  index: number;
  timestampMs: number;
  originalBase64: string;
  compressedBase64: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
  originalUrl?: string;
  compressedUrl?: string;
  resolvedEncoder?: 'cpu' | 'nvenc' | 'qsv';
}
