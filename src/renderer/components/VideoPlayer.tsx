import { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react';

export interface VideoPlayerRef {
  seekTo: (timeMs: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  stepFrame: (deltaFrames: number) => void;
  stepSeconds: (seconds: number) => void;
  getCurrentTimeMs: () => number;
  getIsPlaying: () => boolean;
}

interface VideoPlayerProps {
  videoPath: string;
  durationMs: number;
  onTimeUpdate: (timeMs: number) => void;
  onPlayStateChange?: (isPlaying: boolean) => void;
  onInsertCut?: () => void;
  aspectRatioMode?: 'auto' | '16:9' | '1:1';
  auditionRange?: { startMs: number; endMs: number } | null;
  onAuditionEnd?: () => void;
}

export { formatTimecode, parseTimecodeToMs } from '../../shared/timeUtils';

export const VideoPlayer = forwardRef<VideoPlayerRef, VideoPlayerProps>(
  (
    {
      videoPath,
      durationMs,
      onTimeUpdate,
      onPlayStateChange,
      onInsertCut,
      aspectRatioMode = 'auto',
      auditionRange,
      onAuditionEnd,
    },
    ref
  ) => {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTimeMs, setCurrentTimeMs] = useState(0);

    const updatePlayState = (playing: boolean) => {
      setIsPlaying(playing);
      if (onPlayStateChange) {
        onPlayStateChange(playing);
      }
    };

    const togglePlay = () => {
      if (!videoRef.current) return;
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play().catch(() => {});
      }
    };

    // 逐帧步进 (约 40ms / 1帧 25~30fps)
    const stepFrame = (deltaFrames: number) => {
      if (!videoRef.current) return;
      videoRef.current.pause();
      const frameDeltaSec = 0.04; // 1帧约为 40ms
      const newTime = Math.max(
        0,
        Math.min(durationMs / 1000, videoRef.current.currentTime + deltaFrames * frameDeltaSec)
      );
      videoRef.current.currentTime = newTime;
    };

    // 快进/快退 (1秒)
    const stepSeconds = (seconds: number) => {
      if (!videoRef.current) return;
      const newTime = Math.max(0, Math.min(durationMs / 1000, videoRef.current.currentTime + seconds));
      videoRef.current.currentTime = newTime;
    };

    useImperativeHandle(ref, () => ({
      seekTo: (timeMs: number) => {
        if (videoRef.current) {
          videoRef.current.currentTime = timeMs / 1000;
          setCurrentTimeMs(timeMs);
          onTimeUpdate(timeMs);
        }
      },
      play: () => videoRef.current?.play(),
      pause: () => videoRef.current?.pause(),
      togglePlay,
      stepFrame,
      stepSeconds,
      getCurrentTimeMs: () => currentTimeMs,
      getIsPlaying: () => isPlaying,
    }));

    // 处理试听区间循环
    useEffect(() => {
      if (auditionRange && videoRef.current) {
        videoRef.current.currentTime = auditionRange.startMs / 1000;
        videoRef.current.play().catch(() => {});
      }
    }, [auditionRange]);

    const handleVideoTimeUpdate = () => {
      if (!videoRef.current) return;
      const currentMs = Math.round(videoRef.current.currentTime * 1000);
      setCurrentTimeMs(currentMs);
      onTimeUpdate(currentMs);

      // 如果在试听模式下到达区间终点
      if (auditionRange && currentMs >= auditionRange.endMs) {
        videoRef.current.pause();
        if (onAuditionEnd) onAuditionEnd();
      }
    };


    // 键盘全局快捷键
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        // 如果正在输入框中打字，不拦截快捷键
        if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
          return;
        }

        if (e.code === 'Space') {
          e.preventDefault();
          togglePlay();
        } else if (e.code === 'ArrowLeft') {
          e.preventDefault();
          if (e.shiftKey) stepSeconds(-1);
          else stepFrame(-1);
        } else if (e.code === 'ArrowRight') {
          e.preventDefault();
          if (e.shiftKey) stepSeconds(1);
          else stepFrame(1);
        } else if (e.code === 'KeyC') {
          e.preventDefault();
          onInsertCut?.();
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isPlaying, durationMs, onInsertCut]);

    // 安全组装媒体流地址 (使用标准的 query param 承载绝对路径)
    const toMediaUrl = (filePath: string): string => {
      if (!filePath) return '';
      if (filePath.startsWith('http://') || filePath.startsWith('https://')) return filePath;
      if (filePath.startsWith('media://')) return filePath;
      return `media://video?path=${encodeURIComponent(filePath)}`;
    };

    const videoSource = toMediaUrl(videoPath);

    return (
      <div className="w-full flex-1 min-h-[240px] flex flex-col rounded-2xl overflow-hidden bg-[#161b22]/90 border border-white/10 shadow-2xl backdrop-blur-md">
        {/* 纯净视频视窗：100% 呈现视频画面，配合 object-contain 保持原始等比居中 */}
        <div className="relative flex-1 min-h-0 w-full bg-black/95 flex items-center justify-center overflow-hidden select-none">
          <div
            className={`w-full h-full flex items-center justify-center transition-all ${
              aspectRatioMode === '16:9'
                ? 'aspect-video max-h-full max-w-full'
                : aspectRatioMode === '1:1'
                ? 'aspect-square max-h-full max-w-full'
                : 'max-h-full max-w-full'
            }`}
          >
            <video
              ref={videoRef}
              src={videoSource}
              onTimeUpdate={handleVideoTimeUpdate}
              onPlay={() => updatePlayState(true)}
              onPause={() => updatePlayState(false)}
              onError={(e) => {
                const err = (e.target as HTMLVideoElement).error;
                console.error('视频加载失败:', err?.message, 'code:', err?.code, 'source:', videoSource);
              }}
              onClick={togglePlay}
              className="w-full h-full object-contain cursor-pointer"
            />
          </div>
        </div>
      </div>
    );
  }
);
