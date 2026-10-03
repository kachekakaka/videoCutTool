import React from 'react';
import { SpatialMaskItem } from '../../shared/types';
import { Shield, Plus, Trash2, X } from 'lucide-react';

export interface FloatingLayerInspectorProps {
  masks: SpatialMaskItem[];
  selectedMaskId?: string | null;
  onSelectMask: (id: string) => void;
  onDeleteMask: (id: string) => void;
  onAddMask: () => void;
  onClose?: () => void;
}

export const FloatingLayerInspector: React.FC<FloatingLayerInspectorProps> = ({
  masks,
  selectedMaskId,
  onSelectMask,
  onDeleteMask,
  onAddMask,
  onClose,
}) => {
  const getTypeMeta = (type: SpatialMaskItem['type']) => {
    switch (type) {
      case 'delogo':
        return { icon: '💧', label: '去水印 (delogo)', color: 'text-blue-400' };
      case 'black':
        return { icon: '⬛', label: '纯黑遮蔽', color: 'text-zinc-300' };
      case 'mosaic':
        return { icon: '🌫️', label: '马赛克模糊', color: 'text-purple-400' };
      default:
        return { icon: '🛡️', label: '遮罩修补', color: 'text-zinc-300' };
    }
  };

  return (
    <div className="absolute top-3 right-3 w-64 max-h-[calc(100%-24px)] bg-[#161b24]/95 border border-white/15 rounded-2xl shadow-2xl backdrop-blur-xl flex flex-col z-30 overflow-hidden select-none animate-in fade-in zoom-in-95 duration-150">
      {/* 头部标题与添加按钮 */}
      <div className="px-3 py-2.5 border-b border-white/10 flex items-center justify-between shrink-0 bg-black/30">
        <div className="flex items-center gap-1.5 text-xs font-bold text-white">
          <Shield className="w-3.5 h-3.5 text-purple-400" />
          <span>画面遮罩图层 ({masks.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onAddMask}
            className="px-2 py-0.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold flex items-center gap-1 transition-all active:scale-95 shadow-sm"
            title="添加新的遮罩修补框"
          >
            <Plus className="w-3 h-3" />
            <span>选区</span>
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
              title="收起图层面板"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 图层卡片列表 */}
      <div className="p-2 overflow-y-auto flex flex-col gap-1.5 flex-1 min-h-0">
        {masks.length === 0 ? (
          <div className="p-4 text-center text-xs text-zinc-400 leading-relaxed">
            <span className="block text-2xl mb-1">🛡️</span>
            暂无画面修补框
            <span className="block text-[11px] text-zinc-500 mt-1">
              点击上方「+ 选区」即可添加去水印或马赛克遮罩
            </span>
          </div>
        ) : (
          masks.map((mask, index) => {
            const isSelected = mask.id === selectedMaskId;
            const meta = getTypeMeta(mask.type);
            const title = mask.name || `${meta.label} #${index + 1}`;

            return (
              <div
                key={mask.id}
                onClick={() => onSelectMask(mask.id)}
                className={`flex items-center justify-between px-2.5 py-1.5 rounded-xl border text-xs transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-blue-600/20 border-blue-500/60 text-white shadow-sm'
                    : 'bg-[#0d1117]/80 border-white/5 text-zinc-300 hover:border-white/20 hover:bg-[#0d1117]'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="shrink-0">{meta.icon}</span>
                  <span className="truncate font-medium text-[11.5px]">{title}</span>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteMask(mask.id);
                  }}
                  className="p-1 rounded text-zinc-400 hover:text-rose-400 hover:bg-rose-500/15 transition-all shrink-0 ml-1"
                  title="删除该修补遮罩"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
