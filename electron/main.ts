import { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, nativeTheme } from 'electron';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { ConfigService } from '../src/main/services/ConfigService';
import { KeyframeProber } from '../src/main/services/KeyframeProber';
import { MediaCuttingEngine } from '../src/main/services/MediaCuttingEngine';
import { PlanManager } from '../src/main/services/PlanManager';
import { CompressionPreviewService } from '../src/main/services/CompressionPreviewService';
import { AppConfig, PlanRecord, CompressConfig } from '../src/shared/types';

// 全局彻底移除应用菜单，防止 Windows 下用户按 Alt 键唤出原生菜单栏
Menu.setApplicationMenu(null);

// 单实例互斥锁：防止连击或多次双击导致多进程并发与目录写冲突
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

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
app.commandLine.appendSwitch('no-sandbox');

// 强制原生深色沉浸主题
nativeTheme.themeSource = 'dark';

// 探测基准物理宿主目录
const hostDir = process.env.VCT_WORKSPACE_DIR || process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd());

// 绿色临时目录解析：若宿主位于开发打包输出的 release/ 目录内，向上退两级与仓库同级的外部 tmp 对齐
function getExternalTmpDir(baseDir: string): string {
  if (path.basename(baseDir).toLowerCase() === 'release') {
    return path.resolve(baseDir, '../../videoCutTool_tmp');
  }
  return path.resolve(baseDir, '../videoCutTool_tmp');
}

// 严格遵守绿色便携隔离规范：将 Chromium 运行时数据与缓存导向外部临时目录，彻底杜绝 C 盘 APPDATA 与 TEMP 污染
const externalUserData = path.resolve(getExternalTmpDir(hostDir), 'electron_userdata');
try {
  if (!fs.existsSync(externalUserData)) {
    fs.mkdirSync(externalUserData, { recursive: true });
  }
  app.setPath('userData', externalUserData);
} catch (e) {
  console.warn('重定向 userData 目录异常:', e);
}

// 服务实例生命周期持有者
let configService: ConfigService;
let prober: KeyframeProber;
let cuttingEngine: MediaCuttingEngine;
let planManager: PlanManager;
let previewService: CompressionPreviewService;

let mainWindow: BrowserWindow | null = null;

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
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
    show: false, // 初始不展示，待 ready-to-show 光滑渲染完毕后显现
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
      sandbox: false,
    },
  });

  // 彻底禁用窗口原生菜单栏，彻底杜绝按 Alt 键浮现菜单
  mainWindow.setMenu(null);

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
    mainWindow = null;
  });
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
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
ipcMain.handle('config:get', async () => configService.getConfig());
ipcMain.handle('config:save', async (_event, newConfig: Partial<AppConfig>) => configService.saveConfig(newConfig));
ipcMain.handle('config:getPath', async () => configService.getConfigPath());
ipcMain.handle('config:resolveOutputPath', async (_event, videoPath: string, isConcat: boolean = true, planTitle?: string) => configService.resolveSafeOutputPath(videoPath, isConcat, planTitle));

ipcMain.handle('media:probe', async (_event, filePath: string) => prober.probe(filePath));
ipcMain.handle('media:probeBasic', async (_event, filePath: string) => prober.probeBasic(filePath));
ipcMain.handle('media:probeKeyframes', async (_event, filePath: string) => prober.probeKeyframes(filePath));

// 降码画质抽样对比与硬件探测
ipcMain.handle('compress:previewSamples', async (_event, videoPath: string, timestampsMs: number[], config: CompressConfig) => {
  return previewService.generatePreviewSamples(videoPath, timestampsMs, config);
});
ipcMain.handle('compress:probeEncoder', async () => cuttingEngine.probeEncoderSupport());

// 剪辑引擎与后台任务
ipcMain.handle('engine:submitDraft', async (_event, record: PlanRecord) => planManager.submitDraft(record));

ipcMain.handle('plan:list', async () => planManager.listPlans());
ipcMain.handle('plan:save', async (_event, record: PlanRecord) => planManager.savePlan(record));
ipcMain.handle('plan:delete', async (_event, id: string) => planManager.deletePlan(id));
ipcMain.handle('plan:execute', async (_event, id: string) => planManager.executePlan(id));
ipcMain.handle('plan:batchExecute', async () => planManager.batchExecute());
ipcMain.handle('shell:showItemInFolder', async (_event, fullPath: string) => {
  if (!fullPath) return;
  try {
    if (fs.existsSync(fullPath)) {
      shell.showItemInFolder(fullPath);
    } else {
      const dir = path.extname(fullPath) ? path.dirname(fullPath) : fullPath;
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      shell.openPath(dir);
    }
  } catch (err) {
    console.error('打开目录失败:', err);
  }
});

ipcMain.handle('dialog:openVideo', async () => {
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
    return result.filePaths[0];
  } catch (err) {
    console.error('打开文件对话框失败:', err);
    return null;
  }
});

ipcMain.handle('dialog:selectDirectory', async (_event, defaultPath?: string) => {
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
  planManager = new PlanManager(configService.getDataDirectory(), cuttingEngine, prober);
  previewService = new CompressionPreviewService(currentConfig.ffmpegPath, tempPreviewDir);

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
  protocol.handle('media', (request) => {
    try {
      const parsed = new URL(request.url);
      let filePath = parsed.searchParams.get('path');

      if (!filePath) {
        const raw = decodeURIComponent(parsed.pathname || request.url.replace(/^media:\/\//, ''));
        filePath = raw.replace(/^\/([a-zA-Z]:)/, '$1').replace(/^([a-zA-Z])\//, '$1:/');
      }

      if (!filePath || !fs.existsSync(filePath)) {
        console.error('未找到流媒体物理文件:', filePath);
        return new Response('File Not Found', { status: 404 });
      }

      const stat = fs.statSync(filePath);
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
