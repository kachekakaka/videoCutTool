import { useEffect, useRef, useState } from 'react';
import { DEFAULT_APP_CONFIG } from '../../shared/types';
import { useAppData } from '../AppDataContext';

/** 音量随配置保存；工作台常驻期间沿用静音状态，新启动始终静音。 */
export function usePlaybackVolume(onSaveError: (message: string) => void) {
  const { config, saveConfig } = useAppData();
  const stored = Number.isInteger(config.playbackVolume) && config.playbackVolume >= 0 && config.playbackVolume <= 100
    ? config.playbackVolume : DEFAULT_APP_CONFIG.playbackVolume;
  const [volume, setVolume] = useState(stored);
  const [muted, setMuted] = useState(true);
  const current = useRef(stored), lastNonzero = useRef(stored || DEFAULT_APP_CONFIG.playbackVolume);
  const edited = useRef(false), pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const callbacks = useRef({ saveConfig, onSaveError });
  callbacks.current = { saveConfig, onSaveError };

  useEffect(() => {
    // 初始配置异步到达时可接纳；保存的旧响应不能覆盖正在拖动的新数值。
    if (edited.current) return;
    current.current = stored; setVolume(stored);
    if (stored > 0) lastNonzero.current = stored;
  }, [stored]);

  const commit = () => {
    clearTimeout(timer.current);
    if (!pending.current) return;
    pending.current = false;
    const value = current.current;
    void callbacks.current.saveConfig({ playbackVolume: value }).catch(() => {
      if (current.current === value) {
        pending.current = true;
        callbacks.current.onSaveError('音量未能保存，本次调节仍然有效；请再次调节重试。');
      }
    });
  };
  useEffect(() => () => { commit(); }, []);

  const change = (value: number) => {
    if (!Number.isFinite(value)) return;
    const next = Math.max(0, Math.min(100, Math.round(value)));
    edited.current = true; current.current = next;
    setVolume(next); setMuted(next === 0);
    if (next > 0) lastNonzero.current = next;
    pending.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(commit, 250);
  };
  const toggleMuted = () => {
    if (current.current === 0) { change(lastNonzero.current); commit(); }
    else setMuted(value => !value);
  };
  return { volume, muted, change, commit, toggleMuted };
}
