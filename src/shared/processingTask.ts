import type { CompressConfig, ExecutionProgress } from './types';

export type ProcessingRequest = {
  operation: 'compress' | 'cut';
  inputPath: string;
  outputPath: string;
  stripCover: boolean;
  compress?: CompressConfig;
  ranges?: Array<{ startMs: number; endMs: number }>;
};
export interface ProcessingResult {
  ok: boolean;
  taskId?: string;
  operation?: ProcessingRequest['operation'];
  status: 'completed' | 'failed' | 'cancelled';
  outputPaths: string[];
  resolvedEncoder?: 'cpu' | 'nvenc' | 'qsv';
  warnings?: string[];
  error?: { code: string; message: string; details?: string[] };
  requestedOutputPath?: string;
  outcomeUnknown?: boolean;
}
export type ProcessingProgress = ExecutionProgress;
export class ProcessingError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 3) { super(message); }
}
export function resultExitCode(result: ProcessingResult): number {
  if (result.ok) return 0;
  if (result.status === 'cancelled') return 130;
  if (result.error?.code === 'INVALID_ARGUMENT') return 2;
  if (result.error?.code === 'DIRECTORY_BUSY') return 4;
  return ['STORAGE_FAILED', 'PROCESS_EXITED', 'PROTOCOL_ERROR', 'CLEANUP_TIMEOUT', 'CLEANUP_FAILED', 'EXECUTION_FAILED'].includes(result.error?.code || '') ? 5 : 3;
}
