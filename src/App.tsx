import React, { useState, useEffect } from 'react';
import { Sidebar, TabId } from './renderer/components/Sidebar';
import { Header } from './renderer/components/Header';
import { CutterPage } from './renderer/components/CutterPage';
import { PlansPage } from './renderer/components/PlansPage';
import { SettingsPage } from './renderer/components/SettingsPage';
import { PlanRecord } from './shared/types';
import { CheckCircle2, FolderOpen, X } from 'lucide-react';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>('cutter');
  const [currentVideoPath, setCurrentVideoPath] = useState<string | null>(null);
  const [loadedPlan, setLoadedPlan] = useState<PlanRecord | null>(null);
  const [plansCount, setPlansCount] = useState(0);
  const [globalToast, setGlobalToast] = useState<{ message: string; outputPath?: string } | null>(null);

  // 刷新方案数量
  const refreshPlansCount = async () => {
    try {
      if (window.electronAPI) {
        const plans = await window.electronAPI.listPlans();
        setPlansCount(plans.length);
      }
    } catch {
      // 忽略异常
    }
  };

  useEffect(() => {
    refreshPlansCount();

    if (!window.electronAPI) return;

    // 监听后台方案状态变动
    const cleanupStatus = window.electronAPI.onPlanStatusChanged?.(() => {
      refreshPlansCount();
    });

    // 监听后台方案完成
    const cleanupCompleted = window.electronAPI.onPlanCompleted?.(async (event) => {
      refreshPlansCount();
      try {
        const cfg = await window.electronAPI!.getConfig();
        if (cfg.notifyOnExportComplete !== false) {
          const fileName = event.outputPath ? event.outputPath.split(/[\\/]/).pop() : '剪辑产物';
          setGlobalToast({
            message: `剪辑完成：${fileName}`,
            outputPath: event.outputPath,
          });
        }
      } catch (err) {
        console.warn('读取通知配置失败:', err);
      }
    });

    return () => {
      if (cleanupStatus) cleanupStatus();
      if (cleanupCompleted) cleanupCompleted();
    };
  }, []);

  const globalFileInputRef = React.useRef<HTMLInputElement | null>(null);

  // 选择本地视频
  const handleOpenVideo = async () => {
    if (window.electronAPI) {
      try {
        const filePath = await window.electronAPI.openVideoDialog();
        if (filePath) {
          setLoadedPlan(null); // 打开新视频时清空回载的旧方案
          setCurrentVideoPath(filePath);
          setActiveTab('cutter');
          return;
        }
      } catch (err) {
        console.warn('原生对话框打开失败，回退至标准文件选择器', err);
      }
    }
    // 兜底：触发全局文件选择器
    globalFileInputRef.current?.click();
  };

  const handleGlobalFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const fullPath = (file as any).path || file.name;
      setLoadedPlan(null);
      setCurrentVideoPath(fullPath);
      setActiveTab('cutter');
    }
  };

  // 从方案列表回载方案到工作台
  const handleLoadPlanIntoCutter = (plan: PlanRecord) => {
    setLoadedPlan(plan);
    setCurrentVideoPath(plan.sourcePath);
    setActiveTab('cutter');
  };

  // 打开当前视频对应的输出目录
  const handleOpenOutputFolder = async () => {
    if (!window.electronAPI || !currentVideoPath) return;
    try {
      const outPath = await window.electronAPI.resolveOutputPath(currentVideoPath);
      window.electronAPI.showItemInFolder(outPath);
    } catch {
      window.electronAPI.showItemInFolder(currentVideoPath);
    }
  };

  const getTabTitle = () => {
    switch (activeTab) {
      case 'cutter':
        return '视频裁剪工作台';
      case 'plans':
        return '方案管理中心';
      case 'settings':
        return '系统偏好与配置';
      default:
        return 'VideoCutTool';
    }
  };

  const currentVideoName = currentVideoPath
    ? currentVideoPath.split(/[\\/]/).pop()
    : undefined;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0c0e14] relative">
      <input
        type="file"
        ref={globalFileInputRef}
        onChange={handleGlobalFileInputChange}
        accept="video/mp4,video/mkv,video/mov,video/avi,video/flv,video/ts,video/webm,video/*"
        className="hidden"
      />

      {/* Motrix 经典 68px 侧边栏 */}
      <Sidebar
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab);
          refreshPlansCount();
        }}
        plansCount={plansCount}
      />

      {/* 主界面视窗 */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* 1360px 统一中轴顶栏 */}
        <Header
          activeTabTitle={getTabTitle()}
          onOpenVideo={handleOpenVideo}
          onOpenOutputFolder={currentVideoPath ? handleOpenOutputFolder : undefined}
          currentVideoName={currentVideoName}
        />

        <main className="flex-1 overflow-hidden relative flex flex-col">
          {/* 工作台组件保持常驻，切换 Tab 时使用 hidden，保障切点草稿与视频播放进度不丢失 */}
          <div className={activeTab === 'cutter' ? 'flex flex-1 flex-col h-full overflow-hidden min-h-0' : 'hidden'}>
            <CutterPage
              onOpenVideo={handleOpenVideo}
              initialVideoPath={currentVideoPath}
              loadedPlanRecord={loadedPlan}
              onPlanSaved={refreshPlansCount}
            />
          </div>

          <div className={activeTab === 'plans' ? 'flex flex-1 flex-col h-full overflow-hidden min-h-0' : 'hidden'}>
            <PlansPage onLoadPlanIntoCutter={handleLoadPlanIntoCutter} />
          </div>

          <div className={activeTab === 'settings' ? 'flex flex-1 flex-col h-full overflow-hidden min-h-0' : 'hidden'}>
            <SettingsPage />
          </div>
        </main>
      </div>

      {/* 全局后台导出完成浮动卡片 (可一键定位产物) */}
      {globalToast && (
        <div className="absolute top-16 right-8 z-50 max-w-[420px] p-3.5 rounded-2xl bg-[#161b22]/95 border border-emerald-500/40 text-xs shadow-2xl backdrop-blur-md flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-3">
          <div className="flex items-center gap-2.5 min-w-0 text-emerald-200">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="truncate font-medium">{globalToast.message}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {globalToast.outputPath && (
              <button
                onClick={() => {
                  window.electronAPI?.showItemInFolder(globalToast.outputPath!);
                }}
                className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center gap-1.5 transition-all active:scale-95 text-[11px]"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>定位产物</span>
              </button>
            )}
            <button
              onClick={() => setGlobalToast(null)}
              className="text-zinc-400 hover:text-white text-xs px-1 hover:bg-white/10 rounded transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
