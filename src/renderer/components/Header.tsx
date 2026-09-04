import React from 'react';
import { Upload, FolderOpen } from 'lucide-react';

interface HeaderProps {
  activeTabTitle: string;
  onOpenVideo?: () => void;
  onOpenOutputFolder?: () => void;
  currentVideoName?: string;
}

export const Header: React.FC<HeaderProps> = ({
  activeTabTitle,
  onOpenVideo,
  onOpenOutputFolder,
  currentVideoName,
}) => {
  return (
    <header className="h-14 border-b border-white/10 px-4 sm:px-6 xl:px-8 flex items-center bg-[#090b10]/60 backdrop-blur-md shrink-0">
      {/* 严格对齐至 1360px 统一中轴 */}
      <div className="w-full max-w-[1360px] mx-auto flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-bold text-white tracking-wide shrink-0">{activeTabTitle}</span>
          {currentVideoName && (
            <span className="text-xs text-zinc-400 bg-white/5 border border-white/10 px-2.5 py-1 rounded-md font-mono truncate max-w-[180px] md:max-w-[280px] xl:max-w-[420px]">
              🎬 {currentVideoName}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          {onOpenOutputFolder && (
            <button
              onClick={onOpenOutputFolder}
              className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white text-xs font-medium flex items-center gap-1.5 transition-all border border-white/10 active:scale-95"
              title="在系统文件管理器中打开输出目录"
            >
              <FolderOpen className="w-3.5 h-3.5 text-amber-400" /> 打开输出目录
            </button>
          )}

          {onOpenVideo && (
            <button
              onClick={onOpenVideo}
              className="px-3.5 py-1.5 rounded-lg bg-blue-600/90 hover:bg-blue-500 text-white text-xs font-medium flex items-center gap-1.5 transition-all shadow-md shadow-blue-500/15 active:scale-95"
            >
              <Upload className="w-3.5 h-3.5" /> 打开视频文件
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
