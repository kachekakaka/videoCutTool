import type { MediaMetadata } from './types';

export type StreamContainer = 'flv' | 'mpegts';
export interface StreamPlaybackSnapshot {
  id: string; url: string; container: StreamContainer;
  offsetMs: number; durationMs: number; indexedUntilMs: number; progress: number;
  complete: boolean; error?: string; metadata?: MediaMetadata;
  originUs: number; baseMs: number; frames?: number[];
  index: { times: number[]; filepositions: number[] };
}
export interface StreamFrameTarget {
  sourceMs: number; presentationMs: number; nextPresentationMs: number; atBoundary: boolean;
}
export function frameAt(points: number[], absoluteUs: number): number {
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid] <= absoluteUs) lo = mid + 1; else hi = mid; }
  return Math.max(0, lo - 1);
}
