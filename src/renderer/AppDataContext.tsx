import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppConfig, DEFAULT_APP_CONFIG, EngineState, PlanChange, PlanRecord } from '../shared/types';

const initialEngine: EngineState = { activePlanId: null, queuedIds: [], storageError: null };
interface AppData { config: AppConfig; plans: PlanRecord[]; issues: string[]; engine: EngineState; loading: boolean; error: string; refresh: () => Promise<void>; saveConfig: (patch: Partial<AppConfig>) => Promise<AppConfig> }
const Context = createContext<AppData | null>(null);
const applyChange = (records: PlanRecord[], change: PlanChange) => {
  const result = records.filter(record => record.id !== (change.record?.id || change.deletedId));
  if (change.record) result.push(change.record);
  return result.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
};
export const AppDataProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [config, setConfig] = useState(DEFAULT_APP_CONFIG), [plans, setPlans] = useState<PlanRecord[]>([]), [issues, setIssues] = useState<string[]>([]);
  const [engine, setEngine] = useState(initialEngine), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const journal = useRef<PlanChange[] | null>(null), refreshTask = useRef<Promise<void> | null>(null);
  const readPlans = useCallback((scan: boolean) => {
    if (refreshTask.current) return refreshTask.current;
    const api = window.electronAPI;
    if (!api) return Promise.resolve();
    journal.current = []; setLoading(true);
    const task = (scan ? api.refreshPlans() : api.getPlanDetails()).then(result => {
      setPlans((journal.current || []).reduce(applyChange, result.records)); setIssues(result.issues); setError('');
    }).catch(error => { setError(String(error)); }).finally(() => { journal.current = null; refreshTask.current = null; setLoading(false); });
    refreshTask.current = task; return task;
  }, []);
  useEffect(() => {
    const api = window.electronAPI; if (!api) return;
    let configChanged = false, engineChanged = false, alive = true;
    const offConfig = api.onConfigChanged(next => { configChanged = true; setConfig(next); });
    const offPlans = api.onPlanChanged(change => { journal.current?.push(change); setPlans(previous => applyChange(previous, change)); });
    const offEngine = api.onEngineStateChanged(next => { engineChanged = true; setEngine(next); });
    void api.getConfig().then(next => { if (alive && !configChanged) setConfig(next); }).catch(error => setError(String(error)));
    void api.getEngineState().then(next => { if (alive && !engineChanged) setEngine(next); }).catch(error => setError(String(error)));
    void readPlans(false);
    return () => { alive = false; offConfig(); offPlans(); offEngine(); };
  }, [readPlans]);
  const saveConfig = useCallback(async (patch: Partial<AppConfig>) => {
    if (!window.electronAPI) { setConfig(previous => ({ ...previous, ...patch })); return { ...DEFAULT_APP_CONFIG, ...patch }; }
    const next = await window.electronAPI.saveConfig(patch); setConfig(next); return next;
  }, []);
  return <Context.Provider value={{ config, plans, issues, engine, loading, error, refresh: () => readPlans(true), saveConfig }}>{children}</Context.Provider>;
};
export function useAppData() { const context = useContext(Context); if (!context) throw new Error('应用共享状态未初始化'); return context; }
