import React, { useState, useEffect } from 'react';
import { Sidebar, TabId } from './renderer/components/Sidebar';
import { Header } from './renderer/components/Header';
import { CutterPage } from './renderer/components/CutterPage';
import { PlansPage } from './renderer/components/PlansPage';
import { SettingsPage } from './renderer/components/SettingsPage';
import { PlanRecord } from './shared/types';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>('cutter');
  const [currentVideoPath, setCurrentVideoPath] = useState<string | null>(null);
  const [loadedPlan, setLoadedPlan] = useState<PlanRecord | null>(null);
  const [plansCount, setPlansCount] = useState(0);

  // 刷新方案数量
  const refreshPlansCount = async () => {
    try {
      if (window.electronAPI) {
        const plans = await window.electronAPI.listPlans();
        setPlansCount(plans.length);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refreshPlansCount();
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
    <div className="flex h-screen w-screen overflow-hidden bg-[#0c0e14]">
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
          {activeTab === 'cutter' && (
            <CutterPage
              onOpenVideo={handleOpenVideo}
              initialVideoPath={currentVideoPath}
              loadedPlanRecord={loadedPlan}
              onPlanSaved={refreshPlansCount}
            />
          )}

          {activeTab === 'plans' && (
            <PlansPage onLoadPlanIntoCutter={handleLoadPlanIntoCutter} />
          )}

          {activeTab === 'settings' && <SettingsPage />}
        </main>
      </div>
    </div>
  );
};

export default App;
