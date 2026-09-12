import fs from 'fs';
import path from 'path';
import { AppConfig, DEFAULT_APP_CONFIG } from '../../shared/types';
import { CompressConfig, MediaStreamInfo } from '../../shared/types';
import { resolveOutputBatch } from './OutputPathResolver';
import { resolveFormats } from './MediaFormatResolver';
import { fileIdentity, probeFile, resolveTool } from './MediaTools';

export class ConfigService {
  private configPath: string;
  private currentConfig: AppConfig;
  private dataDir: string;
  private outputStreams = new Map<string, Promise<MediaStreamInfo[]>>();

  constructor(dataDir: string = process.cwd(), configPath?: string) {
    this.dataDir = path.resolve(dataDir);
    this.configPath = configPath || path.join(this.dataDir, 'config.json');
    this.currentConfig = this.loadOrCreateConfig();
  }

  /**
   * 探测指定基准目录（通常为可执行文件同级目录）是否已绑定有效数据目录
   */
  public static resolveDataDirectory(baseDir: string): { dataDir: string | null; isPointer: boolean } {
    // 优先探测标准规范的 workspace.json，其次向下兼容旧版 config.json
    const workspaceConfig = path.join(baseDir, 'workspace.json');
    const legacyConfig = path.join(baseDir, 'config.json');
    const localConfig = fs.existsSync(workspaceConfig)
      ? workspaceConfig
      : fs.existsSync(legacyConfig)
      ? legacyConfig
      : null;

    if (!localConfig) {
      return { dataDir: null, isPointer: false };
    }

    try {
      const raw = fs.readFileSync(localConfig, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.dataDirectory) {
        const targetDir = path.resolve(parsed.dataDirectory);
        if (fs.existsSync(targetDir)) {
          const isPointer = path.resolve(baseDir) !== targetDir;
          return { dataDir: targetDir, isPointer };
        }
        // 指针指向的目标目录已被移动或删除
        return { dataDir: null, isPointer: true };
      }
      // 同级目录自包含完整配置
      return { dataDir: path.resolve(baseDir), isPointer: false };
    } catch (err) {
      console.warn(`解析本地配置文件失败 (${localConfig}):`, err);
      return { dataDir: null, isPointer: false };
    }
  }

  /**
   * 初始化用户选定的工作数据目录，并在 exe 同级目录写入轻量指向配置 (workspace.json)
   */
  public static setupDataDirectory(
    exeDir: string,
    selectedDataDir: string,
    overrides?: Partial<AppConfig>
  ): ConfigService {
    const resolvedDataDir = path.resolve(selectedDataDir);
    if (!fs.existsSync(resolvedDataDir)) {
      fs.mkdirSync(resolvedDataDir, { recursive: true });
    }

    const plansDir = path.join(resolvedDataDir, 'plans');
    if (!fs.existsSync(plansDir)) {
      fs.mkdirSync(plansDir, { recursive: true });
    }

    const targetConfigPath = path.join(resolvedDataDir, 'config.json');
    if (!fs.existsSync(targetConfigPath)) {
      const initialConfig: AppConfig = {
        ...DEFAULT_APP_CONFIG,
        dataDirectory: resolvedDataDir,
        plansStoragePath: plansDir,
        ...(overrides || {}),
      };
      fs.writeFileSync(targetConfigPath, JSON.stringify(initialConfig, null, 2), 'utf-8');
    }

    // 若数据目录与 exe 所在目录不同，在 exe 同级写入微型工作区指针配置 (workspace.json)
    const resolvedExeDir = path.resolve(exeDir);
    if (resolvedExeDir !== resolvedDataDir) {
      const pointerConfigPath = path.join(resolvedExeDir, 'workspace.json');
      try {
        fs.writeFileSync(
          pointerConfigPath,
          JSON.stringify({ dataDirectory: resolvedDataDir }, null, 2),
          'utf-8'
        );
      } catch (err) {
        console.warn('在可执行程序同级写入 workspace.json 失败（可能处于写保护目录）:', err);
      }
    }

    return new ConfigService(resolvedDataDir, targetConfigPath);
  }

  public getDataDirectory(): string {
    return this.dataDir;
  }

  public getPlansDirectory(): string {
    return path.join(this.dataDir, 'plans');
  }

  /**
   * 加载或自愈创建默认 config.json
   */
  public loadOrCreateConfig(): AppConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        // 与默认值安全浅合并，补齐可能缺失的字段（自愈能力）
        const merged: AppConfig = {
          ...DEFAULT_APP_CONFIG,
          ...parsed,
        };
        return merged;
      }
    } catch (err) {
      console.warn('读取 config.json 失败，将重新生成默认配置:', err);
    }

    // 文件不存在或损坏，原子写入默认配置
    this.saveConfig(DEFAULT_APP_CONFIG);
    return { ...DEFAULT_APP_CONFIG };
  }

  /**
   * 获取当前有效配置
   */
  public getConfig(): AppConfig {
    return { ...this.currentConfig };
  }

  /**
   * 保存并更新配置
   */
  public saveConfig(newConfig: Partial<AppConfig>): AppConfig {
    const nextConfig = {
      ...this.currentConfig,
      ...newConfig,
    };
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(nextConfig, null, 2), 'utf-8');
    this.currentConfig = nextConfig;
    return { ...this.currentConfig };
  }

  /**
   * 根据当前输出目录策略推导视频切片的目标目录
   */
  public resolveTargetDirectory(videoSourcePath: string): string {
    const sourceDir = path.dirname(videoSourcePath);
    switch (this.currentConfig.outputDirectoryRule) {
      case 'sub_folder': {
        const subFolder = this.currentConfig.subFolderName || '_cut';
        return path.join(sourceDir, subFolder);
      }
      case 'custom_fixed': {
        if (this.currentConfig.customOutputDirectory) {
          return this.currentConfig.customOutputDirectory;
        }
        // 若未设置固定目录，安全回退到同级子目录
        return path.join(sourceDir, '_cut');
      }
      case 'same_directory':
      default:
        return sourceDir;
    }
  }

  /**
   * 根据当前输出目录策略推导视频切片的输出路径
   */
  public resolveOutputPath(videoSourcePath: string, isConcat: boolean = true, planTitle?: string): Promise<string> {
    return this.resolveSafeOutputPath(videoSourcePath, isConcat, planTitle);
  }

  /**
   * 安全解析输出路径（增加任务时间戳前缀与方案名，自动避让同名文件与源文件物理冲突）
   * 格式规范：
   * - 有方案名：YYYYMMDD_HHmm_[方案名]原文件名.mp4 (合并) / YYYYMMDD_HHmm_[方案名]原文件名_seg01.mp4 (分段)
   * - 无方案名：YYYYMMDD_HHmm_原文件名_cut.mp4 (合并) / YYYYMMDD_HHmm_原文件名_seg01.mp4 (分段)
   * @param videoSourcePath 源视频路径
   * @param isConcat 是否为单文件合并模式（若为 false 则推导多分段切片的第一段预定路径）
   * @param planTitle 可选方案名称
   */
  public async resolveSafeOutputPath(
    videoSourcePath: string,
    isConcat: boolean = true,
    planTitle?: string,
    compress?: CompressConfig,
    stripCover = true
  ): Promise<string> {
    const tool = resolveTool('ffprobe', this.currentConfig.ffprobePath), identity = `${tool}:${fileIdentity(videoSourcePath)}`;
    let streams = this.outputStreams.get(identity);
    if (!streams) {
      streams = probeFile(videoSourcePath, tool).then(info => info.streams).catch(error => { this.outputStreams.delete(identity); throw error; });
      this.outputStreams.set(identity, streams);
      if (this.outputStreams.size > 64) this.outputStreams.delete(this.outputStreams.keys().next().value!);
    }
    const extension = resolveFormats(videoSourcePath, await streams, compress, stripCover).outputExtension;
    return resolveOutputBatch({ directory: this.resolveTargetDirectory(videoSourcePath), source: videoSourcePath, extension, title: planTitle, segmented: !isConcat })[0];
  }

  public getConfigPath(): string {
    return this.configPath;
  }
}
