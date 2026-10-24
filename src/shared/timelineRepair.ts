export interface TimelineRepairProgress {
  requestId: string;
  stage: 'checking' | 'choosing' | 'scanning' | 'remuxing' | 'validating' | 'copying' | 'publishing';
  percent?: number;
}
export interface TimelineRepairResult { output?: string; canceled?: boolean }
