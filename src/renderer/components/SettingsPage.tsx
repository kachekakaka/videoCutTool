import React, { useState, useEffect } from 'react';
import { AppConfig, DEFAULT_APP_CONFIG, OutputDirectoryRule } from '../../shared/types';
import { Check, Folder, ShieldCheck, HardDrive, FileJson, RefreshCw, AlertCircle } from 'lucide-react';

export const SettingsPage: React.FC = () => {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);
  const [configPath, setConfigPath] = useState<string>('');
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      if (window.electronAPI) {
        const loaded = await window.electronAPI.getConfig();
        const path = await window.electronAPI.getConfigPath();
        setConfig(loaded);
        setConfigPath(path);
      }
    } catch (err) {
      console.error('加载配置失败:', err);
      setErrorMsg('读取配置文件失败');
    }
  };

  const handleRuleChange = async (rule: OutputDirectoryRule) => {
    const updated = { ...config, outputDirectoryRule: rule };
    setConfig(updated);
    await persistConfig(updated);
  };

  const handleSubFolderChange = async (name: string) => {
    const updated = { ...config, subFolderName: name };
    setConfig(updated);
  };

  const handleCustomDirChange = async (dir: string) => {
    const updated = { ...config, customOutputDirectory: dir };
    setConfig(updated);
  };

  const handleBrowseCustomDir = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.electronAPI) {
      try {
        const selected = await window.electronAPI.selectDirectory(config.customOutputDirectory);
        if (selected) {
          const updated = { ...config, customOutputDirectory: selected, outputDirectoryRule: 'custom_fixed' as OutputDirectoryRule };
          setConfig(updated);
          await persistConfig(updated);
        }
      } catch (err) {
        console.error('选择目录失败:', err);
      }
    }
  };

  const persistConfig = async (newCfg: AppConfig) => {
    try {
      if (window.electronAPI) {
        const saved = await window.electronAPI.saveConfig(newCfg);
        setConfig(saved);
        setSavedSuccess(true);
        setTimeout(() => setSavedSuccess(false), 2000);
      }
    } catch (err) {
      console.error('保存配置失败:', err);
      setErrorMsg('保存配置文件失败');
    }
  };

  return (
    <div className="flex-1 h-full overflow-y-auto px-8 py-7">
      <div className="max-w-[1360px] mx-auto">
        {/* 标题 */}
        <div className="flex items-center justify-between pb-6 mb-7 border-b border-white/10">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2.5">
              <span>系统设置与输出偏好</span>
              {savedSuccess && (
                <span className="text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" /> 已自动保存
                </span>
              )}
              {errorMsg && (
                <span className="text-xs bg-rose-500/20 text-rose-400 border border-rose-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" /> {errorMsg}
                </span>
              )}
            </h1>
            <p className="text-xs text-zinc-400 mt-1">
              配置自愈生效中，启动时自动从可执行文件同级的 <code className="text-blue-400 font-mono">config.json</code> 加载与同步
            </p>
          </div>

          <button
            onClick={() => persistConfig(config)}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-all shadow-md shadow-blue-500/20 active:scale-95"
          >
            <Check className="w-4 h-4" /> 保存所有配置
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* 输出目录策略 */}
          <div className="p-6 rounded-2xl bg-[#161b22]/80 border border-white/10 shadow-xl backdrop-blur-md">
            <h2 className="text-sm font-bold text-white flex items-center gap-2 mb-4">
              <Folder className="w-4 h-4 text-blue-400" />
              剪辑产物默认输出目录规则
            </h2>

            <div className="space-y-3.5">
              {/* sub_folder */}
              <label 
                onClick={() => handleRuleChange('sub_folder')}
                className={`flex items-start gap-3.5 p-4 rounded-xl border cursor-pointer transition-all ${
                  config.outputDirectoryRule === 'sub_folder'
                    ? 'bg-blue-500/10 border-blue-500/40 text-white'
                    : 'bg-white/[0.02] border-white/5 text-zinc-300 hover:border-white/10'
                }`}
              >
                <input
                  type="radio"
                  name="outputRule"
                  checked={config.outputDirectoryRule === 'sub_folder'}
                  onChange={() => handleRuleChange('sub_folder')}
                  className="mt-1 accent-blue-500"
                />
                <div className="flex-1">
                  <div className="text-sm font-semibold flex items-center gap-2">
                    <span>原视频同级专属子文件夹（推荐）</span>
                    <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-mono">DEFAULT</span>
                  </div>
                  <div className="text-xs text-zinc-400 mt-1">
                    在原视频所在目录下自动创建专属文件夹保存切片，防止原目录混乱。
                  </div>
                  {config.outputDirectoryRule === 'sub_folder' && (
                    <div className="mt-3 flex items-center gap-2">
                      <span className="text-xs text-zinc-400">子文件夹名：</span>
                      <input
                        type="text"
                        value={config.subFolderName}
                        onChange={(e) => handleSubFolderChange(e.target.value)}
                        onBlur={() => persistConfig(config)}
                        className="bg-black/40 border border-white/15 rounded-md px-2.5 py-1 text-xs text-white font-mono w-32 focus:border-blue-500 focus:outline-none"
                      />
                      <span className="text-xs text-zinc-500 font-mono">例：D:/Videos/_cuts/name_cut.mp4</span>
                    </div>
                  )}
                </div>
              </label>

              {/* same_directory */}
              <label 
                onClick={() => handleRuleChange('same_directory')}
                className={`flex items-start gap-3.5 p-4 rounded-xl border cursor-pointer transition-all ${
                  config.outputDirectoryRule === 'same_directory'
                    ? 'bg-blue-500/10 border-blue-500/40 text-white'
                    : 'bg-white/[0.02] border-white/5 text-zinc-300 hover:border-white/10'
                }`}
              >
                <input
                  type="radio"
                  name="outputRule"
                  checked={config.outputDirectoryRule === 'same_directory'}
                  onChange={() => handleRuleChange('same_directory')}
                  className="mt-1 accent-blue-500"
                />
                <div className="flex-1">
                  <div className="text-sm font-semibold">原视频同级目录（直接存放）</div>
                  <div className="text-xs text-zinc-400 mt-1">
                    直接保存在原视频文件边上，追加 <code className="text-zinc-300">_cut</code> 后缀名。
                  </div>
                </div>
              </label>

              {/* custom_fixed */}
              <label 
                onClick={() => handleRuleChange('custom_fixed')}
                className={`flex items-start gap-3.5 p-4 rounded-xl border cursor-pointer transition-all ${
                  config.outputDirectoryRule === 'custom_fixed'
                    ? 'bg-blue-500/10 border-blue-500/40 text-white'
                    : 'bg-white/[0.02] border-white/5 text-zinc-300 hover:border-white/10'
                }`}
              >
                <input
                  type="radio"
                  name="outputRule"
                  checked={config.outputDirectoryRule === 'custom_fixed'}
                  onChange={() => handleRuleChange('custom_fixed')}
                  className="mt-1 accent-blue-500"
                />
                <div className="flex-1">
                  <div className="text-sm font-semibold">固定输出到统一指定目录</div>
                  <div className="text-xs text-zinc-400 mt-1">
                    所有视频切片集中汇总到一个专用的存储目录中。
                  </div>
                  {config.outputDirectoryRule === 'custom_fixed' && (
                    <div className="mt-3 flex items-center gap-2">
                      <input
                        type="text"
                        placeholder="例如 D:/ExportedCuts"
                        value={config.customOutputDirectory}
                        onChange={(e) => handleCustomDirChange(e.target.value)}
                        onBlur={() => persistConfig(config)}
                        className="flex-1 bg-black/40 border border-white/15 rounded-md px-2.5 py-1.5 text-xs text-white font-mono focus:border-blue-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleBrowseCustomDir}
                        className="px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-zinc-200 hover:text-white text-xs font-semibold flex items-center gap-1.5 transition-all active:scale-95 shrink-0 border border-white/10"
                        title="唤起系统文件夹选择器"
                      >
                        <Folder className="w-3.5 h-3.5 text-amber-400" />
                        <span>浏览...</span>
                      </button>
                    </div>
                  )}
                </div>
              </label>
            </div>
          </div>

          {/* 剪辑安全与工具链设置 */}
          <div className="space-y-6">
            <div className="p-6 rounded-2xl bg-[#161b22]/80 border border-white/10 shadow-xl backdrop-blur-md">
              <h2 className="text-sm font-bold text-white flex items-center gap-2 mb-4">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                无损剪辑保全铁律准则
              </h2>

              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-200 space-y-2">
                <div className="font-bold flex items-center gap-1.5 text-emerald-300">
                  <Check className="w-4 h-4" /> 关键帧保全（绝不多删一帧正片）已锁定开启
                </div>
                <p className="text-zinc-300 leading-relaxed">
                  系统采用向左吸附前向关键帧（Floor to Keyframe）算法。虽然会在开头多留零点几秒，但彻底杜绝正片开头被截断，并保证从完整的 I 帧起播，播放不卡顿、不花屏。
                </p>
              </div>

              <div className="mt-5 flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/5">
                <div>
                  <div className="text-sm font-semibold text-white">多保留段默认自动合并</div>
                  <div className="text-xs text-zinc-400">导出的多个保留区间自动通过 Concat Demuxer 拼为单个文件</div>
                </div>
                <input
                  type="checkbox"
                  checked={config.autoConcatSingleFile}
                  onChange={(e) => {
                    const updated = { ...config, autoConcatSingleFile: e.target.checked };
                    setConfig(updated);
                    persistConfig(updated);
                  }}
                  className="w-4 h-4 accent-blue-500 rounded cursor-pointer"
                />
              </div>
              <div className="mt-3 flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/5">
                <div>
                  <div className="text-sm font-semibold text-white">后台导出完成时弹出通知</div>
                  <div className="text-xs text-zinc-400">视频在后台静默剪辑完成时，在界面右上角弹出带“定位产物”的通知浮层</div>
                </div>
                <input
                  type="checkbox"
                  checked={config.notifyOnExportComplete !== false}
                  onChange={(e) => {
                    const updated = { ...config, notifyOnExportComplete: e.target.checked };
                    setConfig(updated);
                    persistConfig(updated);
                  }}
                  className="w-4 h-4 accent-blue-500 rounded cursor-pointer"
                />
              </div>
            </div>

            {/* 本地环境持久化路径 */}
            <div className="p-6 rounded-2xl bg-[#161b22]/80 border border-white/10 shadow-xl backdrop-blur-md">
              <h2 className="text-sm font-bold text-white flex items-center gap-2 mb-3">
                <HardDrive className="w-4 h-4 text-purple-400" />
                便携文件与本地持久化状态
              </h2>

              <div className="space-y-2.5 text-xs text-zinc-300">
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-black/30 border border-white/5 font-mono">
                  <span className="text-zinc-400 flex items-center gap-1.5">
                    <FileJson className="w-3.5 h-3.5 text-blue-400" /> 配置文件路径:
                  </span>
                  <span className="text-zinc-200 truncate max-w-[280px]" title={configPath}>
                    {configPath || '加载中...'}
                  </span>
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-black/30 border border-white/5 font-mono">
                  <span className="text-zinc-400 flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 text-emerald-400" /> 方案存储目录:
                  </span>
                  <span className="text-zinc-200">{config.plansStoragePath}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
