import React from 'react';
import { Upload, FolderOpen } from 'lucide-react';
import { useAppData } from '../AppDataContext';

interface HeaderProps {
  activeTabTitle: string;
  onOpenVideo?: () => void;
  onOpenOutputFolder?: () => void;
  currentVideoName?: string;
  workbenchMode?: 'temporal' | 'spatial';
  onWorkbenchModeChange?: (mode: 'temporal' | 'spatial') => void;
  hasSpatialActive?: boolean;
  onNavigatePlans?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTabTitle,
  onOpenVideo,
  onOpenOutputFolder,
  currentVideoName,
  workbenchMode,
  onWorkbenchModeChange,
  hasSpatialActive,
  onNavigatePlans,
}) => {
  const { engine, plans } = useAppData();
  const queuedCount = plans.filter(p => p.status === 'queued').length;
  const isExecuting = Boolean(engine.activePlanId);
  const isPaused = engine.queuePaused;
  const hasPriority = Boolean(engine.priorityPlanId);

  // 全局执行状态胶囊渲染
  const renderStatusPill = () => {
    if (!isExecuting && !isPaused && !hasPriority && queuedCount === 0) return null;

    if (isExecuting && !isPaused) {
      return (
        <button
          onClick={onNavigatePlans}
          title="调度引擎正常运行中，点击进入方案中心"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs hover:bg-emerald-500/20 transition-all cursor-pointer"
        >
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span className="font-medium truncate max-w-[180px]">
            正在导出{queuedCount > 0 ? ` (${queuedCount}项排队)` : ''}
          </span>
        </button>
      );
    }

    if (isExecuting && isPaused) {
      return (
        <button
          onClick={onNavigatePlans}
          title="队列已暂停派发，当前任务完成后将停止。点击进入方案中心"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs hover:bg-amber-500/20 transition-all cursor-pointer"
        >
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
          <span className="font-medium">已暂停 (完成当前后停)</span>
        </button>
      );
    }

    if (hasPriority) {
      return (
        <button
          onClick={onNavigatePlans}
          title="已指定手动优先任务，将下一位执行。点击进入方案中心"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-400/40 text-amber-200 text-xs hover:bg-amber-500/25 transition-all cursor-pointer font-medium"
        >
          <span>⭐</span>
          <span>优先任务待执行</span>
        </button>
      );
    }

    if (isPaused) {
      return (
        <button
          onClick={onNavigatePlans}
          title="调度队列处于暂停状态，后续任务不会自动开始。点击进入方案中心"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-800/80 border border-amber-500/30 text-zinc-300 text-xs hover:bg-zinc-700 transition-all cursor-pointer"
        >
          <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
          <span>队列已暂停 ({queuedCount}个待办)</span>
        </button>
      );
    }

    if (queuedCount > 0) {
      return (
        <button
          onClick={onNavigatePlans}
          title="有方案在排队等待执行。点击进入方案中心"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-300 text-xs hover:bg-blue-500/20 transition-all cursor-pointer"
        >
          <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />
          <span>等待派发 ({queuedCount})</span>
        </button>
      );
    }

    return null;
  };
  return (
    <header
      className="h-14 border-b border-white/10 px-4 sm:px-6 xl:px-8 flex items-center bg-[#090b10] backdrop-blur-md shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 严格对齐至 1360px 统一中轴 */}
      <div className="w-full max-w-[1360px] mx-auto flex items-center justify-between gap-3">
        {/* 左侧：页面标题与视频文件名 */}
        <div className="flex items-center gap-3 min-w-0 shrink" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <span className="text-sm font-bold text-white tracking-wide shrink-0">{activeTabTitle}</span>
          {currentVideoName && (
            <span className="text-xs text-zinc-400 bg-white/5 border border-white/10 px-2.5 py-1 rounded-md font-mono truncate max-w-[160px] md:max-w-[240px] xl:max-w-[340px]">
              🎬 {currentVideoName}
            </span>
          )}
        </div>

        {/* 中间：模式切换胶囊（仅在有视频加载且处于裁剪工作台时显示，无冗余说明文字） */}
        {workbenchMode && onWorkbenchModeChange && (
          <div
            className="flex items-center bg-black/60 border border-white/10 p-0.5 rounded-xl shrink-0 select-none mx-auto"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <button
              type="button"
              onClick={() => onWorkbenchModeChange('temporal')}
              aria-pressed={workbenchMode === 'temporal'}
              className={`px-3 py-1 rounded-lg flex items-center gap-1.5 text-xs transition-all active:scale-95 ${
                workbenchMode === 'temporal'
                  ? 'bg-blue-600 text-white font-bold shadow-sm shadow-blue-600/30'
                  : 'text-zinc-400 hover:text-white hover:bg-white/5 font-medium'
              }`}
              title="进入时间剪辑模式：操作切点、分段保全与试听"
            >
              <span>⏱️</span>
              <span>时间分段剪辑</span>
            </button>
            <button
              type="button"
              onClick={() => onWorkbenchModeChange('spatial')}
              aria-pressed={workbenchMode === 'spatial'}
              className={`px-3 py-1 rounded-lg flex items-center gap-1.5 text-xs transition-all active:scale-95 ${
                workbenchMode === 'spatial'
                  ? 'bg-[#8957e5] text-white font-bold shadow-sm shadow-purple-600/30'
                  : 'text-zinc-400 hover:text-white hover:bg-white/5 font-medium'
              }`}
              title="进入画面空间修饰模式：画幅裁切与去水印遮罩"
            >
              <span>📐</span>
              <span>画面空间修饰</span>
              {hasSpatialActive && (
                <span className="w-1.5 h-1.5 rounded-full bg-purple-300 animate-pulse ml-0.5" title="包含已生效的空间滤镜" />
              )}
            </button>
          </div>
        )}

        {/* 右侧动作区：留出 pr-36 (约144px) 避开右上角原生窗口控制按钮 */}
        <div
          className="flex items-center gap-2.5 pr-36 shrink-0"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {renderStatusPill()}

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
