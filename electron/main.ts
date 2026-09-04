import { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { ConfigService } from '../src/main/services/ConfigService';
import { KeyframeProber } from '../src/main/services/KeyframeProber';
import { FFmpegExecutor } from '../src/main/services/FFmpegExecutor';
import { PlanManager } from '../src/main/services/PlanManager';
import { AppConfig, MediaRetentionPlan, PlanRecord } from '../src/shared/types';

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

// 设置独立的用户数据目录，解决权限冲突
const tempUserData = path.join(app.getPath('temp'), 'videocuttool-userdata');
app.setPath('userData', tempUserData);

// 服务实例生命周期持有者
let configService: ConfigService;
let prober: KeyframeProber;
let executor: FFmpegExecutor;
let planManager: PlanManager;

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
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
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
ipcMain.handle('config:resolveOutputPath', async (_event, videoPath: string, isConcat: boolean = true) => configService.resolveSafeOutputPath(videoPath, isConcat));

ipcMain.handle('media:probe', async (_event, filePath: string) => prober.probe(filePath));
ipcMain.handle('media:probeBasic', async (_event, filePath: string) => prober.probeBasic(filePath));
ipcMain.handle('media:probeKeyframes', async (_event, filePath: string) => prober.probeKeyframes(filePath));

ipcMain.handle('cut:execute', async (_event, plan: MediaRetentionPlan) => executor.executePlan(plan));

ipcMain.handle('plan:list', async () => planManager.listPlans());
ipcMain.handle('plan:save', async (_event, record: PlanRecord) => planManager.savePlan(record));
ipcMain.handle('plan:delete', async (_event, id: string) => planManager.deletePlan(id));
ipcMain.handle('plan:execute', async (_event, id: string) => planManager.executePlan(id));
ipcMain.handle('plan:batchExecute', async () => planManager.batchExecute());
ipcMain.handle('shell:showItemInFolder', async (_event, fullPath: string) => {
  if (fullPath) shell.showItemInFolder(fullPath);
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
  // 1. 获取物理宿主目录（优先支持外置跳板启动器注入的 VCT_WORKSPACE_DIR，其次兼容 portable 环境变量与 exe 宿主目录）
  const exeDir = process.env.VCT_WORKSPACE_DIR || process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd());

  // 2. 探测同级目录是否已配置有效数据目录（优先读取 workspace.json）
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
  const tempSlicesDir = path.resolve(process.cwd(), '../videoCutTool_tmp/slices');
  prober = new KeyframeProber(currentConfig.ffprobePath);
  executor = new FFmpegExecutor(currentConfig.ffmpegPath, tempSlicesDir);
  planManager = new PlanManager(configService.getDataDirectory(), executor, prober);

  // 注册本地流媒体协议: media://video?path=...
  // 支持 HTTP 206 Partial Content (Range 请求)，杜绝拖拽进度条回弹至 0 秒
  protocol.handle('media', (request) => {
    try {
      const parsed = new URL(request.url);
      let filePath = parsed.searchParams.get('path');

      if (!filePath) {
        // 兼容旧版或直接 pathname 模式
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
        // 解析 Range 头: bytes=start-end 或 bytes=start-
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

      // 未携带 Range 头时以 200 流式返回，并声明支持字节寻址
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
