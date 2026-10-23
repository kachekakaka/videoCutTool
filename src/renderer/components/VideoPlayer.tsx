import { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react';

export interface VideoPlayerRef {
  seekTo: (timeMs: number) => void; play: () => void; pause: () => void; togglePlay: () => void;
  stepFrame: (deltaFrames: number) => void; stepSeconds: (seconds: number) => void;
  getCurrentTimeMs: () => number; getIsPlaying: () => boolean; isNavigating: () => boolean;
}
interface VideoPlayerProps {
  playbackRate?: number;
  timeOriginMs?: number;
  videoPath: string; durationMs: number; fps?: number; isActive?: boolean; shortcutsEnabled?: boolean;
  videoWidth?: number; videoHeight?: number; displayAspectRatio?: number; children?: React.ReactNode;
  onTimeUpdate: (timeMs: number) => void; onPlayStateChange?: (playing: boolean) => void; onInsertCut?: () => void;
  aspectRatioMode?: 'auto' | '16:9' | '1:1'; auditionRange?: { startMs: number; endMs: number } | null; onAuditionEnd?: () => void;
}
export { formatTimecode, parseTimecodeToMs } from '../../shared/timeUtils';

export const VideoPlayer = forwardRef<VideoPlayerRef, VideoPlayerProps>(({
  videoPath, durationMs, fps = 30, timeOriginMs = 0, playbackRate = 1, isActive = true, shortcutsEnabled = true, videoWidth, videoHeight, displayAspectRatio, children, onTimeUpdate, onPlayStateChange, onInsertCut, aspectRatioMode = 'auto', auditionRange, onAuditionEnd,
}, ref) => {
  const videoRef = useRef<HTMLVideoElement | null>(null), position = useRef(0), navigationEpoch = useRef(0), navigation = useRef(Promise.resolve());
  const presented = useRef<{ ms: number; at: number } | null>(null), navigating = useRef(false), wantsPlayback = useRef(false), callbacks = useRef({ onTimeUpdate, auditionRange, onAuditionEnd });
  callbacks.current = { onTimeUpdate, auditionRange, onAuditionEnd };
  const viewport = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(() => setBounds({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const ratio = displayAspectRatio || (videoWidth && videoHeight ? videoWidth / videoHeight : 16 / 9);
  const canvasRatio = aspectRatioMode === '16:9' ? 16 / 9 : aspectRatioMode === '1:1' ? 1 : bounds.width / Math.max(1, bounds.height) || ratio;
  const canvasWidth = Math.min(bounds.width, bounds.height * canvasRatio);
  const contentWidth = Math.min(canvasWidth, canvasWidth / canvasRatio * ratio);
  const [preview, setPreview] = useState<{ source: string; path: string; offset: number } | null>(null);
  const [error, setError] = useState(''), [progress, setProgress] = useState<number | null>(null);
  const [navigationError, setNavigationError] = useState('');
  const request = useRef<string | null>(null), sourceEpoch = useRef(0), attemptedRemux = useRef(false);
  const currentPreview = preview?.source === videoPath ? preview : null;
  const playbackPath = currentPreview?.path || videoPath, offset = currentPreview?.offset ?? timeOriginMs;
  const applyPlaybackRate = () => {
    const video = videoRef.current;
    if (video) { video.defaultPlaybackRate = playbackRate; video.playbackRate = playbackRate; video.preservesPitch = true; }
  };
  useEffect(applyPlaybackRate, [playbackRate, playbackPath]);
  useEffect(() => {
    const video = videoRef.current; if (!video) return;
    let id = 0, stopped = false, announcedAt = 0;
    const frame = (at: number, data: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      presented.current = { ms: data.mediaTime * 1000, at };
      if (!navigating.current) {
        position.current = Math.max(0, data.mediaTime * 1000 - offset);
        if (video.paused || at - announcedAt >= 100) { callbacks.current.onTimeUpdate(position.current); announcedAt = at; }
        const audition = callbacks.current.auditionRange;
        if (audition && position.current >= audition.endMs) { wantsPlayback.current = false; video.pause(); callbacks.current.onAuditionEnd?.(); }
      }
      id = video.requestVideoFrameCallback(frame);
    };
    id = video.requestVideoFrameCallback(frame);
    return () => { stopped = true; video.cancelVideoFrameCallback(id); };
  }, [playbackPath, offset]);
  const current = () => position.current;
  const seekConfirmed = async (ms: number, epoch: number, expected?: number): Promise<boolean> => {
    const video = videoRef.current; if (!video?.readyState) { if (epoch === navigationEpoch.current) navigating.current = false; return false; }
    const target = Math.max(0, Math.min(durationMs, ms)), start = performance.now();
    const valid = () => epoch === navigationEpoch.current && video === videoRef.current;
    navigating.current = true;
    try {
      if (presented.current && Math.abs(presented.current.ms - (expected ?? target) - offset) < 0.01 && !video.seeking) { position.current = Math.max(0, presented.current.ms - offset); callbacks.current.onTimeUpdate(position.current); return true; }
      video.currentTime = Math.max(0, (target + offset + 0.001) / 1000);
      while (valid()) {
        const shown = presented.current;
        if (!video.seeking && shown && shown.at >= start && (expected === undefined || Math.abs(shown.ms - offset - expected) < 0.01)) {
          position.current = Math.max(0, shown.ms - offset); callbacks.current.onTimeUpdate(position.current); return true;
        }
        if (performance.now() - start > 5000) throw new Error('定位超时，尚未确认目标画面，请重试');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return false;
    } finally { if (valid()) navigating.current = false; }
  };
  const seek = (ms: number) => {
    const epoch = ++navigationEpoch.current;
    setNavigationError(''); videoRef.current?.pause();
    return seekConfirmed(ms, epoch).then(ok => { if (ok && epoch === navigationEpoch.current && wantsPlayback.current) void videoRef.current?.play().catch(error => setError(String(error))); return ok; }).catch(error => { if (epoch === navigationEpoch.current) setNavigationError(String(error)); return false; });
  };
  const play = () => { if (isActive && !error) { wantsPlayback.current = true; navigationEpoch.current++; navigating.current = false; void videoRef.current?.play().catch(error => setError(`播放失败：${error.message}`)); } };
  const pause = () => { wantsPlayback.current = false; videoRef.current?.pause(); };
  const togglePlay = () => { if (wantsPlayback.current) pause(); else play(); };
  const stepSeconds = (seconds: number) => { if (isActive) seek(current() + seconds * 1000); };
  const stepFrame = (delta: number) => {
    if (!isActive) return;
    pause(); setNavigationError(''); navigating.current = true;
    const epoch = navigationEpoch.current;
    navigation.current = navigation.current.then(async () => {
      for (let i = 0; i < Math.min(60, Math.abs(delta)); i++) {
        if (navigationEpoch.current !== epoch) return;
        navigating.current = true;
        const time = current();
        const next = window.electronAPI?.adjacentFrame ? await window.electronAPI.adjacentFrame(videoPath, time, delta < 0 ? -1 : 1) : time + Math.sign(delta) * 1000 / fps;
        if (navigationEpoch.current !== epoch) return;
        const following = window.electronAPI?.adjacentFrame ? await window.electronAPI.adjacentFrame(videoPath, next, 1) : next + 1000 / fps;
        if (navigationEpoch.current !== epoch) return;
        // 定位到展示区间内部，避开浏览器在 VFR/B 帧边界的舍入；确认后仍保存原始帧时间。
        if (!await seekConfirmed(next + Math.max(0, following - next) / 2, epoch, next)) return;
      }
    }).catch(error => { if (navigationEpoch.current === epoch) setNavigationError(`逐帧定位失败：${String(error)}`); }).finally(() => { if (navigationEpoch.current === epoch) { navigating.current = false; if (wantsPlayback.current) play(); } });
  };
  const cancelPreview = () => {
    if (request.current) void window.electronAPI?.cancelPlayback(request.current).catch(() => {});
    request.current = null; setProgress(null);
  };
  const previewLease = useRef<string | null>(null);
  const releasePreview = () => {
    if (previewLease.current) void window.electronAPI?.releasePlayback(previewLease.current).catch(() => {});
    previewLease.current = null;
  };
  const preparePreview = async (convert: boolean) => {
    if (!window.electronAPI || request.current || !isActive) return;
    const epoch = sourceEpoch.current, id = crypto.randomUUID();
    request.current = id; setProgress(0); pause();
    try {
      const result = await window.electronAPI.preparePlayback(videoPath, convert, id);
      if (sourceEpoch.current !== epoch || request.current !== id) { void window.electronAPI.releasePlayback(id); return; }
      if (result.path) { releasePreview(); previewLease.current = id; position.current = current(); setPreview({ source: videoPath, path: result.path, offset: result.timeOffsetMs || 0 }); setError(''); }
      else setError('此素材需要生成兼容预览后播放，处理时间取决于视频长度。剪辑仍使用原片。');
    } catch (error) { if (sourceEpoch.current === epoch && request.current === id) setError(`生成兼容预览失败：${String(error)}`); }
    finally { if (request.current === id) { request.current = null; setProgress(null); } }
  };
  useEffect(() => {
    sourceEpoch.current++; navigationEpoch.current++; position.current = 0; presented.current = null; navigating.current = false; attemptedRemux.current = false;
    wantsPlayback.current = false; setNavigationError(''); setPreview(null); setError(''); onPlayStateChange?.(false); cancelPreview();
    return () => { sourceEpoch.current++; navigationEpoch.current++; navigating.current = false; cancelPreview(); releasePreview(); };
  }, [videoPath]);
  useEffect(() => { if (!isActive) { pause(); navigationEpoch.current++; navigating.current = false; cancelPreview(); } }, [isActive]);
  useEffect(() => window.electronAPI?.onPreviewProgress(event => { if (request.current === event.requestId) setProgress(event.percent); }), []);
  useImperativeHandle(ref, () => ({ seekTo: seek, play, pause, togglePlay, stepFrame, stepSeconds, getCurrentTimeMs: current, getIsPlaying: () => Boolean(videoRef.current && !videoRef.current.paused), isNavigating: () => navigating.current }));
  useEffect(() => { if (auditionRange && isActive) { void seek(auditionRange.startMs).then(ok => { if (ok) play(); }); } }, [auditionRange, isActive]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!isActive || !shortcutsEnabled || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
      else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') { event.preventDefault(); const direction = event.code === 'ArrowLeft' ? -1 : 1; if (event.shiftKey) stepSeconds(direction); else stepFrame(direction); }
      else if (event.code === 'KeyC') { event.preventDefault(); if (!navigating.current) onInsertCut?.(); }
    };
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle);
  });
  const source = /^(https?:|media:)/.test(playbackPath) ? playbackPath : `media://video?path=${encodeURIComponent(playbackPath)}`;
  return <div className="w-full flex-1 min-h-[240px] flex flex-col rounded-2xl overflow-hidden bg-[#161b22]/90 border border-white/10 shadow-2xl">
    <div ref={viewport} className="relative flex-1 min-h-0 w-full bg-black/95 flex items-center justify-center overflow-hidden select-none">
      <div
        style={{ width: contentWidth, height: contentWidth / ratio }}
        className="relative flex-none flex items-center justify-center max-h-full max-w-full"
      >
        <video ref={videoRef} src={source} onLoadedMetadata={() => { applyPlaybackRate(); void seek(position.current); }} onPlay={() => onPlayStateChange?.(true)} onPause={() => onPlayStateChange?.(false)} onEnded={() => { wantsPlayback.current = false; }} onClick={togglePlay} onError={() => {
          setError('当前素材无法直接播放，可生成兼容预览；剪辑仍使用原片。');
          onPlayStateChange?.(false);
          if (!attemptedRemux.current && isActive) { attemptedRemux.current = true; void preparePreview(false); }
        }} className="w-full h-full object-contain cursor-pointer" />
        {children}
      </div>
      {(error || progress !== null) && <div className="absolute inset-0 flex items-center justify-center bg-black/85 p-6"><div className="max-w-lg text-center text-sm text-zinc-200 space-y-3">
        <p className="break-words">{progress !== null ? `正在生成播放预览 ${Math.round(progress)}%` : error}</p>
        {progress !== null ? <button onClick={cancelPreview} className="px-3 py-2 rounded-lg bg-white/10">取消生成</button> : <div className="flex justify-center gap-3"><button onClick={() => { setError(''); videoRef.current?.load(); }} className="px-3 py-2 rounded-lg bg-white/10">重试播放</button><button onClick={() => void preparePreview(true)} className="px-3 py-2 rounded-lg bg-blue-600">生成兼容预览</button></div>}
      </div></div>}
      {currentPreview && !error && progress === null && <span className="absolute bottom-2 left-3 text-[10px] text-zinc-400 bg-black/60 px-2 py-1 rounded">兼容预览 · 导出使用原片</span>}
      {navigationError && <span role="status" className="absolute bottom-2 left-3 text-xs text-amber-200 bg-black/80 px-2 py-1 rounded">{navigationError}</span>}
    </div>
  </div>;
});
