import React from 'react';
import { Scissors, FolderKanban, Settings as SettingsIcon } from 'lucide-react';

export type TabId = 'cutter' | 'plans' | 'settings';

interface SidebarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  plansCount?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, onTabChange, plansCount = 0 }) => {
  return (
    <aside
      className="w-[68px] h-full bg-[#090b10] border-r border-white/10 flex flex-col items-center py-5 shrink-0 z-50 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 竖向导航 Tab */}
      <nav
        className="flex flex-col gap-3.5 flex-1 w-full items-center"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={() => onTabChange('cutter')}
          className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all relative ${
            activeTab === 'cutter'
              ? 'text-white bg-blue-500/20 border border-blue-500/30 shadow-md shadow-blue-500/10'
              : 'text-zinc-400 hover:text-white hover:bg-white/5 border border-transparent'
          }`}
          title="视频裁剪工作台"
        >
          {activeTab === 'cutter' && (
            <span className="absolute -left-[13px] top-2.5 bottom-2.5 w-[3px] rounded-r bg-[#58a6ff] shadow-[0_0_8px_#58a6ff]" />
          )}
          <Scissors className="w-5 h-5" />
        </button>

        <button
          onClick={() => onTabChange('plans')}
          className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all relative ${
            activeTab === 'plans'
              ? 'text-white bg-blue-500/20 border border-blue-500/30 shadow-md shadow-blue-500/10'
              : 'text-zinc-400 hover:text-white hover:bg-white/5 border border-transparent'
          }`}
          title="方案管理中心"
        >
          {activeTab === 'plans' && (
            <span className="absolute -left-[13px] top-2.5 bottom-2.5 w-[3px] rounded-r bg-[#58a6ff] shadow-[0_0_8px_#58a6ff]" />
          )}
          <FolderKanban className="w-5 h-5" />
          {plansCount > 0 && (
            <span className="absolute top-1.5 right-1.5 bg-[#58a6ff] text-white text-[10px] font-bold px-1 rounded-full leading-none min-w-[14px] text-center">
              {plansCount}
            </span>
          )}
        </button>

        <button
          onClick={() => onTabChange('settings')}
          className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all relative ${
            activeTab === 'settings'
              ? 'text-white bg-blue-500/20 border border-blue-500/30 shadow-md shadow-blue-500/10'
              : 'text-zinc-400 hover:text-white hover:bg-white/5 border border-transparent'
          }`}
          title="系统配置与输出偏好"
        >
          {activeTab === 'settings' && (
            <span className="absolute -left-[13px] top-2.5 bottom-2.5 w-[3px] rounded-r bg-[#58a6ff] shadow-[0_0_8px_#58a6ff]" />
          )}
          <SettingsIcon className="w-5 h-5" />
        </button>
      </nav>

      {/* 底部版本号 */}
      <div className="text-[11px] text-zinc-500 font-mono">v1.0</div>
    </aside>
  );
};
