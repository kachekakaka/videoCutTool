import React, { useState, useEffect } from 'react';
import { AppConfig } from '../../shared/types';
import { useAppData } from '../AppDataContext';
import { Check, Folder, ShieldCheck, HardDrive, FileJson, RefreshCw, AlertCircle } from 'lucide-react';

export const SettingsPage: React.FC = () => {
  const { config: savedConfig, saveConfig } = useAppData();
  const [draftPatch, setDraftPatch] = useState<Partial<AppConfig>>({});
  const config = { ...savedConfig, ...draftPatch };
  const [configPath, setConfigPath] = useState<string>('');
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      if (window.electronAPI) {
        const path = await window.electronAPI.getConfigPath();
        setConfigPath(path);
      }
    } catch (err) {
      console.error('加载配置失败:', err);
      setErrorMsg('读取配置文件失败');
    }
  };

  const persistConfig = async (newCfg: Partial<AppConfig>) => {
    try {
      if (window.electronAPI) {
        await saveConfig(newCfg);
        setDraftPatch(previous => Object.fromEntries(Object.entries(previous).filter(([key, value]) => value !== newCfg[key as keyof AppConfig])));
        setErrorMsg(null);
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
            onClick={() => persistConfig(draftPatch)}
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
              产物输出位置
            </h2>

            <div className="space-y-3.5 text-sm text-zinc-300">
              <p>产物保存在原视频所在目录，按处理类型自动归类。</p>
              <p>裁剪结果（含裁剪后压缩）：<code className="text-blue-300">cut_方案名/</code></p>
              <p>整片压缩结果：<code className="text-purple-300">压缩/</code>，不按方案分目录。</p>
              <p className="text-xs text-zinc-500">已有文件保持原位，新产物遇到同名文件自动加序号。</p>
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
                    const updated = { autoConcatSingleFile: e.target.checked };
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
                    const updated = { notifyOnExportComplete: e.target.checked };
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
