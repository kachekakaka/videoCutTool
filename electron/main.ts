import { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, nativeTheme, IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { ConfigService } from '../src/main/services/ConfigService';
import { KeyframeProber } from '../src/main/services/KeyframeProber';
import { MediaCuttingEngine } from '../src/main/services/MediaCuttingEngine';
import { PlanManager } from '../src/main/services/PlanManager';
import { CompressionPreviewService } from '../src/main/services/CompressionPreviewService';
import { PlaybackPreviewService } from '../src/main/services/PlaybackPreviewService';
import { MediaLimiter, stopMediaProcesses, clearProbeCache } from '../src/main/services/MediaTools';
import { FileAccessRegistry, localPath, requestId, textValue, validateCompress, validateConfigPatch, validateRecord } from '../src/main/services/IpcSecurity';
import { AppConfig, PlanRecord, CompressConfig } from '../src/shared/types';

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
app.enableSandbox();

// 强制原生深色沉浸主题
nativeTheme.themeSource = 'dark';

// 探测基准物理宿主目录（若直接运行了 app/VideoCutTool.exe，自适应向上退回至便携根目录）
const rawHostDir = process.env.VCT_WORKSPACE_DIR || process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd());
const hostDir = path.basename(rawHostDir).toLowerCase() === 'app' ? path.dirname(rawHostDir) : rawHostDir;

// 绿色临时目录解析：若宿主位于开发打包输出的 release/ 目录内，向上退两级与仓库同级的外部 tmp 对齐
function getExternalTmpDir(baseDir: string): string {
  if (path.basename(baseDir).toLowerCase() === 'release') {
    return path.resolve(baseDir, '../../videoCutTool_tmp');
  }
  return path.resolve(baseDir, '../videoCutTool_tmp');
}

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
let previewService: CompressionPreviewService;
let playbackService: PlaybackPreviewService;

let mainWindow: BrowserWindow | null = null;
const files = new FileAccessRegistry();
const scanRequests = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
const canceledRequests = new Set<string>();
function markCanceled(key: string) { canceledRequests.add(key); if (canceledRequests.size > 256) canceledRequests.delete(canceledRequests.values().next().value!); }
function checkCanceled(key: string) { if (canceledRequests.delete(key)) throw new Error('操作已取消'); }
let configChanges: Promise<unknown> = Promise.resolve();
const ipcActive = new Map<string, number>();
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
    if (count >= 32 || args.length > 6) throw new Error('请求过于频繁，请稍后重试');
    ipcActive.set(channel, count + 1);
    try {
      if (/^(media:|compress:|engine:submitDraft)/.test(channel)) await configChanges;
      return await work(event, ...args);
    } finally { ipcActive.set(channel, Math.max(0, (ipcActive.get(channel) ?? 1) - 1)); }
  });
}
function rememberPlanOutputs(records: PlanRecord[]) { for (const record of records) { files.allowReveal(record.outputPath); record.outputPaths?.forEach(file => files.allowReveal(file)); } }

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
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [`default-src 'self'; script-src 'self' ${dev ? "'unsafe-inline' " + dev : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' media: data:; media-src 'self' media:; connect-src 'self' media: ${connect}; object-src 'none'; frame-src 'none'; base-uri 'none'`] } });
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

  mainWindow.on('closed', () => {
    files.clear();
    scanRequests.forEach(request => request.controller.abort());
    mainWindow = null;
  });
  mainWindow.on('close', (event) => {
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
    }
    mainWindow?.webContents.send('config:changed', config); return config;
  });
  configChanges = task.catch(() => {}); return task;
});
handle('config:getPath', async () => configService.getConfigPath());
handle('config:resolveOutputPath', async (_event, videoPath: string, isConcat: boolean = true, planTitle?: string, compress?: CompressConfig, stripCover?: boolean) => {
  await files.check(videoPath); validateCompress(compress); if (planTitle) textValue(planTitle, '方案标题', 256);
  if (typeof isConcat !== 'boolean' || (stripCover !== undefined && typeof stripCover !== 'boolean')) throw new Error('输出选项无效');
  const output = await configService.resolveSafeOutputPath(videoPath, isConcat, planTitle, compress, stripCover); files.allowReveal(output); return output;
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
  const result = await playbackService.prepare(file, convert, `${event.sender.id}:${id}`, progress => { if (!event.sender.isDestroyed()) event.sender.send('media:previewProgress', { ...progress, requestId: id }); });
  if (result.path) await files.authorize(result.path); return result;
});
handle('media:cancelPlayback', async (event, id: string) => { requestId(id); markCanceled(`play:${event.sender.id}:${id}`); return playbackService.cancel(`${event.sender.id}:${id}`); });

// 降码画质抽样对比与硬件探测
handle('compress:previewSamples', async (event, videoPath: string, timestampsMs: number[], config: CompressConfig, id: string) => {
  requestId(id); validateCompress(config); await files.check(videoPath);
  checkCanceled(`compare:${event.sender.id}:${id}`);
  if (!Array.isArray(timestampsMs) || timestampsMs.length > 5 || !timestampsMs.length || timestampsMs.some(time => !Number.isFinite(time) || time < 0)) throw new Error('抽样时间点无效');
  const result = await previewService.generatePreviewSamples(videoPath, timestampsMs, config, `${event.sender.id}:${id}`);
  await Promise.all(result.flatMap(sample => [sample.originalUrl!, sample.compressedUrl!]).map(url => files.authorize(new URL(url).searchParams.get('path')!))); return result;
});
handle('compress:cancelPreview', async (event, id: string) => { requestId(id); markCanceled(`compare:${event.sender.id}:${id}`); return previewService.cancel(`${event.sender.id}:${id}`); });
handle('compress:probeEncoder', async (_event, config?: CompressConfig) => { validateCompress(config); return cuttingEngine.probeEncoderSupport(config); });

// 剪辑引擎与后台任务
handle('engine:submitDraft', async (_event, record: PlanRecord) => { validateRecord(record); await files.check(record.sourcePath); return planManager.submitDraft(record); });

handle('plan:list', async () => { const records = await planManager.listPlans(); rememberPlanOutputs(records); return records; });
handle('plan:details', async () => { const result = await planManager.details(); rememberPlanOutputs(result.records); return result; });
handle('plan:refresh', async () => { const result = await planManager.refreshPlans(); rememberPlanOutputs(result.records); return result; });
handle('plan:load', async (_event, id: string) => { requestId(id); const record = await planManager.getPlan(id); if (!record) throw new Error('方案不存在'); await files.authorize(record.sourcePath); return record; });
handle('engine:state', async () => cuttingEngine.getState());
handle('engine:retryPendingWrites', async () => cuttingEngine.retryPendingWrites());
handle('plan:save', async (_event, record: PlanRecord) => { validateRecord(record); await files.check(record.sourcePath); return planManager.savePlan(record); });
handle('plan:delete', async (_event, id: string) => { requestId(id); return planManager.deletePlan(id); });
handle('plan:execute', async (_event, id: string) => { requestId(id); return planManager.executePlan(id); });
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
  prober = new KeyframeProber(currentConfig.ffprobePath, exeDir);
  cuttingEngine = new MediaCuttingEngine(currentConfig.ffmpegPath, tempSlicesDir);
  cuttingEngine.updateTools(currentConfig.ffmpegPath, currentConfig.ffprobePath);
  planManager = new PlanManager(configService.getDataDirectory(), cuttingEngine, prober);
  const previewLimiter = new MediaLimiter(() => cuttingEngine.getActivePlanId() ? 1 : 2);
  previewService = new CompressionPreviewService(currentConfig.ffmpegPath, tempPreviewDir, (config, signal) => cuttingEngine.probeEncoderSupport(config, signal), previewLimiter);
  previewService.updateTools(currentConfig.ffmpegPath, currentConfig.ffprobePath);
  playbackService = new PlaybackPreviewService(path.resolve(getExternalTmpDir(exeDir), 'playback_cache'), currentConfig.ffmpegPath, currentConfig.ffprobePath, previewLimiter);
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
          const nodeStream = fs.createReadStream(filePath, { start, end: validEnd });
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

      const nodeStream = fs.createReadStream(filePath);
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
    await Promise.allSettled([previewService?.shutdown(), playbackService?.shutdown(), prober?.shutdown(), cuttingEngine?.shutdown(), stopMediaProcesses()]);
    await stopMediaProcesses();
    app.quit();
  })();
});
