import React, { useEffect, useRef, useState } from 'react';
import { CompressionFile, CompressionPlanRecord, CompressConfig, PlanRecord, SelectedVideo } from '../../shared/types';
import { CompressionSettings } from './CompressionSettings';
import { useAppData } from '../AppDataContext';
import { FileVideo, Package, Plus, Save, Trash2 } from 'lucide-react';

interface Row { id: string; path: string; key: string; title: string; media?: CompressionFile; checking: boolean; error?: string }
const defaults = (): CompressConfig => ({ enabled: true, preset: 'balanced', crf: 22, hardwareAcceleration: true });
const pathKey = (path: string) => /win/i.test(navigator.platform) ? path.replace(/\\/g, '/').toLowerCase() : path;
const baseName = (path: string) => path.split(/[\\/]/).pop() || path;
const button = 'px-3 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs disabled:opacity-40 disabled:cursor-not-allowed';

export const BatchCompressionPage: React.FC<{ editRequest: { record: PlanRecord; generation: number } | null; onPlans: () => void }> = ({ editRequest, onPlans }) => {
  const { config, plans, engine } = useAppData();
  const [rows, setRows] = useState<Row[]>([]);
  const rowRef = useRef<Row[]>([]);
  const [compress, setCompress] = useState(defaults);
  const [edit, setEdit] = useState<CompressionPlanRecord | null>(null);
  const [editCompress, setEditCompress] = useState(defaults);
  const [editTitle, setEditTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const locked = useRef(false);
  const checks = useRef(new Map<string, string>());
  const pendingChecks = useRef<Array<{ id: string; request: string }>>([]);
  const activeChecks = useRef(0);
  const [saveProgress, setSaveProgress] = useState({ done: 0, total: 0 });
  const generation = useRef(0);
  const incomingEdit = useRef(editRequest);
  incomingEdit.current = editRequest;
  const mutate = (work: (rows: Row[]) => Row[]) => { rowRef.current = work(rowRef.current); setRows(rowRef.current); };
  useEffect(() => {
    if (!editRequest) return;
    const record = editRequest.record;
    if (!record.compressionOnly) return;
    setEdit(record); setEditTitle(record.title); setEditCompress(structuredClone(record.compress || defaults()));
    setNotice('');
  }, [editRequest]);

  const cancelRow = (id: string) => {
    const request = checks.current.get(id);
    const queued = pendingChecks.current.some(item => item.id === id);
    pendingChecks.current = pendingChecks.current.filter(item => item.id !== id);
    checks.current.delete(id);
    if (request && !queued) void window.electronAPI?.cancelCompressionInspection(request).catch(() => {});
  };
  useEffect(() => () => { for (const id of checks.current.keys()) cancelRow(id); }, []);
  const removeRow = (id: string) => { cancelRow(id); mutate(list => list.filter(row => row.id !== id)); };
  const clearRows = () => { generation.current++; for (const id of checks.current.keys()) cancelRow(id); mutate(() => []); };
  const pumpChecks = () => {
    while (activeChecks.current < 2 && pendingChecks.current.length) {
      const item = pendingChecks.current.shift()!;
      activeChecks.current++;
      void runCheck(item.id, item.request);
    }
  };
  const checkRow = (id: string) => {
    cancelRow(id);
    const request = `check_${crypto.randomUUID()}`;
    checks.current.set(id, request);
    mutate(list => list.map(row => row.id === id ? { ...row, checking: true, error: undefined } : row));
    pendingChecks.current.push({ id, request }); pumpChecks();
  };
  const runCheck = async (id: string, request: string) => {
      const row = rowRef.current.find(item => item.id === id);
      try {
        if (!row) return;
        if (!window.electronAPI) throw new Error('请在桌面应用中添加视频');
        const media = await window.electronAPI.inspectCompressionFile(row.path, request);
        if (checks.current.get(id) !== request) return;
        mutate(list => list.some(item => item.id !== id && item.media?.pathKey === media.pathKey)
          ? list.filter(item => item.id !== id)
          : list.map(item => item.id === id ? { ...item, path: media.sourcePath, media, checking: false, error: undefined } : item));
      } catch (error) { if (checks.current.get(id) === request) mutate(list => list.map(item => item.id === id ? { ...item, checking: false, media: undefined, error: String(error) } : item)); }
      finally { if (checks.current.get(id) === request) checks.current.delete(id); activeChecks.current--; pumpChecks(); }
  };
  const addPaths = (selected: SelectedVideo[]) => {
    const additions: Row[] = [];
    const keys = new Set(rowRef.current.map(row => row.key));
    for (const file of selected) {
      const key = pathKey(file.path);
      if (keys.has(key)) continue;
      keys.add(key);
      const id = `plan_${crypto.randomUUID()}`;
      additions.push({ id, path: file.path, key, title: baseName(file.path).replace(/\.[^/.]+$/, ''), checking: !file.error, error: file.error });
    }
    mutate(list => [...list, ...additions]);
    for (const row of additions) if (!row.error) void checkRow(row.id);
  };
  const chooseFiles = async () => {
    if (locked.current || edit) return;
    const epoch = generation.current;
    try {
      if (!window.electronAPI) throw new Error('请在桌面应用中选择视频');
      const result = await window.electronAPI.openVideosDialog();
      if (epoch === generation.current && !locked.current) addPaths(result);
    } catch (error) { setNotice(String(error)); }
  };
  const drop = async (event: React.DragEvent) => {
    event.preventDefault();
    if (locked.current || edit) return;
    const epoch = generation.current;
    for (const file of Array.from(event.dataTransfer.files)) {
      if (epoch !== generation.current || locked.current) break;
      try {
        if (!window.electronAPI) throw new Error('请在桌面应用中拖入视频');
        const path = await window.electronAPI.getPathForFile(file);
        if (epoch === generation.current && !locked.current) addPaths([{ path }]);
      } catch (error) {
        if (epoch === generation.current && !locked.current) addPaths([{ path: file.name, error: String(error) }]);
      }
    }
  };
  const liveEdit = edit && plans.find(plan => plan.id === edit.id);
  const editBusy = Boolean(edit && (['queued', 'processing'].includes(liveEdit?.status || edit.status) || engine.activePlanId === edit.id || engine.queuedIds.includes(edit.id)));
  const save = async () => {
    if (locked.current || editBusy || !window.electronAPI) return;
    locked.current = true; setSaving(true); setNotice('');
    const api = window.electronAPI;
    const editing = edit;
    const editToken = incomingEdit.current;
    const settings = structuredClone(editing ? editCompress : compress);
    const cover = editing ? editing.stripOriginalCover !== false : config.stripOriginalCover;
    const selected = editing ? [{ id: editing.id, path: editing.sourcePath, title: editTitle }] : rowRef.current.filter(row => row.media && row.media.check !== 'invalid' && !row.checking).map(row => ({ ...row }));
    setSaveProgress({ done: 0, total: selected.length });
    let success = 0, failures = 0;
    try {
      for (const row of selected) {
        try {
          const saved = await api.saveCompressionPlan({ id: row.id, sourcePath: row.path, title: row.title, compress: settings,
            stripOriginalCover: cover, ...(editing ? { expectedUpdatedAt: editing.updatedAt } : {}) });
          success++;
          if (editing) { if (incomingEdit.current === editToken && saved.compressionOnly) setEdit(saved); }
          else mutate(list => list.filter(item => item.id !== row.id));
        } catch (error) {
          failures++;
          if (editing) setNotice(String(error));
          else mutate(list => list.map(item => item.id === row.id ? { ...item, error: String(error) } : item));
        } finally { setSaveProgress(progress => ({ ...progress, done: progress.done + 1 })); }
      }
      if (!editing) setNotice(`已保存 ${success} 条，保存失败 ${failures} 条，仍在检查 ${rowRef.current.filter(row => row.checking).length} 条。错误项保留在列表中。`);
      else if (success) setNotice('方案已更新，尚未执行。');
    } finally { locked.current = false; setSaving(false); }
  };
  const value = edit ? editCompress : compress;
  const ready = rows.filter(row => row.media && row.media.check !== 'invalid' && !row.checking).length;
  return <div className="flex-1 overflow-y-auto px-8 py-6 text-zinc-200" onDragOver={e => e.preventDefault()} onDrop={drop}>
    <div className="max-w-[1360px] mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div><h1 className="text-xl font-bold flex items-center gap-2"><Package className="text-purple-400 w-6 h-6" />{edit ? '编辑整片压缩方案' : '批量压缩'}</h1>
          <p className="text-xs text-zinc-400 mt-2">{edit ? '只更新当前方案，保存后在方案中心执行。' : '选择多个视频，统一设置参数。每个视频保存为独立方案，整片压缩。'}</p></div>
        <div className="flex gap-2">{edit && <button className={button} disabled={saving} onClick={() => { setEdit(null); setNotice(''); }}>返回批量创建</button>}<button className={button} onClick={onPlans}>前往方案中心</button></div>
      </div>
      {notice && <div role="status" className="rounded-xl border border-blue-500/20 bg-blue-500/10 text-blue-200 text-xs p-3 break-words">{notice}</div>}
      {editBusy && <p role="status" className="text-amber-300 text-xs">方案正在排队或处理中，完成后才能修改保存。</p>}
      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-5 items-start">
        <section className="min-w-0 rounded-2xl border border-white/10 bg-[#161b22]/70 p-5">
          {edit ? <div className="space-y-4"><p className="text-xs text-zinc-400 break-all">{edit.sourcePath}</p><label className="block text-xs">方案标题<input aria-label="方案标题" disabled={saving || editBusy} className="mt-2 block w-full p-2 rounded-lg bg-black/20 border border-white/10" value={editTitle} onChange={e => setEditTitle(e.target.value)} /></label></div>
            : <><div className="flex items-center justify-between mb-4"><span className="text-sm font-semibold">文件列表 · {rows.length}</span><div className="flex gap-2"><button className={button} disabled={saving} onClick={chooseFiles}><Plus className="w-3 h-3 inline mr-1" />添加视频</button><button className={button} disabled={saving || !rows.length} onClick={clearRows}><Trash2 className="w-3 h-3 inline mr-1" />清空</button></div></div>
            {!rows.length ? <button disabled={saving} onClick={chooseFiles} className="w-full border border-dashed border-white/20 rounded-xl py-20 text-center hover:border-purple-400/50"><FileVideo className="w-10 h-10 text-purple-400 mx-auto mb-4" /><span className="block text-sm">拖入多个视频，或点击选择文件</span><span className="block text-xs text-zinc-500 mt-2">可多次追加 · 不扫描文件夹</span></button>
              : <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">{rows.map(row => <div key={row.id} className="rounded-xl border border-white/10 bg-black/10 p-3" data-testid="compression-row"><div className="flex gap-3 items-start"><FileVideo className="w-4 h-4 text-purple-400 mt-2 shrink-0" /><div className="min-w-0 flex-1"><input aria-label={`方案标题 ${baseName(row.path)}`} value={row.title} disabled={saving} onChange={e => mutate(list => list.map(item => item.id === row.id ? { ...item, title: e.target.value } : item))} className="w-full bg-transparent border-b border-white/10 py-1 text-sm outline-none focus:border-purple-400" /><p className="text-[11px] text-zinc-500 break-all mt-1">{row.path}</p><p className={`text-xs mt-2 ${row.error || row.media?.check === 'invalid' ? 'text-rose-300' : 'text-zinc-400'}`}>{row.checking ? '检查中…' : row.error || (row.media?.check === 'invalid' ? row.media.message : `${row.media?.width && row.media?.height ? `${row.media.width} × ${row.media.height}` : '分辨率待确认'} · 时长待确认 · 可保存${row.media?.message ? `（${row.media.message}）` : ''}`)}</p></div><button aria-label={`移除 ${baseName(row.path)}`} className={button} disabled={saving} onClick={() => removeRow(row.id)}>移除</button></div>{!row.checking && (row.error || row.media?.check === 'invalid') && <button className={`${button} mt-2`} disabled={saving} onClick={() => void checkRow(row.id)}>重试检查</button>}</div>)}</div>}</>}
        </section>
        <aside className="rounded-2xl border border-white/10 bg-[#161b22]/70 p-5 space-y-5">
          <h2 className="text-sm font-semibold">{edit ? '压缩参数' : '整批共用参数'}</h2>
          <CompressionSettings value={value} onChange={edit ? setEditCompress : setCompress} disabled={saving || editBusy} />
          <div className="border-t border-white/10 pt-4 space-y-2"><h2 className="text-xs font-semibold">输出位置</h2><p className="text-xs text-zinc-400">各原视频所在目录下的「压缩」文件夹，不按方案分目录。</p></div>
          <button disabled={saving || editBusy || (!edit && !ready)} onClick={save} className="w-full p-3 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-bold"><Save className="w-4 h-4 inline mr-2" />{saving ? `正在保存 ${saveProgress.done} / ${saveProgress.total}` : edit ? '保存修改' : `保存方案（${ready}）`}</button>
          <p className="text-[11px] text-zinc-500">保存后不会立即压缩。时长及素材完整性将在执行时确认，请在方案中心勾选执行。</p>
        </aside>
      </div>
    </div>
  </div>;
};
