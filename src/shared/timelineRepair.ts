export interface TimelineRepairProgress {
  requestId: string;
  stage: 'checking' | 'choosing' | 'confirming' | 'scanning' | 'remuxing' | 'validating' | 'copying' | 'publishing';
  percent?: number;
}
export interface TimelineRepairResult { output?: string; canceled?: boolean }
export interface TimelineRepairConfirmation { requestId: string; source: string; output: string }
