/**
 * VideoCutTool 共享领域模型契约 (Domain Contracts)
 * 对齐 CONTEXT.md 与 ADR-0001 / ADR-0003
 */

export interface AppConfig {
  version: string;
  dataDirectory?: string;
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
  sourceIdentity?: string;
  filePath: string;
  fileName: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  displayAspectRatio?: number;
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
  width?: number;
  height?: number;
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

export type MaskType = 'delogo' | 'black' | 'mosaic';
export type CropRatioOption = 'free' | '16:9' | '9:16' | '1:1' | 'source';

export interface SpatialMaskItem {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type: MaskType;
}

export interface SpatialCropBox {
  x: number;
  y: number;
  width: number;
  height: number;
  ratio: CropRatioOption;
  locked: boolean;
}

export interface SpatialConfig {
  crop?: SpatialCropBox;
  masks: SpatialMaskItem[];
  scope: 'global' | 'segment';
}

export type OutputMode = 'separate' | 'single' | 'custom';
export type ExportPrecision = 'keyframe' | 'frame';
export type SegmentOutputGroups = Record<string, string>;

export interface OutputGroup {
  segmentIds: string[];
}

export interface OutputFilePlan extends OutputGroup {
  planSegments: PlanSegment[];
  spatialSegments: Array<PlanSegment & { spatialConfig?: SpatialConfig }>;
}

export interface MediaRetentionPlan {
  exportPrecision?: ExportPrecision;
  version: '1.0';
  title?: string;
  sourcePath: string;
  durationMs: number;
  stripOriginalCover: boolean;
  outputPath: string;
  outputs: OutputFilePlan[];
  totalKeptDurationMs: number;
  blockers: string[];
  compress?: CompressConfig;
}

export type ExecutionStatus = 'ready' | 'queued' | 'processing' | 'completed' | 'failed';

interface PlanRecordFields {
  sourceIdentity?: string;
  contentRevision?: string;
  mediaIndexId?: string;
  exportPrecision?: ExportPrecision;
  id: string;
  title: string;
  sourcePath: string;
  cutsCount: number;
  status: ExecutionStatus;
  updatedAt: string;
  completedAt: string | null;
  cuts: number[];
  decisions: Record<string, RetentionDecision>;
  stripOriginalCover?: boolean;
  compress?: CompressConfig;
  spatialConfig?: SpatialConfig;
  segmentSpatialOverrides?: Record<string, SpatialConfig>;
  error?: string;
  outputPaths?: string[];
  resolvedEncoder?: 'cpu' | 'nvenc' | 'qsv';
}

export interface CuttingPlanRecord extends PlanRecordFields {
  compressionOnly?: undefined;
  outputMode: OutputMode;
  outputGroups: SegmentOutputGroups;
  outputPath: string;
  totalDurationMs: number;
  keptDurationMs: number;
}
export interface CompressionPlanRecord extends PlanRecordFields {
  compressionOnly: true;
  outputDirectory: string;
  outputPath: string | null;
  totalDurationMs: number | null;
  keptDurationMs: number | null;
}
export type PlanRecord = CuttingPlanRecord | CompressionPlanRecord;

export interface CompressionFile {
  sourcePath: string;
  pathKey: string;
  fileName: string;
  durationMs: null;
  width: number | null;
  height: number | null;
  check: 'ready' | 'pending' | 'invalid';
  message?: string;
}
export interface CompressionSaveRequest {
  id: string;
  sourcePath: string;
  title: string;
  compress: CompressConfig;
  stripOriginalCover: boolean;
  expectedUpdatedAt?: string;
}
export interface SelectedVideo { path: string; error?: string }

export interface CutResult {
  success: boolean;
  outputPath: string;
  durationMs?: number;
  error?: string;
  outputPaths?: string[];
  resolvedEncoder?: 'cpu' | 'nvenc' | 'qsv';
}

export interface PlanChange { record?: PlanRecord; deletedId?: string }
export type ExecutionStage = 'preparing' | 'normalizing' | 'cutting' | 'merging' | 'encoding' | 'verifying' | 'publishing' | 'saving' | 'failed';
export interface ExecutionProgress {
  planId: string;
  stage: ExecutionStage;
  percent: number | null;
  current?: number;
  total?: number;
  cpuRetry?: boolean;
}
export const EXECUTION_STAGE_LABELS: Record<ExecutionStage, string> = {
  preparing: '检查视频', normalizing: '整理时间戳', cutting: '裁剪中', merging: '合并中', encoding: '转码中',
  verifying: '校验产物', publishing: '发布中', saving: '等待保存结果', failed: '处理失败，等待保存结果',
};
export interface EngineState { activePlanId: string | null; queuedIds: string[]; storageError: string | null; progress: ExecutionProgress | null }
export interface PlanListResult { records: PlanRecord[]; issues: string[] }
export interface PreviewProgress { requestId: string; percent: number; message: string }

/**
 * 降码画质 A/B 对比抽样画格数据契约 (Visual Compression Preview Sample)
 */
export interface PreviewSample {
  cacheLeaseId?: string;
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
