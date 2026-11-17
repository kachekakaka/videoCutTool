import { format } from 'util';
import { ProcessingResult, resultExitCode } from '../../shared/processingTask';
import { ProcessingTaskService } from '../services/ProcessingTaskService';
import { ProcessingRuntime } from '../services/ProcessingRuntime';
import type { ProcessingRequest } from '../../shared/processingTask';

export function installCliLogging() {
  for (const name of ['log', 'info', 'debug', 'warn', 'error'] as const) console[name] = (...args: unknown[]) => { process.stderr.write(format(...args) + '\n'); };
}
export async function runTask(runtime: ProcessingRuntime, request: ProcessingRequest, signal: AbortSignal): Promise<ProcessingResult> {
  const service = new ProcessingTaskService(runtime);
  const cancel = () => service.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let lastProgress = 0;
  service.subscribeProgress(progress => { if (Date.now() - lastProgress >= 500) { lastProgress = Date.now(); process.stderr.write(JSON.stringify({ progress }) + '\n'); } });
  try { return await service.submit(request); } finally { signal.removeEventListener('abort', cancel); }
}
export async function writeResult(result: ProcessingResult) {
  await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(result) + '\n', 'utf8', error => error ? reject(error) : resolve()));
  return resultExitCode(result);
}
