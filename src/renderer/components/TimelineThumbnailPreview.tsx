import React, { useEffect, useRef, useState } from 'react';
import { formatTimecode } from './VideoPlayer';

interface TimelineThumbnailPreviewProps {
  videoPath?: string;
  targetMs: number;
  anchorX: number;
  containerWidth: number;
  visible: boolean;
  isSnapped: boolean;
  isHitBarrier: boolean;
}

export const TimelineThumbnailPreview: React.FC<TimelineThumbnailPreviewProps> = ({
  videoPath,
  targetMs,
  anchorX,
  containerWidth,
  visible,
  isSnapped,
  isHitBarrier,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [videoPath, visible]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !visible || isNaN(targetMs)) return;

    const targetSec = Math.max(0, targetMs / 1000);
    // 只有在差值超过 20ms 时才执行 seek，提升 60FPS 拖拽流畅度
    if (video.readyState && Math.abs(video.currentTime - targetSec) > 0.001) {
      video.currentTime = targetSec;
    }
  }, [targetMs, visible, videoPath]);

  if (!visible || !videoPath) return null;

  const cardWidth = 160;
  // 防边界溢出计算：确保卡片始终留在时间轴容器可视范围内
  const minLeft = 8;
  const maxLeft = Math.max(minLeft, containerWidth - cardWidth - 8);
  const clampedLeft = Math.max(minLeft, Math.min(maxLeft, anchorX - cardWidth / 2));
  // 小三角形箭头的横向偏移（指示具体切点）
  const arrowOffset = Math.max(12, Math.min(cardWidth - 12, anchorX - clampedLeft));

  const mediaUrl = `media://video?path=${encodeURIComponent(videoPath.replace(/\\/g, '/'))}`;

  return (
    <div
      className="absolute bottom-full mb-2 z-40 pointer-events-none select-none transition-transform duration-75 ease-out animate-in fade-in zoom-in-95"
      style={{ left: `${clampedLeft}px` }}
    >
      {/* 悬浮微型画格主卡片 */}
      <div className="w-40 bg-[#0c0e14]/95 border border-white/20 rounded-xl overflow-hidden shadow-2xl shadow-blue-500/20 backdrop-blur-md flex flex-col">
        {/* 16:9 画格预览视窗 */}
        <div className="w-full h-[90px] bg-black relative flex items-center justify-center overflow-hidden">
          <video
            ref={videoRef}
            src={mediaUrl}
            onLoadedMetadata={() => { if (videoRef.current) videoRef.current.currentTime = Math.max(0, targetMs / 1000); }}
            onError={() => setFailed(true)}
            preload="auto"
            muted
            playsInline
            className="w-full h-full object-contain"
          />
          {failed && <span className="absolute text-[10px] text-zinc-400">此格式暂不支持小窗预览</span>}
        </div>

        {/* 底部信息与吸附状态徽章 */}
        <div className="px-2 py-1.5 bg-[#161b22] border-t border-white/10 flex flex-col gap-1">
          <div className="flex items-center justify-between font-mono text-[10px]">
            <span className="text-zinc-400">切点:</span>
            <span className="text-white font-bold tracking-tight">
              {formatTimecode(targetMs, true)}
            </span>
          </div>

          {/* 状态徽标 */}
          {isSnapped ? (
            <div className="flex items-center gap-1 text-[9px] font-mono text-cyan-300 bg-cyan-500/15 border border-cyan-400/30 px-1.5 py-0.5 rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping shrink-0" />
              <span>● 关键帧已吸附</span>
            </div>
          ) : isHitBarrier ? (
            <div className="flex items-center gap-1 text-[9px] font-mono text-rose-300 bg-rose-500/15 border border-rose-400/30 px-1.5 py-0.5 rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
              <span>已达相邻切点极限</span>
            </div>
          ) : (
            <div className="text-[9px] text-zinc-400 font-sans truncate">
              长按拖拽微调中...
            </div>
          )}
        </div>
      </div>

      {/* 底部倒三角箭头指向切点 */}
      <div
        className="w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-[#161b22] absolute top-full"
        style={{ left: `${arrowOffset - 4}px` }}
      />
    </div>
  );
};
