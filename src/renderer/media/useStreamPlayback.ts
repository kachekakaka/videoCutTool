import { useEffect, useRef, useState } from 'react';
import { StreamPlaybackController } from './StreamPlaybackController';

/** 先按文件内容分流。错误不会落回整片兼容预览；每个可见视图独占会话、共享只读索引。 */
export function useStreamPlayback(video: React.RefObject<HTMLVideoElement>, file: string, active: boolean, callbacks: {
  time: (ms: number) => void; busy: (value: boolean) => void; error: (message: string) => void;
  current: () => number;
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
    let stopped = false;
    const id = crypto.randomUUID();
    routeFile.current = file;
    setRoute('pending'); setStatus('正在准备播放');
    observer.current.busy(true);
    void (async () => {
      try {
        const snapshot = api ? await api.openStream(file, id) : null;
        if (stopped) { void api?.closeStream(id).catch(() => {}); return; }
        if (!snapshot) { setRoute('native'); setStatus(''); observer.current.busy(false); return; }
        setRoute('stream');
        const resumeTime = observer.current.current();
        const instance = new StreamPlaybackController(element, snapshot, {
          time: ms => { if (!stopped) observer.current.time(ms); },
          busy: value => { if (!stopped) observer.current.busy(value); },
          status: value => { if (!stopped) setStatus(value); },
          error: message => { if (!stopped) { observer.current.error(message); queueMicrotask(() => instance.destroy()); observer.current.busy(false); } },
        });
        controller.current = instance;
        await instance.start();
        if (!stopped && !instance.hasNavigation()) await instance.seek(resumeTime);
      } catch (error) {
        if (!stopped) { setRoute('stream'); setStatus(''); observer.current.error(String(error)); observer.current.busy(false); controller.current?.destroy(); }
        void api?.closeStream(id).catch(() => {});
      }
    })();
    return () => {
      stopped = true; controller.current?.destroy(); controller.current = null;
      void api?.closeStream(id).catch(() => {});
      observer.current.busy(false);
    };
  }, [file, active, attempt]);
  return { controller, route: routeFile.current === file ? route : 'pending', status, retry: () => retry(value => value + 1) };
}
