import React from 'react';
import {
  Scissors,
  Crop,
  ShieldAlert,
  RotateCcw,
  Lock,
  Unlock,
  Plus,
  Globe,
  Sparkles,
} from 'lucide-react';

export type WorkbenchMode = 'temporal' | 'spatial';
export type SpatialSubMode = 'crop' | 'mask';
export type CropRatioType = 'free' | 'source' | '16:9' | '9:16' | '1:1';
export type MaskType = 'delogo' | 'black' | 'mosaic';
export type SpatialScope = 'global' | 'segment';

export interface WorkbenchModeBarProps {
  mode: WorkbenchMode;
  onModeChange: (mode: WorkbenchMode) => void;
  subMode: SpatialSubMode;
  onSubModeChange: (sub: SpatialSubMode) => void;
  // 裁切控制
  cropRatio: CropRatioType;
  onCropRatioChange: (ratio: CropRatioType) => void;
  isCropLocked: boolean;
  onToggleCropLock: () => void;
  onResetCropToFull: () => void;
  // 遮罩控制
  activeMaskType: MaskType;
  onActiveMaskTypeChange: (type: MaskType) => void;
  onAddMask: () => void;
  // 作用域控制
  scope: SpatialScope;
  onToggleScope: () => void;
  currentSegmentIndex?: number;
  hasSpatialActive?: boolean;
}

export const WorkbenchModeBar: React.FC<WorkbenchModeBarProps> = ({
  mode,
  onModeChange,
  subMode,
  onSubModeChange,
  cropRatio,
  onCropRatioChange,
  isCropLocked,
  onToggleCropLock,
  onResetCropToFull,
  activeMaskType,
  onActiveMaskTypeChange,
  onAddMask,
  scope,
  onToggleScope,
  currentSegmentIndex = 1,
  hasSpatialActive = false,
}) => {
  const isSpatial = mode === 'spatial';
  const isCrop = subMode === 'crop';

  return (
    <div className="w-full bg-[#161b22]/90 border border-white/10 rounded-2xl p-2 sm:p-2.5 shadow-xl flex flex-col gap-2 shrink-0 select-none backdrop-blur-md">
      {/* 顶层：双模式解耦控制胶囊 */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center bg-black/60 border border-white/10 p-1 rounded-xl gap-1">
          {/* 时间剪辑模式 */}
          <button
            onClick={() => onModeChange('temporal')}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-2 text-xs transition-all active:scale-95 ${
              !isSpatial
                ? 'bg-blue-600 text-white font-bold shadow-md shadow-blue-600/30'
                : 'text-zinc-400 hover:text-white hover:bg-white/5 font-medium'
            }`}
            title="进入时间剪辑模式：操作切点、分段保全与试听"
          >
            <span>⏱️</span>
            <span className="text-xs font-semibold">时间分段剪辑</span>
            <span className="hidden md:inline text-[11px] opacity-75">· 精确切点与关键帧吸附</span>
          </button>

          {/* 画面空间修饰模式 */}
          <button
            onClick={() => onModeChange('spatial')}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-2 text-xs transition-all active:scale-95 ${
              isSpatial
                ? 'bg-[#8957e5] text-white font-bold shadow-md shadow-purple-600/30'
                : 'text-zinc-400 hover:text-white hover:bg-white/5 font-medium'
            }`}
            title="进入画面空间修饰模式：画幅裁切与去水印遮罩"
          >
            <span>📐</span>
            <span className="text-xs font-semibold">画面空间修饰</span>
            <span className="hidden md:inline text-[11px] opacity-75">· 画幅裁切与去水印遮罩</span>
            {hasSpatialActive && (
              <span className="w-2 h-2 rounded-full bg-purple-300 animate-pulse ml-0.5" title="当前已包含生效的空间滤镜" />
            )}
          </button>
        </div>

        {/* 提示与状态指示 */}
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          {isSpatial ? (
            <span className="flex items-center gap-1.5 text-purple-300 font-medium">
              <Sparkles className="w-3.5 h-3.5 text-purple-400 shrink-0" />
              <span>空间修饰已激活：拉动画布边角手柄裁切，或添加遮罩消除台标水印</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-zinc-400">
              <span>💡</span>
              <span className="hidden sm:inline">时间剪辑与空间修饰物理解耦，所有修改统一汇聚存入同一方案</span>
            </span>
          )}
        </div>
      </div>

      {/* 空间修饰二级控制工具条 (仅在空间模式下展开) */}
      {isSpatial && (
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/5 flex-wrap">
          <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
            {/* 子模式切换：构图裁切 vs 去水印遮罩 */}
            <div className="flex items-center bg-black/60 border border-white/10 p-0.5 rounded-lg gap-0.5">
              <button
                onClick={() => onSubModeChange('crop')}
                className={`px-2.5 py-1 rounded-md text-xs flex items-center gap-1.5 transition-all ${
                  isCrop
                    ? 'bg-blue-600 text-white font-bold shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Crop className="w-3 h-3" />
                <span>画面裁切 (构图)</span>
              </button>

              <button
                onClick={() => onSubModeChange('mask')}
                className={`px-2.5 py-1 rounded-md text-xs flex items-center gap-1.5 transition-all ${
                  !isCrop
                    ? 'bg-purple-600 text-white font-bold shadow-sm'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <ShieldAlert className="w-3 h-3" />
                <span>去水印与遮罩</span>
              </button>
            </div>

            {/* 裁切子工具组 */}
            {isCrop ? (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-zinc-400">比例:</span>
                <div className="flex items-center bg-black/50 border border-white/10 p-0.5 rounded-lg text-xs gap-0.5">
                  <button
                    onClick={() => onCropRatioChange('free')}
                    className={`px-2 py-0.5 rounded transition-all text-xs ${
                      cropRatio === 'free'
                        ? 'bg-white/15 text-blue-300 font-semibold'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    自由
                  </button>
                  <button
                    onClick={() => onCropRatioChange('source')}
                    className={`px-2 py-0.5 rounded transition-all text-xs ${
                      cropRatio === 'source' || cropRatio === '16:9'
                        ? 'bg-white/15 text-blue-300 font-semibold'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    原片比例
                  </button>
                  <button
                    onClick={() => onCropRatioChange('9:16')}
                    className={`px-2 py-0.5 rounded transition-all text-xs ${
                      cropRatio === '9:16'
                        ? 'bg-white/15 text-blue-300 font-semibold'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    9:16 竖屏
                  </button>
                  <button
                    onClick={() => onCropRatioChange('1:1')}
                    className={`px-2 py-0.5 rounded transition-all text-xs ${
                      cropRatio === '1:1'
                        ? 'bg-white/15 text-blue-300 font-semibold'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    1:1 正方
                  </button>
                </div>

                <button
                  onClick={onToggleCropLock}
                  className={`px-2 py-1 rounded-lg border text-xs flex items-center gap-1 transition-all active:scale-95 ${
                    isCropLocked
                      ? 'bg-blue-600/20 text-blue-300 border-blue-500/40 font-semibold'
                      : 'bg-white/5 text-zinc-400 hover:text-white border-white/10'
                  }`}
                  title="锁定画幅长宽比，缩放时保持比例不变"
                >
                  {isCropLocked ? <Lock className="w-3 h-3 text-blue-400" /> : <Unlock className="w-3 h-3" />}
                  <span>比例锁: {isCropLocked ? '开' : '关'}</span>
                </button>

                <button
                  onClick={onResetCropToFull}
                  className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white border border-white/10 text-xs flex items-center gap-1 transition-all active:scale-95"
                  title="还原为 100% 全画幅未裁切状态"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>还原全画幅</span>
                </button>
              </div>
            ) : (
              /* 遮罩子工具组 */
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-zinc-400">修补类型:</span>
                <div className="flex items-center bg-black/50 border border-white/10 p-0.5 rounded-lg text-xs gap-0.5">
                  <button
                    onClick={() => onActiveMaskTypeChange('delogo')}
                    className={`px-2 py-0.5 rounded transition-all text-xs flex items-center gap-1 ${
                      activeMaskType === 'delogo'
                        ? 'bg-blue-600/30 text-blue-300 font-semibold border border-blue-500/30'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <span>💧</span>
                    <span>去水印 (delogo 插值)</span>
                  </button>
                  <button
                    onClick={() => onActiveMaskTypeChange('black')}
                    className={`px-2 py-0.5 rounded transition-all text-xs flex items-center gap-1 ${
                      activeMaskType === 'black'
                        ? 'bg-zinc-700/50 text-white font-semibold border border-white/20'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <span>⬛</span>
                    <span>纯黑遮蔽</span>
                  </button>
                  <button
                    onClick={() => onActiveMaskTypeChange('mosaic')}
                    className={`px-2 py-0.5 rounded transition-all text-xs flex items-center gap-1 ${
                      activeMaskType === 'mosaic'
                        ? 'bg-purple-600/30 text-purple-300 font-semibold border border-purple-500/30'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <span>🌫️</span>
                    <span>马赛克模糊</span>
                  </button>
                </div>

                <button
                  onClick={onAddMask}
                  className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1 transition-all shadow-md active:scale-95"
                  title="在画面中央添加一个新的遮罩选区"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>添加修补框</span>
                </button>
              </div>
            )}
          </div>

          {/* 作用域指示器：全片全局生效 vs 局部片段覆盖 */}
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleScope}
              className={`px-2.5 py-1 rounded-xl border text-xs font-mono flex items-center gap-1.5 transition-all active:scale-95 ${
                scope === 'global'
                  ? 'bg-blue-500/10 text-blue-300 border-blue-500/30 hover:bg-blue-500/20'
                  : 'bg-purple-500/15 text-purple-300 border-purple-500/40 hover:bg-purple-500/25 font-bold'
              }`}
              title="点击切换：全片全局生效 或 仅作用于当前选中分段"
            >
              {scope === 'global' ? (
                <>
                  <Globe className="w-3 h-3 text-blue-400" />
                  <span>🌐 全片全局生效 (默认)</span>
                </>
              ) : (
                <>
                  <Scissors className="w-3 h-3 text-purple-400" />
                  <span>✂️ 仅作用于片段 #{currentSegmentIndex} (局部覆盖)</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
