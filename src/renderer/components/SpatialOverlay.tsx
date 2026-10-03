import React, { useRef, useState, useEffect } from 'react';
import { SpatialCropBox, SpatialMaskItem } from '../../shared/types';
import { makeEven } from '../../shared/spatialFiltergraph';
import { FloatingLayerInspector } from './FloatingLayerInspector';
import { SpatialSubMode } from './WorkbenchModeBar';

export interface SpatialOverlayProps {
  videoWidth: number;
  videoHeight: number;
  displayAspectRatio?: number;
  subMode: SpatialSubMode;
  cropBox?: SpatialCropBox;
  isCropLocked?: boolean;
  onCropChange: (crop: SpatialCropBox) => void;
  masks: SpatialMaskItem[];
  selectedMaskId?: string | null;
  onSelectMask: (id: string | null) => void;
  onMaskChange: (mask: SpatialMaskItem) => void;
  onDeleteMask: (id: string) => void;
  onAddMask: () => void;
}

type DragAction =
  | { type: 'move_crop'; startX: number; startY: number; initialBox: SpatialCropBox }
  | { type: 'resize_crop'; handle: string; startX: number; startY: number; initialBox: SpatialCropBox }
  | { type: 'move_mask'; maskId: string; startX: number; startY: number; initialMask: SpatialMaskItem }
  | { type: 'resize_mask'; maskId: string; startX: number; startY: number; initialMask: SpatialMaskItem };

export const SpatialOverlay: React.FC<SpatialOverlayProps> = ({
  videoWidth,
  videoHeight,
  displayAspectRatio,
  subMode,
  cropBox,
  isCropLocked = false,
  onCropChange,
  masks,
  selectedMaskId,
  onSelectMask,
  onMaskChange,
  onDeleteMask,
  onAddMask,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragAction, setDragAction] = useState<DragAction | null>(null);
  const [temporary, setTemporary] = useState<{ crop?: SpatialCropBox; mask?: SpatialMaskItem } | null>(null);
  const pending = useRef<typeof temporary>(null);
  const callbacks = useRef({ onCropChange, onMaskChange });
  callbacks.current = { onCropChange, onMaskChange };

  // 默认满画幅裁切框 fallback
  const effectiveCrop = temporary?.crop || cropBox || {
    x: 0,
    y: 0,
    width: videoWidth,
    height: videoHeight,
    ratio: 'free',
    locked: isCropLocked,
  };

  // 全局鼠标指针移动与抬起监听
  useEffect(() => {
    if (!dragAction) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const deltaX = (e.clientX - dragAction.startX) * (videoWidth / rect.width);
      const deltaY = (e.clientY - dragAction.startY) * (videoHeight / rect.height);

      if (dragAction.type === 'move_crop') {
        const { initialBox } = dragAction;
        const newX = makeEven(Math.max(0, Math.min(videoWidth - initialBox.width, Math.round(initialBox.x + deltaX))));
        const newY = makeEven(Math.max(0, Math.min(videoHeight - initialBox.height, Math.round(initialBox.y + deltaY))));

        pending.current = { crop: {
          ...initialBox,
          x: newX,
          y: newY,
        } }; setTemporary(pending.current);
      } else if (dragAction.type === 'resize_crop') {
        const { initialBox, handle } = dragAction;
        let x = initialBox.x;
        let y = initialBox.y;
        let w = initialBox.width;
        let h = initialBox.height;

        if (handle.includes('w')) {
          const maxLeft = initialBox.x + initialBox.width - 20;
          x = makeEven(Math.max(0, Math.min(maxLeft, Math.round(initialBox.x + deltaX))));
          w = initialBox.x + initialBox.width - x;
        } else if (handle.includes('e')) {
          w = makeEven(Math.max(20, Math.min(videoWidth - initialBox.x, Math.round(initialBox.width + deltaX))));
        }

        if (handle.includes('n')) {
          const maxTop = initialBox.y + initialBox.height - 20;
          y = makeEven(Math.max(0, Math.min(maxTop, Math.round(initialBox.y + deltaY))));
          h = initialBox.y + initialBox.height - y;
        } else if (handle.includes('s')) {
          h = makeEven(Math.max(20, Math.min(videoHeight - initialBox.y, Math.round(initialBox.height + deltaY))));
        }

        // 比例锁检查
        if (isCropLocked || (initialBox.ratio && initialBox.ratio !== 'free')) {
          let targetRatio = initialBox.width / initialBox.height;
          const pixelAspect = (displayAspectRatio || videoWidth / videoHeight) / (videoWidth / videoHeight);
          if (initialBox.ratio === '16:9') targetRatio = 16 / 9 / pixelAspect;
          else if (initialBox.ratio === 'source') targetRatio = videoWidth / videoHeight;
          else if (initialBox.ratio === '9:16') targetRatio = 9 / 16 / pixelAspect;
          else if (initialBox.ratio === '1:1') targetRatio = 1 / pixelAspect;

          if (handle.includes('w') || handle.includes('e')) {
            h = makeEven(Math.round(w / targetRatio));
            if (y + h > videoHeight) {
              h = videoHeight - y;
              w = makeEven(Math.round(h * targetRatio));
            }
          } else {
            w = makeEven(Math.round(h * targetRatio));
            if (x + w > videoWidth) {
              w = videoWidth - x;
              h = makeEven(Math.round(w / targetRatio));
            }
          }
        }

        pending.current = { crop: {
          ...initialBox,
          x: makeEven(x),
          y: makeEven(y),
          width: makeEven(w),
          height: makeEven(h),
        } }; setTemporary(pending.current);
      } else if (dragAction.type === 'move_mask') {
        const { initialMask } = dragAction;
        const margin = initialMask.type === 'delogo' ? 2 : 0;
        const newX = makeEven(Math.max(margin, Math.min(videoWidth - initialMask.width - margin, Math.round(initialMask.x + deltaX))));
        const newY = makeEven(Math.max(margin, Math.min(videoHeight - initialMask.height - margin, Math.round(initialMask.y + deltaY))));

        pending.current = { mask: {
          ...initialMask,
          x: newX,
          y: newY,
        } }; setTemporary(pending.current);
      } else if (dragAction.type === 'resize_mask') {
        const { initialMask } = dragAction;
        const margin = initialMask.type === 'delogo' ? 2 : 0;
        const newW = makeEven(Math.max(2, Math.min(videoWidth - initialMask.x - margin, Math.max(16, Math.round(initialMask.width + deltaX)))));
        const newH = makeEven(Math.max(2, Math.min(videoHeight - initialMask.y - margin, Math.max(16, Math.round(initialMask.height + deltaY)))));

        pending.current = { mask: {
          ...initialMask,
          width: newW,
          height: newH,
        } }; setTemporary(pending.current);
      }
    };

    const handleMouseUp = () => {
      const value = pending.current;
      if (value?.crop) callbacks.current.onCropChange(value.crop);
      if (value?.mask) callbacks.current.onMaskChange(value.mask);
      pending.current = null; setTemporary(null);
      setDragAction(null);
    };
    const cancel = () => { pending.current = null; setTemporary(null); setDragAction(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape);
      pending.current = null;
    };
  }, [dragAction, videoWidth, videoHeight, displayAspectRatio, isCropLocked]);

  // 开始拖拽裁切框
  const handleStartMoveCrop = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDragAction({
      type: 'move_crop',
      startX: e.clientX,
      startY: e.clientY,
      initialBox: { ...effectiveCrop },
    });
  };

  // 开始缩放裁切框
  const handleStartResizeCrop = (e: React.MouseEvent, handle: string) => {
    e.stopPropagation();
    setDragAction({
      type: 'resize_crop',
      handle,
      startX: e.clientX,
      startY: e.clientY,
      initialBox: { ...effectiveCrop },
    });
  };

  // 开始拖拽遮罩框
  const handleStartMoveMask = (e: React.MouseEvent, mask: SpatialMaskItem) => {
    e.stopPropagation();
    onSelectMask(mask.id);
    setDragAction({
      type: 'move_mask',
      maskId: mask.id,
      startX: e.clientX,
      startY: e.clientY,
      initialMask: { ...mask },
    });
  };

  // 开始缩放遮罩框
  const handleStartResizeMask = (e: React.MouseEvent, mask: SpatialMaskItem) => {
    e.stopPropagation();
    onSelectMask(mask.id);
    setDragAction({
      type: 'resize_mask',
      maskId: mask.id,
      startX: e.clientX,
      startY: e.clientY,
      initialMask: { ...mask },
    });
  };

  const isCropMode = subMode === 'crop';

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-auto overflow-hidden select-none z-20"
      onClick={() => onSelectMask(null)}
    >
      {/* 1. 裁切选区交互框 (在裁切子模式下可交互，在遮罩模式下半透明呈现或隐藏) */}
      {isCropMode && (
        <div
          onMouseDown={handleStartMoveCrop}
          style={{
            left: `${(effectiveCrop.x / videoWidth) * 100}%`,
            top: `${(effectiveCrop.y / videoHeight) * 100}%`,
            width: `${(effectiveCrop.width / videoWidth) * 100}%`,
            height: `${(effectiveCrop.height / videoHeight) * 100}%`,
          }}
          className="absolute border-2 border-dashed border-blue-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] cursor-move transition-[border-color] group"
        >
          {/* 三分法则网格参考线 */}
          <div className="absolute top-[33.33%] left-0 right-0 h-[1px] bg-blue-400/25 pointer-events-none" />
          <div className="absolute top-[66.66%] left-0 right-0 h-[1px] bg-blue-400/25 pointer-events-none" />
          <div className="absolute left-[33.33%] top-0 bottom-0 w-[1px] bg-blue-400/25 pointer-events-none" />
          <div className="absolute left-[66.66%] top-0 bottom-0 w-[1px] bg-blue-400/25 pointer-events-none" />

          {/* 8 个方向手柄 */}
          <div
            onMouseDown={(e) => handleStartResizeCrop(e, 'nw')}
            className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-blue-500 border-2 border-white rounded-sm shadow-md cursor-nwse-resize"
          />
          <div
            onMouseDown={(e) => handleStartResizeCrop(e, 'ne')}
            className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-blue-500 border-2 border-white rounded-sm shadow-md cursor-nesw-resize"
          />
          <div
            onMouseDown={(e) => handleStartResizeCrop(e, 'sw')}
            className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-blue-500 border-2 border-white rounded-sm shadow-md cursor-nesw-resize"
          />
          <div
            onMouseDown={(e) => handleStartResizeCrop(e, 'se')}
            className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-blue-500 border-2 border-white rounded-sm shadow-md cursor-nwse-resize"
          />
          <div
            onMouseDown={(e) => handleStartResizeCrop(e, 'n')}
            className="absolute -top-1.5 left-[calc(50%-6px)] w-3 h-3 bg-blue-500 border-2 border-white rounded-sm shadow-md cursor-ns-resize"
          />
          <div
            onMouseDown={(e) => handleStartResizeCrop(e, 's')}
            className="absolute -bottom-1.5 left-[calc(50%-6px)] w-3 h-3 bg-blue-500 border-2 border-white rounded-sm shadow-md cursor-ns-resize"
          />
          <div
            onMouseDown={(e) => handleStartResizeCrop(e, 'w')}
            className="absolute top-[calc(50%-6px)] -left-1.5 w-3 h-3 bg-blue-500 border-2 border-white rounded-sm shadow-md cursor-ew-resize"
          />
          <div
            onMouseDown={(e) => handleStartResizeCrop(e, 'e')}
            className="absolute top-[calc(50%-6px)] -right-1.5 w-3 h-3 bg-blue-500 border-2 border-white rounded-sm shadow-md cursor-ew-resize"
          />

          {/* 实时物理像素与比例徽章 */}
          <div
            className={`absolute ${
              effectiveCrop.y < 32 ? 'top-2 left-2' : '-top-7 left-0'
            } bg-[#0d1117]/95 border border-blue-400/40 text-blue-300 font-mono text-[11px] px-2 py-0.5 rounded shadow-lg pointer-events-none whitespace-nowrap z-10 flex items-center gap-1.5`}
          >
            <span>
              {effectiveCrop.width === videoWidth && effectiveCrop.height === videoHeight
                ? '全画幅 (未裁切)'
                : `裁切画幅: ${effectiveCrop.width} × ${effectiveCrop.height}`}
            </span>
            <span className="text-zinc-500">|</span>
            <span className="text-zinc-400 font-sans">
              {effectiveCrop.ratio === '9:16'
                ? '9:16 竖屏'
                : effectiveCrop.ratio === '1:1'
                ? '1:1 正方'
                : effectiveCrop.ratio === 'source'
                ? '原片比例'
                : effectiveCrop.ratio === '16:9'
                ? '16:9 横屏'
                : '自由比例'}
            </span>
          </div>
        </div>
      )}

      {/* 2. 遮罩选区修补框列表 */}
      {masks.map((savedMask) => {
        const mask = temporary?.mask?.id === savedMask.id ? temporary.mask : savedMask;
        const isSelected = mask.id === selectedMaskId;
        const isDelogo = mask.type === 'delogo';
        const isBlack = mask.type === 'black';

        return (
          <div
            key={mask.id}
            onMouseDown={(e) => handleStartMoveMask(e, mask)}
            style={{
              left: `${(mask.x / videoWidth) * 100}%`,
              top: `${(mask.y / videoHeight) * 100}%`,
              width: `${(mask.width / videoWidth) * 100}%`,
              height: `${(mask.height / videoHeight) * 100}%`,
            }}
            className={`absolute rounded cursor-move transition-shadow ${
              isSelected ? 'ring-2 ring-white shadow-2xl z-20' : 'z-10'
            } ${
              isDelogo
                ? 'border-2 border-blue-400 bg-blue-500/25 backdrop-blur-[6px]'
                : isBlack
                ? 'bg-black border border-zinc-700'
                : 'border-2 border-dashed border-purple-400 bg-[repeating-linear-gradient(45deg,rgba(188,140,255,0.25)_0,rgba(188,140,255,0.25)_4px,rgba(0,0,0,0.6)_4px,rgba(0,0,0,0.6)_8px)]'
            }`}
          >
            {/* 顶部标签 */}
            <div
              className={`absolute -top-5 left-0 text-[10px] font-bold px-1.5 py-0.2 rounded bg-[#161b24]/90 border border-white/20 text-white whitespace-nowrap pointer-events-none ${
                isSelected ? 'border-blue-400 text-blue-200' : ''
              }`}
            >
              {isDelogo ? '💧 去水印' : isBlack ? '⬛ 纯黑遮罩' : '🌫️ 马赛克'}
            </div>

            {/* 右下角缩放手柄 */}
            <div
              onMouseDown={(e) => handleStartResizeMask(e, mask)}
              className="absolute -bottom-1 -right-1 w-2.5 h-2.5 bg-white border border-black rounded-sm shadow cursor-nwse-resize"
              title="拖动调整大小"
            />
          </div>
        );
      })}

      {/* 3. 视窗右侧浮动图层面板 (在遮罩子模式下呈现) */}
      {!isCropMode && (
        <FloatingLayerInspector
          masks={masks}
          selectedMaskId={selectedMaskId}
          onSelectMask={onSelectMask}
          onDeleteMask={onDeleteMask}
          onAddMask={onAddMask}
        />
      )}
    </div>
  );
};
