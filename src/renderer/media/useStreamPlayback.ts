import { useEffect, useRef, useState } from 'react';
import { StreamPlaybackController } from './StreamPlaybackController';
import type { StreamPlaybackSnapshot } from '../../shared/streamPlayback';

/** 先按文件内容分流。错误不会落回整片兼容预览；每个可见视图独占会话、共享只读索引。 */
export function useStreamPlayback(video: React.RefObject<HTMLVideoElement>, file: string, active: boolean, callbacks: {
  time: (ms: number) => void; busy: (value: boolean) => void; error: (message: string) => void;
  current: () => number;
  /** 当前有效的打开请求已有结果（含失败）；旧尝试停止及播放器销毁不通知。 */
  openSettled?: () => void;
}) {
  const controller = useRef<StreamPlaybackController | null>(null);
  const observer = useRef(callbacks); observer.current = callbacks;
  const [route, setRoute] = useState<'pending' | 'stream' | 'native'>('pending');
  const routeFile = useRef('');
  const [status, setStatus] = useState('');
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!active || !file || !video.current) return;
    const element = video.current, api = window.electronAPI;
    let stopped = false, closed = false;
    let instance: StreamPlaybackController | undefined;
    const id = crypto.randomUUID();
    // 本次 effect 只持有自己的会话和准备回调，迟到收尾不能操作新素材。
    const openSettled = observer.current.openSettled;
    const dispose = () => {
      if (closed) return;
      closed = true;
      instance?.destroy();
      if (controller.current === instance) controller.current = null;
      void api?.closeStream(id).catch(() => {});
    };
    routeFile.current = file;
    setRoute('pending'); setStatus('正在准备播放');
    observer.current.busy(true);
    void (async () => {
      const began = performance.now();
      try {
        let snapshot: StreamPlaybackSnapshot | null;
        try {
          snapshot = api ? await api.openStream(file, id) : null;
        } finally {
          if (!stopped) openSettled?.();
        }
        if (stopped) { dispose(); return; }
        if (!snapshot) { setRoute('native'); setStatus(''); observer.current.busy(false); return; }
        setRoute('stream');
        const resumeTime = observer.current.current();
        instance = new StreamPlaybackController(element, snapshot, {
          time: ms => { if (!stopped) observer.current.time(ms); },
          busy: value => { if (!stopped) observer.current.busy(value); },
          status: value => { if (!stopped) setStatus(value); },
          error: message => { if (!stopped && !closed) { observer.current.error(message); queueMicrotask(dispose); observer.current.busy(false); } },
        });
        controller.current = instance;
        const acquiredAt = performance.now();
        await instance.start();
        if (!stopped && !closed) console.info('[流式播放器启动耗时]', { acquireMs: acquiredAt - began, firstFrameMs: performance.now() - acquiredAt });
        if (!stopped && !closed && !instance.hasNavigation()) await instance.seek(resumeTime);
      } catch (error) {
        if (!stopped) { setRoute('stream'); setStatus(''); observer.current.error(String(error)); observer.current.busy(false); }
        dispose();
      }
    })();
    return () => {
      stopped = true; dispose();
      observer.current.busy(false);
    };
  }, [file, active, attempt]);
  return { controller, route: routeFile.current === file ? route : 'pending', status, retry: () => retry(value => value + 1) };
}
