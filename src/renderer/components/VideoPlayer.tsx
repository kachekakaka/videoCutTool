import { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react';

export interface VideoPlayerRef {
  seekTo: (timeMs: number) => void; play: () => void; pause: () => void; togglePlay: () => void;
  stepFrame: (deltaFrames: number) => void; stepSeconds: (seconds: number) => void;
  getCurrentTimeMs: () => number; getIsPlaying: () => boolean;
}
interface VideoPlayerProps {
  videoPath: string; durationMs: number; fps?: number; isActive?: boolean; shortcutsEnabled?: boolean;
  onTimeUpdate: (timeMs: number) => void; onPlayStateChange?: (playing: boolean) => void; onInsertCut?: () => void;
  aspectRatioMode?: 'auto' | '16:9' | '1:1'; auditionRange?: { startMs: number; endMs: number } | null; onAuditionEnd?: () => void;
}
export { formatTimecode, parseTimecodeToMs } from '../../shared/timeUtils';

export const VideoPlayer = forwardRef<VideoPlayerRef, VideoPlayerProps>(({
  videoPath, durationMs, fps = 30, isActive = true, shortcutsEnabled = true, onTimeUpdate, onPlayStateChange, onInsertCut, aspectRatioMode = 'auto', auditionRange, onAuditionEnd,
}, ref) => {
  const videoRef = useRef<HTMLVideoElement | null>(null), position = useRef(0), navigationEpoch = useRef(0), navigation = useRef(Promise.resolve());
  const [preview, setPreview] = useState<{ source: string; path: string; offset: number } | null>(null);
  const [error, setError] = useState(''), [progress, setProgress] = useState<number | null>(null);
  const request = useRef<string | null>(null), sourceEpoch = useRef(0), attemptedRemux = useRef(false);
  const currentPreview = preview?.source === videoPath ? preview : null;
  const playbackPath = currentPreview?.path || videoPath, offset = currentPreview?.offset || 0;
  const current = () => videoRef.current?.readyState ? Math.max(0, videoRef.current.currentTime * 1000 - offset) : position.current;
  const seek = (ms: number, invalidate = true) => {
    if (invalidate) navigationEpoch.current++;
    position.current = Math.max(0, Math.min(durationMs, ms));
    if (videoRef.current?.readyState) videoRef.current.currentTime = Math.max(0, (position.current + offset) / 1000);
    onTimeUpdate(position.current);
  };
  const play = () => { if (isActive && !error) void videoRef.current?.play().catch(error => setError(`播放失败：${error.message}`)); };
  const pause = () => { videoRef.current?.pause(); };
  const togglePlay = () => { if (videoRef.current?.paused) play(); else pause(); };
  const stepSeconds = (seconds: number) => { if (isActive) seek(current() + seconds * 1000); };
  const stepFrame = (delta: number) => {
    if (!isActive) return;
    pause();
    const epoch = navigationEpoch.current;
    navigation.current = navigation.current.then(async () => {
      for (let i = 0; i < Math.min(60, Math.abs(delta)); i++) {
        if (navigationEpoch.current !== epoch) return;
        const time = current();
        const next = window.electronAPI?.adjacentFrame ? await window.electronAPI.adjacentFrame(videoPath, time, delta < 0 ? -1 : 1) : time + Math.sign(delta) * 1000 / fps;
        if (navigationEpoch.current !== epoch) return;
        seek(next + 0.001, false);
      }
    }).catch(error => { if (navigationEpoch.current === epoch) setError(`逐帧定位失败：${String(error)}`); });
  };
  const cancelPreview = () => {
    if (request.current) void window.electronAPI?.cancelPlayback(request.current).catch(() => {});
    request.current = null; setProgress(null);
  };
  const preparePreview = async (convert: boolean) => {
    if (!window.electronAPI || request.current || !isActive) return;
    const epoch = sourceEpoch.current, id = crypto.randomUUID();
    request.current = id; setProgress(0); pause();
    try {
      const result = await window.electronAPI.preparePlayback(videoPath, convert, id);
      if (sourceEpoch.current !== epoch || request.current !== id) return;
      if (result.path) { position.current = current(); setPreview({ source: videoPath, path: result.path, offset: result.timeOffsetMs || 0 }); setError(''); }
      else setError('此素材需要生成兼容预览后播放，处理时间取决于视频长度。剪辑仍使用原片。');
    } catch (error) { if (sourceEpoch.current === epoch && request.current === id) setError(`生成兼容预览失败：${String(error)}`); }
    finally { if (request.current === id) { request.current = null; setProgress(null); } }
  };
  useEffect(() => {
    sourceEpoch.current++; navigationEpoch.current++; position.current = 0; attemptedRemux.current = false;
    setPreview(null); setError(''); onPlayStateChange?.(false); cancelPreview();
    return () => { sourceEpoch.current++; navigationEpoch.current++; cancelPreview(); };
  }, [videoPath]);
  useEffect(() => { if (!isActive) { pause(); navigationEpoch.current++; cancelPreview(); } }, [isActive]);
  useEffect(() => window.electronAPI?.onPreviewProgress(event => { if (request.current === event.requestId) setProgress(event.percent); }), []);
  useImperativeHandle(ref, () => ({ seekTo: seek, play, pause, togglePlay, stepFrame, stepSeconds, getCurrentTimeMs: current, getIsPlaying: () => Boolean(videoRef.current && !videoRef.current.paused) }));
  useEffect(() => { if (auditionRange && isActive) { seek(auditionRange.startMs); play(); } }, [auditionRange, isActive]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!isActive || !shortcutsEnabled || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
      else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') { event.preventDefault(); const direction = event.code === 'ArrowLeft' ? -1 : 1; if (event.shiftKey) stepSeconds(direction); else stepFrame(direction); }
      else if (event.code === 'KeyC') { event.preventDefault(); onInsertCut?.(); }
    };
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle);
  });
  const source = /^(https?:|media:)/.test(playbackPath) ? playbackPath : `media://video?path=${encodeURIComponent(playbackPath)}`;
  return <div className="w-full flex-1 min-h-[240px] flex flex-col rounded-2xl overflow-hidden bg-[#161b22]/90 border border-white/10 shadow-2xl">
    <div className="relative flex-1 min-h-0 w-full bg-black/95 flex items-center justify-center overflow-hidden select-none">
      <div className={`w-full h-full flex items-center justify-center ${aspectRatioMode === '16:9' ? 'aspect-video' : aspectRatioMode === '1:1' ? 'aspect-square' : ''} max-h-full max-w-full`}>
        <video ref={videoRef} src={source} onLoadedMetadata={() => seek(position.current)} onTimeUpdate={() => {
          position.current = current(); onTimeUpdate(position.current);
          if (auditionRange && position.current >= auditionRange.endMs) { pause(); onAuditionEnd?.(); }
        }} onPlay={() => onPlayStateChange?.(true)} onPause={() => onPlayStateChange?.(false)} onClick={togglePlay} onError={() => {
          setError('当前素材无法直接播放，可生成兼容预览；剪辑仍使用原片。');
          onPlayStateChange?.(false);
          if (!attemptedRemux.current && isActive) { attemptedRemux.current = true; void preparePreview(false); }
        }} className="w-full h-full object-contain cursor-pointer" />
      </div>
      {(error || progress !== null) && <div className="absolute inset-0 flex items-center justify-center bg-black/85 p-6"><div className="max-w-lg text-center text-sm text-zinc-200 space-y-3">
        <p className="break-words">{progress !== null ? `正在生成播放预览 ${Math.round(progress)}%` : error}</p>
        {progress !== null ? <button onClick={cancelPreview} className="px-3 py-2 rounded-lg bg-white/10">取消生成</button> : <div className="flex justify-center gap-3"><button onClick={() => { setError(''); videoRef.current?.load(); }} className="px-3 py-2 rounded-lg bg-white/10">重试播放</button><button onClick={() => void preparePreview(true)} className="px-3 py-2 rounded-lg bg-blue-600">生成兼容预览</button></div>}
      </div></div>}
      {currentPreview && !error && progress === null && <span className="absolute bottom-2 left-3 text-[10px] text-zinc-400 bg-black/60 px-2 py-1 rounded">兼容预览 · 导出使用原片</span>}
    </div>
  </div>;
});
