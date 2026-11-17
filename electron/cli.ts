import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { randomUUID } from 'crypto';
import { format } from 'util';
import { helpText, parseArguments } from '../src/main/cli/arguments';
import { ProcessingError, ProcessingResult } from '../src/shared/processingTask';

export async function startCli() {
  // 先安装日志，再动态加载业务服务，最终结果只使用独立 stdout 写入。
  for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) console[level] = (...args: unknown[]) => { process.stderr.write(format(...args) + '\n'); };
  let runtime: import('../src/main/services/ProcessingRuntime').ProcessingRuntime | undefined;
  let lock: Awaited<ReturnType<typeof import('../src/main/cli/DataDirectory')['acquireCliDirectory']>> | undefined;
  let runtimeDirectory: string | undefined;
  let result: ProcessingResult;
  const controller = new AbortController();
  let control: net.Socket | undefined;
  let controlBuffer = '';
  const onControl = (chunk: string) => {
    controlBuffer += chunk;
    if (controlBuffer.length > 1024) { controller.abort(); return; }
    while (controlBuffer.includes('\n')) {
      const index = controlBuffer.indexOf('\n'); const message = controlBuffer.slice(0, index).trim(); controlBuffer = controlBuffer.slice(index + 1);
      if (message === 'VCT_CANCEL') controller.abort();
      else if (message) controller.abort();
    }
  };
  process.on('SIGINT', () => controller.abort());
  try {
    const parsed = parseArguments(process.argv.slice(process.argv.indexOf('--vct-cli') + 1));
    if (parsed.kind !== 'task') {
      await new Promise<void>(resolve => process.stdout.write((parsed.kind === 'help' ? helpText : app.getVersion()) + '\n', 'utf8', () => resolve()));
      app.exit(0); return;
    }
    // Windows Electron 的 process.stdin 是空占位流；直接把继承的 fd 0 包装为异步管道。
    control = new net.Socket({ fd: 0, readable: true, writable: false });
    control.setEncoding('utf8'); control.on('data', onControl);
    control.on('end', () => { console.warn('启动器控制管道已断开，停止本次任务'); controller.abort(); });
    control.on('error', error => { console.warn('启动器控制管道读取失败', error); controller.abort(); });
    const rawHost = process.env.VCT_WORKSPACE_DIR || (app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd());
    const host = path.basename(rawHost).toLowerCase() === 'app' ? path.dirname(rawHost) : rawHost;
    const runtimeId = process.env.VCT_CLI_RUNTIME_ID;
    if (runtimeId && !/^[a-f0-9-]{36}$/i.test(runtimeId)) throw new Error('CLI 运行目录标识无效');
    runtimeDirectory = path.resolve(host, '../videoCutTool_tmp', 'cli-runtime', runtimeId || randomUUID());
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    app.setPath('userData', runtimeDirectory); app.setPath('sessionData', runtimeDirectory);
    app.disableHardwareAcceleration();
    const { acquireCliDirectory } = await import('../src/main/cli/DataDirectory');
    lock = await acquireCliDirectory(parsed.dataDirectory);
    await app.whenReady();
    const { ConfigService } = await import('../src/main/services/ConfigService');
    const { ProcessingRuntime } = await import('../src/main/services/ProcessingRuntime');
    const { runTask } = await import('../src/main/cli/run');
    let config: InstanceType<typeof ConfigService>;
    try { config = new ConfigService(lock.directory, undefined, 'cli'); }
    catch (error) { throw new ProcessingError('STORAGE_FAILED', `CLI 配置保存失败：${String(error)}`, 5); }
    runtime = new ProcessingRuntime({ config, registryDirectory: path.join(lock.directory, '.cache-maintenance'), startupPolicy: 'new-only' });
    await runtime.maintenance.discover();
    result = await runTask(runtime, parsed.request, controller.signal);
  } catch (error) {
    result = { ok: false, status: 'failed', outputPaths: [], error: { code: error instanceof ProcessingError ? error.code : 'PRECHECK_FAILED', message: error instanceof Error ? error.message : String(error) } };
  }
  const cleanupErrors: string[] = [];
  try { await runtime?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  // 打包入口在 Electron 完全退出后由启动器清理，避免 Chromium 退出时重新写回 Local State。
  try { if (runtimeDirectory && !process.env.VCT_CLI_RUNTIME_ID) await fs.promises.rm(runtimeDirectory, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(String(error)); }
  try { await lock?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  control?.destroy();
  if (cleanupErrors.length) {
    if (result.error) result.error.details = [...(result.error.details || []), ...cleanupErrors];
    if (result.error?.code !== 'STORAGE_FAILED') result = { ...result, ok: false, status: 'failed', error: { code: 'CLEANUP_FAILED', message: '收尾未完成', details: cleanupErrors } };
  }
  const { writeResult } = await import('../src/main/cli/run');
  app.exit(await writeResult(result));
}
