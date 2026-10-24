import { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, nativeTheme, IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { ConfigService } from '../src/main/services/ConfigService';
import { KeyframeProber } from '../src/main/services/KeyframeProber';
import { MediaCuttingEngine } from '../src/main/services/MediaCuttingEngine';
import { PlanManager } from '../src/main/services/PlanManager';
import { BatchCompressionService } from '../src/main/services/BatchCompressionService';
import { CompressionPreviewService } from '../src/main/services/CompressionPreviewService';
import { PlaybackPreviewService } from '../src/main/services/PlaybackPreviewService';
import { StreamPlaybackSessionService } from '../src/main/services/StreamPlaybackSessionService';
import { CacheMaintenanceService, externalTemporaryDirectory as getExternalTmpDir } from '../src/main/services/CacheMaintenanceService';
import { MediaLimiter, stopMediaProcesses, clearProbeCache, hasActiveMediaProcesses, resolveTool, abortError } from '../src/main/services/MediaTools';
import { inspectRepairSource, repairToMp4 } from '../src/main/services/TimelineRepairService';
import { MediaIndexService } from '../src/main/services/MediaIndexService';
import { TimelineRepairProgress, TimelineRepairResult } from '../src/shared/timelineRepair';
import { FileAccessRegistry, localPath, requestId, textValue, validateCompress, validateConfigPatch, validateRecord } from '../src/main/services/IpcSecurity';
import { AppConfig, PlanRecord, CompressConfig, CompressionSaveRequest, SelectedVideo } from '../src/shared/types';

// 全局彻底移除应用菜单，防止 Windows 下用户按 Alt 键唤出原生菜单栏
Menu.setApplicationMenu(null);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 注册流媒体自定义协议特权
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

// 避免 Windows 下 Electron 默认 GPUCache / ShaderDiskCache 目录被锁导致拒绝访问与控制台红字报警
app.commandLine.appendSwitch('disable-gpu-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');
// 异常录像的损坏包会令部分硬件解码器终止播放；软件视频解码可容错，界面 GPU 加速保持启用。
app.commandLine.appendSwitch('disable-accelerated-video-decode');
app.enableSandbox();

// 强制原生深色沉浸主题
nativeTheme.themeSource = 'dark';

// 探测基准物理宿主目录（若直接运行了 app/VideoCutTool.exe，自适应向上退回至便携根目录）
const rawHostDir = process.env.VCT_WORKSPACE_DIR || process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd());
const hostDir = path.basename(rawHostDir).toLowerCase() === 'app' ? path.dirname(rawHostDir) : rawHostDir;

// 严格遵守绿色便携隔离规范：必须在 requestSingleInstanceLock 之前重定向 userData，彻底杜绝 APPDATA 污染与锁竞争
const externalUserData = path.resolve(getExternalTmpDir(hostDir), 'electron_userdata');
try {
  if (!fs.existsSync(externalUserData)) {
    fs.mkdirSync(externalUserData, { recursive: true });
  }
  app.setPath('userData', externalUserData);
  app.setPath('sessionData', externalUserData);
} catch (e) {
  console.warn('重定向 userData 目录异常:', e);
}

// 单实例互斥锁：在设置好便携数据目录后激活
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// 服务实例生命周期持有者
let configService: ConfigService;
let prober: KeyframeProber;
let cuttingEngine: MediaCuttingEngine;
let planManager: PlanManager;
let batchCompression: BatchCompressionService;
let previewService: CompressionPreviewService;
let playbackService: PlaybackPreviewService;
let streamPlayback: StreamPlaybackSessionService;
let maintenance: CacheMaintenanceService;

let mainWindow: BrowserWindow | null = null;
const files = new FileAccessRegistry();
const scanRequests = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
const repairRequests = new Map<string, { owner: number; controller: AbortController; promise: Promise<TimelineRepairResult> }>();
const repairConfirmations = new Map<string, (approved: boolean) => void>();
const canceledRequests = new Set<string>();
function markCanceled(key: string) { canceledRequests.add(key); if (canceledRequests.size > 256) canceledRequests.delete(canceledRequests.values().next().value!); }
function checkCanceled(key: string) { if (canceledRequests.delete(key)) throw new Error('操作已取消'); }
let configChanges: Promise<unknown> = Promise.resolve();
const ipcActive = new Map<string, number>();
const streamWindowGeneration = new WeakMap<IpcMainInvokeEvent['sender'], number>();
function handle(channel: string, work: (event: IpcMainInvokeEvent, ...args: any[]) => any) {
  ipcMain.handle(channel, async (event, ...args) => {
    const frame = event.senderFrame;
    if (!mainWindow || event.sender !== mainWindow.webContents || frame !== event.sender.mainFrame) throw new Error('拒绝非可信窗口请求');
    const url = new URL(frame.url);
    const trusted = process.env.VITE_DEV_SERVER_URL
      ? url.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin
      : url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === path.resolve(__dirname, '../dist/index.html');
    if (!trusted || quitting) throw new Error('请求来源无效或应用正在关闭');
    const count = ipcActive.get(channel) ?? 0;
    if (count >= 32 || args.length > (channel === 'config:resolveOutputPath' ? 7 : 6)) throw new Error('请求过于频繁，请稍后重试');
    ipcActive.set(channel, count + 1);
    const generation = streamWindowGeneration.get(event.sender) ?? 0;
    try {
      if (/^(media:|compress:|engine:submitDraft)/.test(channel)) await configChanges;
      if (['media:openStream', 'media:repairTimeline'].includes(channel) && generation !== (streamWindowGeneration.get(event.sender) ?? 0)) throw new Error('播放窗口已失效');
      return await work(event, ...args);
    } finally { ipcActive.set(channel, Math.max(0, (ipcActive.get(channel) ?? 1) - 1)); }
  });
}
function rememberPlanOutputs(records: PlanRecord[]) { for (const record of records) { maintenance?.protect(record.sourcePath, ...(record.outputPaths ?? []), ...(record.outputPath ? [record.outputPath] : [])); if (record.outputPath) files.allowReveal(record.outputPath); record.outputPaths?.forEach(file => files.allowReveal(file)); } }

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#0c0e14',
    show: true, // 核心修复：直接展示窗口，彻底避免 ready-to-show 漏发导致窗口在后台隐形常驻
    center: true,
    autoHideMenuBar: true,
    title: 'VideoCutTool - 无损视频裁剪工具',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#090b10', // 顶栏深色基调，完美浑然一体
      symbolColor: '#94a3b8', // 控制按钮图标颜色
      height: 38,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // 彻底禁用窗口原生菜单栏，彻底杜绝按 Alt 键浮现菜单
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const dev = process.env.VITE_DEV_SERVER_URL ? new URL(process.env.VITE_DEV_SERVER_URL).origin : '';
    const connect = dev ? `${dev} ${dev.replace(/^http/, 'ws')}` : '';
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [`default-src 'self'; script-src 'self' ${dev ? "'unsafe-inline' " + dev : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' media: data:; media-src 'self' media: blob:; connect-src 'self' media: ${connect}; object-src 'none'; frame-src 'none'; base-uri 'none'`] } });
  });

  const htmlPath = path.join(__dirname, '../dist/index.html');

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(htmlPath);
  }

  // 首帧渲染就绪后瞬间光滑呈现，彻底消除白屏与黑框闪烁
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 兜底防御：防止特定显卡或高负载环境下 ready-to-show 漏发导致窗口未显现
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }, 600);

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[Window Error] 页面加载失败:', errorCode, errorDescription);
  });
  const ownerPrefix = `${mainWindow.webContents.id}:`;
  const owner = mainWindow.webContents.id;
  const contents = mainWindow.webContents;
  const releaseWindowCaches = () => {
    streamWindowGeneration.set(contents, (streamWindowGeneration.get(contents) ?? 0) + 1);
    void previewService?.releaseOwner(ownerPrefix); void playbackService?.releaseOwner(ownerPrefix); streamPlayback?.closeOwner(owner);
    for (const request of repairRequests.values()) if (request.owner === owner) request.controller.abort();
  };
  mainWindow.webContents.on('render-process-gone', releaseWindowCaches);
  mainWindow.webContents.on('destroyed', releaseWindowCaches);
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) releaseWindowCaches(); });

  mainWindow.on('closed', () => {
    files.clear();
    scanRequests.forEach(request => request.controller.abort());
    compressionChecks.forEach(controller => controller.abort());
    mainWindow = null;
  });
  mainWindow.on('close', (event) => {
    if (!quitting && repairRequests.size) {
      const answer = dialog.showMessageBoxSync(mainWindow!, { type: 'question', title: '退出应用', message: '正在修复视频，退出会中断修复并回收临时文件。原片和已保存方案保持不变。', buttons: ['继续修复', '中断并退出'], defaultId: 0, cancelId: 0 });
      if (answer === 0) { event.preventDefault(); return; }
    }
    if (!quitting && cuttingEngine?.getState().activePlanId) {
      const answer = dialog.showMessageBoxSync(mainWindow!, { type: 'question', title: '退出应用', message: '正在导出视频，退出会中断当前任务。下次启动可在方案中心重试。', buttons: ['继续导出', '中断并退出'], defaultId: 0, cancelId: 0 });
      if (answer === 0) event.preventDefault();
    }
  });
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.mp4': return 'video/mp4';
    case '.mkv': return 'video/x-matroska';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.avi': return 'video/x-msvideo';
    case '.ts': return 'video/mp2t';
    case '.flv': return 'video/x-flv';
    default: return 'application/octet-stream';
  }
}

// 注册 IPC 通信
handle('config:get', async () => configService.getConfig());
handle('config:save', async (_event, patch: Partial<AppConfig>) => {
  validateConfigPatch(patch);
  const task = configChanges.then(async () => {
    const previous = configService.getConfig();
    const next = { ...previous, ...patch };
    const changed = previous.ffmpegPath !== next.ffmpegPath || previous.ffprobePath !== next.ffprobePath;
    if (changed) {
      for (const executable of [patch.ffmpegPath, patch.ffprobePath]) if (executable && !(await fs.promises.stat(executable)).isFile()) throw new Error('媒体工具路径不是文件');
      const answer = await dialog.showMessageBox(mainWindow!, { type: 'warning', title: '更换媒体处理工具', message: '应用将运行以下程序，请仅使用您信任的媒体工具。', detail: `FFmpeg：${next.ffmpegPath || '随包工具'}\nFFprobe：${next.ffprobePath || '随包工具'}`, buttons: ['取消', '使用这些工具'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) throw new Error('已取消更换媒体工具');
    }
    const config = configService.saveConfig(patch);
    if (changed) {
      await Promise.all([previewService.shutdown(), playbackService.shutdown()]);
      clearProbeCache(); prober.updateTool(config.ffprobePath);
      cuttingEngine.updateTools(config.ffmpegPath, config.ffprobePath);
      previewService.updateTools(config.ffmpegPath, config.ffprobePath);
      playbackService.updateTools(config.ffmpegPath, config.ffprobePath);
      streamPlayback.indexes.updateTool(config.ffprobePath);
    }
    mainWindow?.webContents.send('config:changed', config); return config;
  });
  configChanges = task.catch(() => {}); return task;
});
handle('config:getPath', async () => configService.getConfigPath());
handle('config:resolveOutputPath', async (_event, videoPath: string, isConcat: boolean = true, planTitle?: string, compress?: CompressConfig, stripCover?: boolean, streams: import('../src/shared/types').MediaStreamInfo[] = [], precision?: import('../src/shared/types').ExportPrecision) => {
  await files.check(videoPath); validateCompress(compress); if (planTitle) textValue(planTitle, '方案标题', 256);
  if (typeof isConcat !== 'boolean' || (stripCover !== undefined && typeof stripCover !== 'boolean')) throw new Error('输出选项无效');
  if (!Array.isArray(streams) || streams.length > 256 || streams.some(stream => !stream || typeof stream.type !== 'string' || typeof stream.codec !== 'string' || stream.type.length > 40 || stream.codec.length > 80 || typeof stream.attachedPicture !== 'boolean')) throw new Error('媒体流摘要无效');
  if (precision !== undefined && !['keyframe', 'frame'].includes(precision)) throw new Error('导出精度无效');
  const output = await configService.resolveSafeOutputPath(videoPath, isConcat, planTitle, compress, stripCover, streams, precision); files.allowReveal(output); return output;
});

handle('media:registerDroppedFile', async (_event, file: string) => files.authorize(file));
handle('media:probe', async (_event, filePath: string) => { await files.check(filePath); return prober.probe(filePath); });
handle('media:probeBasic', async (_event, filePath: string) => { await files.check(filePath); return prober.probeBasic(filePath); });
handle('media:probeKeyframes', async (event, filePath: string, id: string) => {
  requestId(id); const key = `${event.sender.id}:${id}`;
  if (scanRequests.has(key)) return scanRequests.get(key)!.promise;
  const controller = new AbortController();
  const promise = (async () => { await files.check(filePath); checkCanceled(`scan:${key}`); return prober.probeKeyframes(filePath, controller.signal); })().finally(() => scanRequests.delete(key));
  scanRequests.set(key, { controller, promise }); return promise;
});
handle('media:cancelKeyframes', async (event, id: string) => { requestId(id); const key = `${event.sender.id}:${id}`; markCanceled(`scan:${key}`); scanRequests.get(key)?.controller.abort(); });
handle('media:adjacentFrame', async (_event, file: string, time: number, direction: -1 | 1) => { await files.check(file); return prober.adjacentFrame(file, time, direction); });
handle('media:preparePlayback', async (event, file: string, convert: boolean, id: string) => {
  requestId(id); if (typeof convert !== 'boolean') throw new Error('播放选项无效'); await files.check(file);
  checkCanceled(`play:${event.sender.id}:${id}`);
  maintenance.protect(file);
  const key = `${event.sender.id}:${id}`;
  try {
    const result = await playbackService.prepare(file, convert, key, progress => { if (!event.sender.isDestroyed()) event.sender.send('media:previewProgress', { ...progress, requestId: id }); });
    if (event.sender.isDestroyed()) throw new Error('播放窗口已关闭');
    if (result.path) await files.authorize(result.path); return result;
  } catch (error) { playbackService.release(key); throw error; }
});
handle('media:cancelPlayback', async (event, id: string) => { requestId(id); markCanceled(`play:${event.sender.id}:${id}`); return playbackService.cancel(`${event.sender.id}:${id}`); });
handle('media:releasePlayback', async (event, id: string) => { requestId(id); playbackService.release(`${event.sender.id}:${id}`); });
handle('media:openStream', async (event, file: string, id: string) => {
  requestId(id);
  const frame = event.senderFrame;
  const generation = streamWindowGeneration.get(event.sender) ?? 0;
  await files.check(file);
  // 文件检查期间窗口可能已经崩溃或换页；此时 closeOwner 尚无会话可释放。
  // 必须在取得索引引用前拒绝迟到请求，不能在退出事件之后重新创建会话。
  if (generation !== (streamWindowGeneration.get(event.sender) ?? 0) || !frame || frame.isDestroyed() || event.sender.isDestroyed() || event.sender.isCrashed() || event.sender.mainFrame !== frame) throw new Error('播放窗口已失效');
  checkCanceled(`stream:${event.sender.id}:${id}`);
  return streamPlayback.open(event.sender.id, file, id);
});
handle('media:streamStatus', async (event, id: string) => { requestId(id); return streamPlayback.status(event.sender.id, id); });
handle('media:streamFrame', async (event, id: string, time: number, direction: -1 | 0 | 1) => { requestId(id); return streamPlayback.frame(event.sender.id, id, time, direction); });
handle('media:closeStream', async (event, id: string) => { requestId(id); markCanceled(`stream:${event.sender.id}:${id}`); streamPlayback.close(event.sender.id, id); });

handle('media:repairTimeline', (event, file: string, id: string) => {
  requestId(id);
  const key = `${event.sender.id}:${id}`;
  if (repairRequests.has(key)) return repairRequests.get(key)!.promise;
  if (repairRequests.size) throw new Error('已有时间轴修复任务，请等待完成或先取消');
  const controller = new AbortController(), generation = streamWindowGeneration.get(event.sender) ?? 0;
  const check = () => {
    if (controller.signal.aborted || quitting || event.sender.isDestroyed() || event.sender.isCrashed() || generation !== (streamWindowGeneration.get(event.sender) ?? 0)) throw abortError();
  };
  const progress = (value: Omit<TimelineRepairProgress, 'requestId'>) => { if (!event.sender.isDestroyed()) event.sender.send('media:repairProgress', { ...value, requestId: id }); };
  const promise = (async (): Promise<TimelineRepairResult> => {
    checkCanceled(`repair:${key}`); check();
    const source = await files.check(file); check();
    const config = configService.getConfig(), ffprobe = resolveTool('ffprobe', config.ffprobePath), ffmpeg = resolveTool('ffmpeg', config.ffmpegPath);
    progress({ stage: 'checking' });
    await inspectRepairSource(source, ffprobe, controller.signal); check();
    progress({ stage: 'choosing' });
    const selected = await dialog.showSaveDialog(mainWindow!, { title: '修复时间轴并另存为 MP4（不覆盖原片）', defaultPath: path.join(path.dirname(source), `${path.parse(source).name}_时间轴修复.mp4`), filters: [{ name: 'MP4 视频', extensions: ['mp4'] }] });
    check(); if (selected.canceled || !selected.filePath) return { canceled: true };
    const output = selected.filePath;
    if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('请选择新的 MP4 文件名');
    try { await fs.promises.lstat(output); throw new Error('目标文件已经存在，请另选文件名；不会覆盖原片或其他文件'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    check();
    // 路径留在主进程；界面只回答当前请求，确认后接续同一次修复，取消或窗口失效均解除等待。
    const approved = await new Promise<boolean>((resolve, reject) => {
      const clear = () => {
        repairConfirmations.delete(key);
        controller.signal.removeEventListener('abort', cancel);
      };
      const finish = (value: boolean) => { clear(); resolve(value); };
      const cancel = () => finish(false);
      repairConfirmations.set(key, finish);
      controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        progress({ stage: 'confirming' });
        event.sender.send('media:repairConfirmation', { requestId: id, source, output });
      } catch (error) { clear(); reject(error); }
    });
    check(); if (!approved) return { canceled: true };
    const result = await repairToMp4({ source, output, temporaryRoot: getExternalTmpDir(hostDir), ffmpeg, ffprobe, signal: controller.signal, maintenance, indexes: streamPlayback.indexes, progress });
    await files.authorize(result.output);
    return { output: result.output };
  })().catch(error => { if (controller.signal.aborted || error.name === 'AbortError') return { canceled: true }; throw error; }).finally(() => { repairConfirmations.delete(key); repairRequests.delete(key); });
  repairRequests.set(key, { owner: event.sender.id, controller, promise }); return promise;
});
handle('media:cancelRepair', (event, id: string) => { requestId(id); const key = `${event.sender.id}:${id}`; markCanceled(`repair:${key}`); repairRequests.get(key)?.controller.abort(); });
handle('media:confirmRepair', (event, id: string, approved: boolean) => {
  requestId(id);
  if (typeof approved !== 'boolean') throw new Error('修复确认选项无效');
  const confirm = repairConfirmations.get(`${event.sender.id}:${id}`);
  if (!confirm) throw new Error('修复确认已失效，请重新开始');
  confirm(approved);
});

// 降码画质抽样对比与硬件探测
handle('compress:previewSamples', async (event, videoPath: string, timestampsMs: number[], config: CompressConfig, id: string) => {
  requestId(id); validateCompress(config); await files.check(videoPath);
  checkCanceled(`compare:${event.sender.id}:${id}`);
  if (!Array.isArray(timestampsMs) || timestampsMs.length > 5 || !timestampsMs.length || timestampsMs.some(time => !Number.isFinite(time) || time < 0)) throw new Error('抽样时间点无效');
  maintenance.protect(videoPath);
  const key = `${event.sender.id}:${id}`;
  try {
    const result = await previewService.generatePreviewSamples(videoPath, timestampsMs, config, key);
    if (event.sender.isDestroyed()) throw new Error('预览窗口已关闭');
    await Promise.all(result.flatMap(sample => [sample.originalUrl!, sample.compressedUrl!]).map(url => files.authorize(new URL(url).searchParams.get('path')!))); return result.map(sample => ({ ...sample, cacheLeaseId: id }));
  } catch (error) { previewService.release(key); throw error; }
});
handle('compress:cancelPreview', async (event, id: string) => { requestId(id); markCanceled(`compare:${event.sender.id}:${id}`); return previewService.cancel(`${event.sender.id}:${id}`); });
handle('compress:releasePreview', async (event, id: string) => { requestId(id); previewService.release(`${event.sender.id}:${id}`); });
handle('compress:probeEncoder', async (_event, config?: CompressConfig) => { validateCompress(config); return cuttingEngine.probeEncoderSupport(config); });

// 剪辑引擎与后台任务
handle('engine:submitDraft', async (_event, record: PlanRecord) => { validateRecord(record); await files.check(record.sourcePath); return planManager.submitDraft(record); });

handle('plan:list', async () => { const records = await planManager.listPlans(); rememberPlanOutputs(records); return records; });
handle('plan:details', async () => { const result = await planManager.details(); rememberPlanOutputs(result.records); return result; });
handle('plan:refresh', async () => { const result = await planManager.refreshPlans(); rememberPlanOutputs(result.records); return result; });
handle('plan:load', async (_event, id: string) => { requestId(id); const record = await planManager.getPlan(id); if (!record) throw new Error('方案不存在'); await files.authorize(record.sourcePath); return record; });
handle('plan:sourceBinding', async (_event, id: string) => { requestId(id); const result = await planManager.sourceBinding(id); await files.authorize(result.record.sourcePath); return result; });
handle('plan:confirmSource', async (_event, id: string, token: string) => { requestId(id); requestId(token); return planManager.confirmSource(id, token); });
handle('engine:state', async () => cuttingEngine.getState());
handle('engine:retryPendingWrites', async () => cuttingEngine.retryPendingWrites());
handle('plan:save', async (_event, record: PlanRecord) => { validateRecord(record); await files.check(record.sourcePath); return planManager.savePlan(record); });
handle('plan:delete', async (_event, id: string) => { requestId(id); return planManager.deletePlan(id); });
handle('plan:execute', async (_event, id: string) => { requestId(id); return planManager.executePlan(id); });
handle('plan:executeSelected', async (_event, ids: string[]) => {
  if (!Array.isArray(ids) || ids.length > 10000) throw new Error('方案选择无效');
  ids.forEach(id => requestId(id)); return planManager.executeSelected(ids);
});
const compressionChecks = new Map<string, AbortController>();
handle('compress:inspectFile', async (event, file: string, id: string) => {
  requestId(id); const key = `${event.sender.id}:${id}`;
  checkCanceled(`compression:${key}`);
  if (compressionChecks.has(key)) throw new Error('检查请求已存在');
  const controller = new AbortController(); compressionChecks.set(key, controller);
  try { return await batchCompression.inspect(file, controller.signal); }
  finally { compressionChecks.delete(key); }
});
handle('compress:cancelInspection', async (event, id: string) => {
  requestId(id); const key = `${event.sender.id}:${id}`;
  markCanceled(`compression:${key}`); compressionChecks.get(key)?.abort();
});
handle('compress:savePlan', async (_event, request: CompressionSaveRequest) => batchCompression.save(request));
handle('plan:batchExecute', async () => planManager.batchExecute());
handle('shell:showItemInFolder', async (_event, fullPath: string) => {
  if (!fullPath) return;
  files.checkReveal(fullPath);
  try {
    if (fs.existsSync(fullPath)) {
      shell.showItemInFolder(fullPath);
    } else {
      const dir = path.extname(fullPath) ? path.dirname(fullPath) : fullPath;
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) await shell.openPath(dir);
    }
  } catch (err) {
    console.error('打开目录失败:', err);
  }
});

handle('dialog:openVideos', async () => {
  const options: Electron.OpenDialogOptions = { title: '选择待压缩视频', properties: ['openFile', 'multiSelections', 'dontAddToRecent'], filters: [{ name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'avi', 'flv', 'ts', 'webm'] }, { name: '所有文件', extensions: ['*'] }] };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  const selected: SelectedVideo[] = [];
  for (const file of result.canceled ? [] : result.filePaths) {
    try { selected.push({ path: await files.authorize(file) }); }
    catch (error) { selected.push({ path: file, error: String(error) }); }
  }
  return selected;
});

handle('dialog:openVideo', async () => {
  try {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const dialogOptions = {
      title: '选择待裁剪视频',
      properties: ['openFile', 'dontAddToRecent'] as ('openFile' | 'dontAddToRecent')[],
      filters: [
        { name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'avi', 'flv', 'ts', 'webm'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    };
    const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return await files.authorize(result.filePaths[0]);
  } catch (err) {
    console.error('打开文件对话框失败:', err);
    throw err;
  }
});

handle('dialog:selectDirectory', async (_event, defaultPath?: string) => {
  if (defaultPath) localPath(defaultPath);
  try {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const dialogOptions = {
      title: '选择输出目录',
      defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const result = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  } catch (err) {
    console.error('打开目录选择对话框失败:', err);
    return null;
  }
});

app.whenReady().then(async () => {
  // 1. 获取物理宿主目录
  const exeDir = hostDir;

  // 2. 探测同级目录是否已配置有效数据目录
  const resolution = ConfigService.resolveDataDirectory(exeDir);
  let effectiveDataDir = resolution.dataDir;

  if (!effectiveDataDir) {
    const result = await dialog.showOpenDialog({
      title: '请选择 VideoCutTool 工作数据存储目录（存放配置与剪辑方案）',
      message: '请选择一个用于保存配置与剪辑方案（plans/）的文件夹：',
      buttonLabel: '选择此目录',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      dialog.showErrorBox(
        '初始化未完成',
        '必须指定一个工作数据目录以保存您的配置与方案记录。程序将安全退出。'
      );
      app.quit();
      return;
    }

    const chosenDir = result.filePaths[0];
    configService = ConfigService.setupDataDirectory(exeDir, chosenDir);
  } else {
    configService = new ConfigService(effectiveDataDir);
  }

  const currentConfig = configService.getConfig();
  const tempSlicesDir = path.resolve(getExternalTmpDir(exeDir), 'slices');
  const tempPreviewDir = path.resolve(getExternalTmpDir(exeDir), 'preview_cache');
  maintenance = new CacheMaintenanceService(path.join(getExternalTmpDir(exeDir), '.cache-maintenance'), { busy: () => Boolean(cuttingEngine?.getActivePlanId()) || hasActiveMediaProcesses() });
  maintenance.protect(configService.getConfigPath(), path.join(configService.getDataDirectory(), 'plans'), path.join(exeDir, 'workspace.json'));
  const mediaIndexes = new MediaIndexService(configService.getDataDirectory(), maintenance, currentConfig.ffprobePath);
  prober = mediaIndexes.prober;
  cuttingEngine = new MediaCuttingEngine(currentConfig.ffmpegPath, tempSlicesDir, undefined, undefined, maintenance);
  cuttingEngine.updateTools(currentConfig.ffmpegPath, currentConfig.ffprobePath);
  cuttingEngine.setInputProvider((file, signal) => prober.input(file, signal));
  planManager = new PlanManager(configService.getDataDirectory(), cuttingEngine, prober);
  batchCompression = new BatchCompressionService(configService, planManager, files);
  const previewLimiter = new MediaLimiter(() => cuttingEngine.getActivePlanId() ? 1 : 2);
  previewService = new CompressionPreviewService(currentConfig.ffmpegPath, tempPreviewDir, (config, signal) => cuttingEngine.probeEncoderSupport(config, signal), previewLimiter, maintenance);
  previewService.updateTools(currentConfig.ffmpegPath, currentConfig.ffprobePath);
  playbackService = new PlaybackPreviewService(path.resolve(getExternalTmpDir(exeDir), 'playback_cache'), currentConfig.ffmpegPath, currentConfig.ffprobePath, previewLimiter, maintenance);
  streamPlayback = new StreamPlaybackSessionService(mediaIndexes.streams);
  planManager.setChangeListener(change => { if (change.record) rememberPlanOutputs([change.record]); mainWindow?.webContents.send('plan:changed', change); });
  cuttingEngine.setStateListener(state => mainWindow?.webContents.send('engine:stateChanged', state));
  await planManager.ready;

  // 绑定引擎状态变动至渲染层窗口广播
  cuttingEngine.setStatusListener((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('plan:statusChanged', event);
      if (event.status === 'completed') {
        mainWindow.webContents.send('plan:completed', event);
      }
    }
  });

  // 注册本地流媒体协议: media://video?path=...
  protocol.handle('media', async (request) => {
    try {
      const parsed = new URL(request.url);
      if (parsed.hostname === 'stream') {
        // 媒体协议没有 senderFrame，绑定当前可信窗口及其随机会话；子框架已由 CSP 禁止。
        if (!mainWindow || mainWindow.webContents.isDestroyed()) return new Response(null, { status: 403 });
        return streamPlayback.respond(mainWindow.webContents.id, request);
      }
      let filePath = parsed.searchParams.get('path');

      if (!filePath) {
        const raw = decodeURIComponent(parsed.pathname || request.url.replace(/^media:\/\//, ''));
        filePath = raw.replace(/^\/([a-zA-Z]:)/, '$1').replace(/^([a-zA-Z])\//, '$1:/');
      }

      if (!filePath) {
        console.error('未找到流媒体物理文件:', filePath);
        return new Response('File Not Found', { status: 404 });
      }

      filePath = await files.check(filePath);
      const stat = await fs.promises.stat(filePath);
      const totalSize = stat.size;
      const mimeType = getMimeType(filePath);
      const rangeHeader = request.headers.get('range');

      if (rangeHeader) {
        const match = /bytes=(\d+)-(\d+)?/.exec(rangeHeader);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

          if (start >= totalSize || start > end) {
            return new Response('Requested Range Not Satisfiable', {
              status: 416,
              headers: {
                'Content-Range': `bytes */${totalSize}`,
              },
            });
          }

          const validEnd = Math.min(end, totalSize - 1);
          const chunkSize = validEnd - start + 1;
          const release = await maintenance.pin(filePath);
          const nodeStream = fs.createReadStream(filePath, { start, end: validEnd });
          nodeStream.once('close', release); nodeStream.once('error', release);
          const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

          return new Response(webStream, {
            status: 206,
            statusText: 'Partial Content',
            headers: {
              'Content-Range': `bytes ${start}-${validEnd}/${totalSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': chunkSize.toString(),
              'Content-Type': mimeType,
            },
          });
        }
      }

      const release = await maintenance.pin(filePath);
      const nodeStream = fs.createReadStream(filePath);
      nodeStream.once('close', release); nodeStream.once('error', release);
      const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

      return new Response(webStream, {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': totalSize.toString(),
          'Content-Type': mimeType,
        },
      });
    } catch (err) {
      console.error('加载本地流媒体异常:', err, request.url);
      return new Response('Error', { status: 500 });
    }
  });

  createWindow();
  void maintenance.discover().then(async () => { rememberPlanOutputs(await planManager.listPlans()); maintenance.start(); }).catch(error => console.warn('缓存维护启动失败：', error));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(error => {
  dialog.showErrorBox('启动失败', `无法初始化应用或工作数据目录：${error instanceof Error ? error.message : String(error)}`);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let quitting = false;
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  void (async () => {
    scanRequests.forEach(request => request.controller.abort());
    compressionChecks.forEach(controller => controller.abort());
    repairRequests.forEach(request => request.controller.abort());
    await Promise.allSettled([...repairRequests.values()].map(request => request.promise));
    await Promise.allSettled([previewService?.shutdown(), playbackService?.shutdown(), streamPlayback?.shutdown(), prober?.shutdown(), cuttingEngine?.shutdown(), stopMediaProcesses()]);
    await stopMediaProcesses();
    await maintenance?.close();
    app.quit();
  })();
});
