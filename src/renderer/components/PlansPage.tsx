import React, { useState, useEffect } from 'react';
import { PlanRecord, EXECUTION_STAGE_LABELS } from '../../shared/types';
import { COMPRESS_PRESETS } from '../../shared/compressPresets';
import {
  FolderKanban,
  CheckCircle2,
  Clock,
  Rocket,
  Edit3,
  Trash2,
  Copy,
  RefreshCw,
  FileVideo,
  FolderOpen,
  Loader2,
  Check,
  AlertCircle,
  Zap,
  Pause,
  Play,
  Square,
  Star,
} from 'lucide-react';
import { formatTimecode } from './VideoPlayer';
import { useAppData } from '../AppDataContext';

interface PlansPageProps {
  onLoadPlanIntoCutter: (plan: PlanRecord) => void;
  isActive?: boolean;
}

export const PlansPage: React.FC<PlansPageProps> = ({ onLoadPlanIntoCutter }) => {
  const { plans, issues, engine, loading, error, refresh: fetchPlans } = useAppData();
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<'all' | 'ready' | 'queued' | 'processing' | 'completed' | 'failed'>('all');
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const batchLock = React.useRef(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [planToDelete, setPlanToDelete] = useState<PlanRecord | null>(null);
  const [planToStop, setPlanToStop] = useState<PlanRecord | null>(null);
  const [confirmCancelAll, setConfirmCancelAll] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => setPage(1), [filter]);
  useEffect(() => setSelectedIds([]), [filter, page]);

  // Esc 键关闭所有模态框
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (planToDelete) setPlanToDelete(null);
        if (planToStop) setPlanToStop(null);
        if (confirmCancelAll) setConfirmCancelAll(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [planToDelete, planToStop, confirmCancelAll]);

  const handleExecuteSingle = async (planId: string) => {
    setExecutingId(planId);
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.executePlan(planId);
        setNotice(result.message);
      }
    } catch (err) {
      setNotice(`执行方案失败：${String(err)}`);
    } finally {
      setExecutingId(null);
    }
  };

  const handleBatchExecute = async () => {
    if (batchLock.current) return;
    batchLock.current = true;
    setBatchRunning(true);
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.batchExecutePlans();
        setNotice(`已接受 ${result.queued} / ${result.total} 个方案${result.errors?.length ? '；' + result.errors.join('；') : ''}`);
      }
    } catch (err) {
      setNotice(`批量执行失败：${String(err)}`);
    } finally {
      batchLock.current = false;
      setBatchRunning(false);
    }
  };

  const handleSelectedExecute = async () => {
    if (batchLock.current || !selectedIds.length) return;
    batchLock.current = true; setBatchRunning(true);
    try {
      const result = await window.electronAPI?.executeSelectedPlans(selectedIds);
      if (result) { setNotice(`已接受 ${result.queued} / ${result.total} 个选中方案${result.errors.length ? '；' + result.errors.join('；') : ''}`); setSelectedIds([]); }
    } catch (error) { setNotice(`执行选中项失败：${String(error)}`); }
    finally { batchLock.current = false; setBatchRunning(false); }
  };

  const handleTogglePause = async () => {
    if (actionLoading || !window.electronAPI) return;
    setActionLoading(true);
    try {
      if (engine.queuePaused) {
        await window.electronAPI.resumeExecutionQueue();
        setNotice('已恢复队列调度派发');
      } else {
        await window.electronAPI.pauseExecutionQueue();
        setNotice('已暂停队列自动派发（当前任务完成后停下）');
      }
    } catch (err) {
      setNotice(`操作失败：${String(err)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSetPriority = async (planId: string) => {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.setPriorityExecutionPlan(planId);
      if (result.success) {
        setNotice(result.message || '已指定该方案为下一优先执行任务');
      } else {
        setNotice(`指定优先失败：${result.message || ''}`);
      }
    } catch (err) {
      setNotice(`指定优先失败：${String(err)}`);
    }
  };

  const handleCancelQueued = async (planId: string) => {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.cancelPlanExecution(planId);
      if (result.success) {
        setNotice('方案已移出队列并恢复为待执行状态');
      } else {
        setNotice(`移出队列失败：${result.message || ''}`);
      }
    } catch (err) {
      setNotice(`移出队列失败：${String(err)}`);
    }
  };

  const handleConfirmStop = async () => {
    if (!planToStop || !window.electronAPI) return;
    const target = planToStop;
    setPlanToStop(null);
    setActionLoading(true);
    try {
      const result = await window.electronAPI.cancelPlanExecution(target.id);
      if (result.success) {
        setNotice(`已停止方案《${target.title}》并清理临时资产`);
      } else {
        setNotice(`停止未完成：${result.message || ''}`);
      }
    } catch (err) {
      setNotice(`停止执行异常：${String(err)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfirmCancelAll = async () => {
    setConfirmCancelAll(false);
    if (!window.electronAPI) return;
    setActionLoading(true);
    try {
      const result = await window.electronAPI.cancelAllPlanExecutions();
      setNotice(result.message || '已全部停止');
    } catch (err) {
      setNotice(`全部停止异常：${String(err)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteClick = (plan: PlanRecord) => {
    setPlanToDelete(plan);
  };

  const handleConfirmDelete = async () => {
    if (!planToDelete) return;
    const targetId = planToDelete.id;
    setPlanToDelete(null);
    if (window.electronAPI) {
      try {
        await window.electronAPI.deletePlan(targetId);
      } catch (err) {
        setNotice(`删除方案失败：${String(err)}`);
      }
    }
  };

  const handleCopyJson = (plan: PlanRecord) => {
    navigator.clipboard.writeText(JSON.stringify(plan, null, 2));
    setCopiedId(plan.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleRevealInExplorer = (outputPath: string) => {
    if (outputPath && window.electronAPI) {
      window.electronAPI.showItemInFolder(outputPath);
    }
  };

  // 过滤方案
  const filteredPlans = plans.filter((p) => {
    if (filter === 'ready') return p.status === 'ready';
    if (filter === 'queued') return p.status === 'queued';
    if (filter === 'processing') return p.status === 'processing';
    if (filter === 'completed') return p.status === 'completed';
    if (filter === 'failed') return p.status === 'failed';
    return true;
  });

  const readyCount = plans.filter((p) => p.status === 'ready').length;
  const processingCount = plans.filter((p) => p.status === 'processing').length;
  const completedCount = plans.filter((p) => p.status === 'completed').length;
  const failedCount = plans.filter((p) => p.status === 'failed').length;
  const queuedCount = plans.filter(p => p.status === 'queued').length;
  const pages = Math.max(1, Math.ceil(filteredPlans.length / 50)), visiblePage = Math.min(page, pages);
  const visiblePlans = filteredPlans.slice((visiblePage - 1) * 50, visiblePage * 50);
  useEffect(() => {
    const eligible = new Set(visiblePlans.filter(plan => ['ready', 'failed'].includes(plan.status)).map(plan => plan.id));
    setSelectedIds(ids => ids.filter(id => eligible.has(id)));
  }, [plans, filter, page, visiblePage]);

  return (
    <div className="flex-1 h-full overflow-y-auto px-8 py-6">
      <div className="max-w-[1360px] mx-auto space-y-6">
        {(notice || error || engine.storageError) && <div role="status" className="p-3 rounded-xl bg-amber-500/10 text-amber-200 text-xs break-words">{engine.storageError || error || notice}{engine.storageError && <button className="ml-3 underline" onClick={() => window.electronAPI?.retryPendingWrites().catch(error => setNotice(String(error)))}>重试保存并继续队列</button>}</div>}
        {issues.length > 0 && <details className="p-3 text-amber-200 bg-amber-500/10 rounded-xl text-xs"><summary>方案恢复与读取提示（{issues.length}）</summary>{issues.map((issue, index) => <p className="mt-2 break-all" key={index}>{issue}</p>)}</details>}
        {/* 顶部标题与控制栏 */}
        <div className="flex items-center justify-between pb-6 border-b border-white/10">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2.5">
              <FolderKanban className="w-5 h-5 text-blue-400" />
              <span>方案管理中心</span>
              <span className="text-xs bg-white/10 text-zinc-300 px-2 py-0.5 rounded-full font-mono">
                共 {plans.length} 个方案
              </span>
            </h1>
            <p className="text-xs text-zinc-400 mt-1">
              集中管理裁剪与整片压缩方案，勾选后提交后台队列，已完成方案支持定位产物
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* 标签筛选器 */}
            <div className="flex items-center bg-black/40 border border-white/10 p-1 rounded-xl gap-1">
              <button
                onClick={() => setFilter('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  filter === 'all'
                    ? 'bg-blue-600 text-white shadow-sm font-bold'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                全部 ({plans.length})
              </button>
              <button
                onClick={() => setFilter('ready')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all focus-visible:ring-2 focus-visible:ring-amber-500 ${
                  filter === 'ready'
                    ? 'bg-blue-600 text-white shadow-sm font-bold'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                <span>待执行 ({readyCount})</span>
              </button>
              {queuedCount > 0 && <button onClick={() => setFilter('queued')} className={`px-3 py-1.5 rounded-lg text-xs ${filter === 'queued' ? 'bg-blue-600 text-white' : 'text-blue-300'}`}>排队中 ({queuedCount})</button>}
              {processingCount > 0 && (
                <button
                  onClick={() => setFilter('processing')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
                    filter === 'processing'
                      ? 'bg-blue-600 text-white shadow-sm font-bold animate-pulse'
                      : 'text-blue-400 hover:text-white'
                  }`}
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
                  <span>剪辑中 ({processingCount})</span>
                </button>
              )}
              <button
                onClick={() => setFilter('completed')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                  filter === 'completed'
                    ? 'bg-emerald-600 text-white shadow-sm font-bold'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>已完成 ({completedCount})</span>
              </button>
              {failedCount > 0 && (
                <button
                  onClick={() => setFilter('failed')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all focus-visible:ring-2 focus-visible:ring-rose-500 ${
                    filter === 'failed'
                      ? 'bg-rose-600 text-white shadow-sm font-bold'
                      : 'text-rose-400 hover:text-white'
                  }`}
                >
                  <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
                  <span>失败 ({failedCount})</span>
                </button>
              )}
            </div>

            {/* 批量执行按钮 */}
            {readyCount > 0 && (
              <button
                disabled={batchRunning}
                onClick={handleBatchExecute}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold flex items-center gap-2 transition-all shadow-lg shadow-blue-500/25 active:scale-95 focus-visible:ring-2 focus-visible:ring-blue-400"
              >
                {batchRunning ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>批量排队中...</span>
                  </>
                ) : (
                  <>
                    <Rocket className="w-4 h-4" />
                    <span>批量执行待办 ({readyCount})</span>
                  </>
                )}
              </button>
            )}

            {/* 调度暂停与恢复控制按钮 */}
            <button
              disabled={actionLoading}
              onClick={handleTogglePause}
              className={`px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all active:scale-95 border ${
                engine.queuePaused
                  ? 'bg-amber-600 hover:bg-amber-500 text-white border-amber-500/50 shadow-md shadow-amber-600/20'
                  : 'bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white border-white/10'
              }`}
              title={engine.queuePaused ? '恢复自动派发排队方案' : '暂停后续任务自动派发，当前任务完成后停下'}
            >
              {engine.queuePaused ? (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>恢复队列</span>
                </>
              ) : (
                <>
                  <Pause className="w-3.5 h-3.5 text-amber-400" />
                  <span>暂停队列</span>
                </>
              )}
            </button>

            {/* 全局全部停止按钮 */}
            <button
              disabled={actionLoading || (!engine.activePlanId && queuedCount === 0 && !engine.priorityPlanId)}
              onClick={() => setConfirmCancelAll(true)}
              className="px-3 py-2 rounded-xl bg-rose-600/20 hover:bg-rose-600 disabled:opacity-30 disabled:cursor-not-allowed text-rose-300 hover:text-white border border-rose-500/30 text-xs font-bold flex items-center gap-1.5 transition-all active:scale-95"
              title="中断当前正在执行的任务并清空所有排队"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span>全部停止</span>
            </button>

            <button
              onClick={fetchPlans}
              className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white border border-white/10 transition-all focus-visible:ring-2 focus-visible:ring-blue-500 active:scale-95"
              title="刷新列表"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* 调度暂停常驻提示横幅 */}
        {engine.queuePaused && (
          <div className="p-3.5 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-200 text-xs flex items-center justify-between gap-3 shadow-lg">
            <div className="flex items-center gap-2.5">
              <Pause className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                <strong>调度队列已暂停</strong>：当前任务完成后不会自动开始下一个任务；您可以对排队中的方案点击【⭐ 单独启动】进行手动优先调度。
              </span>
            </div>
            <button
              onClick={handleTogglePause}
              disabled={actionLoading}
              className="px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold shrink-0 transition-all active:scale-95 shadow"
            >
              恢复自动派发
            </button>
          </div>
        )}

        <div className="flex gap-4 items-center text-xs text-zinc-300">
          <label className="flex items-center gap-2"><input type="checkbox" disabled={batchRunning}
            checked={visiblePlans.some(plan => ['ready', 'failed'].includes(plan.status)) && visiblePlans.filter(plan => ['ready', 'failed'].includes(plan.status)).every(plan => selectedIds.includes(plan.id))}
            onChange={e => setSelectedIds(e.target.checked ? visiblePlans.filter(plan => ['ready', 'failed'].includes(plan.status)).map(plan => plan.id) : [])} />选择本页可执行项</label>
          <button disabled={batchRunning || !selectedIds.length} onClick={handleSelectedExecute} className="px-3 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white">执行选中项（{selectedIds.length}）</button>
        </div>
        {/* 方案卡片列表 */}
        {filteredPlans.length === 0 ? (
          <div className="border border-white/10 rounded-3xl p-16 flex flex-col items-center justify-center bg-[#161b22]/40 backdrop-blur-md">
            <FolderKanban className="w-12 h-12 text-zinc-600 mb-3" />
            <h3 className="text-sm font-semibold text-zinc-300">当前分类暂无方案记录</h3>
            <p className="text-xs text-zinc-400 mt-1 max-w-[360px] text-center">
              在裁剪工作台保存剪辑方案，或在批量压缩页选择视频并保存。随后可在这里勾选执行。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {visiblePlans.map((plan) => {
              const isCompleted = plan.status === 'completed';
              const isProcessing = plan.status === 'processing';
              const isQueued = plan.status === 'queued';
              const isFailed = plan.status === 'failed';
              const isRunning = executingId === plan.id;
              const progress = !isCompleted && engine.progress?.planId === plan.id ? engine.progress : null;
              const progressText = progress
                ? `${EXECUTION_STAGE_LABELS[progress.stage]}${progress.cpuRetry ? '（CPU 重试）' : ''}${progress.total && progress.total > 1 ? `（${progress.current}/${progress.total}）` : ''}`
                : '准备中';

              return (
                <div
                  key={plan.id}
                  className={`p-5 rounded-2xl border transition-all shadow-xl flex flex-col justify-between ${
                    isCompleted
                      ? 'bg-[#161b22]/90 border-emerald-500/30'
                      : isProcessing
                      ? 'bg-[#161b22]/90 border-blue-500/40 shadow-blue-500/10'
                      : isFailed
                      ? 'bg-[#161b22]/90 border-rose-500/30'
                      : 'bg-[#161b22]/80 border-white/10 hover:border-blue-500/30'
                  }`}
                >
                  {/* 头部标题与状态徽章 */}
                  <div>
                    <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <input type="checkbox" aria-label={`选择方案 ${plan.title}`} disabled={batchRunning || !['ready', 'failed'].includes(plan.status)} checked={selectedIds.includes(plan.id)}
                          onChange={e => setSelectedIds(ids => e.target.checked ? [...new Set([...ids, plan.id])] : ids.filter(id => id !== plan.id))} />
                        <FileVideo className="w-4 h-4 text-blue-400 shrink-0" />
                        <h3 className="text-sm font-bold text-white truncate" title={plan.title}>
                          {plan.title}
                        </h3>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {plan.compressionOnly && <span className="text-[10px] text-purple-300">整片压缩</span>}
                        {/* 导出模式属性徽章 */}
                        {plan.exportPrecision === 'frame' ? <span className="text-[11px] text-blue-200 px-2 py-0.5 rounded-full bg-blue-500/15" title="按画面范围导出；视频与音频重新编码">精确导出</span> : plan.compress?.enabled ? (
                          <span className="text-[11px] bg-purple-500/15 text-purple-300 border border-purple-500/30 px-2 py-0.5 rounded-full flex items-center gap-1 font-mono font-medium" title={plan.compress.preset === 'custom' ? '自定义 CRF 压缩' : COMPRESS_PRESETS[plan.compress.preset]?.summary}>
                            <span>📦</span>
                            <span>
                              {plan.compress.preset === 'custom'
                                ? `自定义 (CRF ${plan.compress.crf ?? 22})`
                                : `${COMPRESS_PRESETS[plan.compress.preset]?.title || '降码'} (CRF ${plan.compress.crf ?? COMPRESS_PRESETS[plan.compress.preset]?.defaultCrf ?? 22})`}
                            </span>
                          </span>
                        ) : (
                          <span className="text-[11px] bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 px-2 py-0.5 rounded-full flex items-center gap-1 font-mono font-medium" title="起点向前取关键帧，片尾可能扩出；配置画面处理时会转码，仍沿用扩展范围">
                            <Zap className="w-3 h-3 text-cyan-400" />
                            <span>快速无损</span>
                          </span>
                        )}

                        {/* 画面空间修饰属性徽章 */}
                        {plan.spatialConfig && ((plan.spatialConfig.crop && plan.spatialConfig.crop.width > 0) || (plan.spatialConfig.masks && plan.spatialConfig.masks.length > 0)) && (
                          <span
                            className="text-[11px] bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 px-2 py-0.5 rounded-full flex items-center gap-1 font-mono font-medium"
                            title="包含画面空间修饰（画幅裁切或去水印遮罩），导出时自动升轨为智能转码"
                          >
                            <span>📐</span>
                            <span>
                              {plan.spatialConfig.crop && plan.spatialConfig.crop.width > 0
                                ? `${plan.spatialConfig.crop.width}×${plan.spatialConfig.crop.height}`
                                : '空间修饰'}
                              {plan.spatialConfig.masks && plan.spatialConfig.masks.length > 0
                                ? ` · 💧${plan.spatialConfig.masks.length}`
                                : ''}
                            </span>
                          </span>
                        )}

                        {/* 状态徽章 */}
                        {isCompleted ? (
                          <span className="text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1 font-bold">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            <span>已完成 · 100%</span>
                          </span>
                        ) : isProcessing ? (
                          <span className="text-xs bg-blue-500/20 text-blue-300 border border-blue-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1 font-bold animate-pulse">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
                            <span>{progress?.stage === 'saving' ? '等待保存' : progress?.stage === 'failed' ? '处理失败' : '处理中'}</span>
                          </span>
                        ) : isQueued ? (
                          plan.id === engine.priorityPlanId ? (
                            <span className="text-xs bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2.5 py-0.5 rounded-full flex items-center gap-1 font-bold">
                              <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                              <span>优先排队</span>
                            </span>
                          ) : (
                            <span className="text-xs text-blue-300">等待处理</span>
                          )
                        ) : isFailed ? (
                          <span className="text-xs bg-rose-500/20 text-rose-300 border border-rose-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1 font-medium">
                            <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
                            <span>失败</span>
                          </span>
                        ) : (
                          <span className="text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1 font-medium">
                            <Clock className="w-3.5 h-3.5 text-amber-400" />
                            <span>待执行</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {(isProcessing || progress) && (
                      <div className="my-3 space-y-1.5" data-execution-progress={plan.id}>
                        <div className="flex justify-between gap-2 text-xs text-blue-200">
                          <span>{progressText}</span>
                          {progress?.percent != null && <span className="font-mono tabular-nums">{progress.percent}%</span>}
                        </div>
                        <div role="progressbar" aria-label={`${plan.title}导出进度`} aria-valuemin={0} aria-valuemax={100}
                          aria-valuenow={progress?.percent ?? undefined} aria-valuetext={progressText}
                          className="h-1.5 overflow-hidden rounded-full bg-white/10">
                          <div className={`h-full rounded-full ${progress?.stage === 'failed' ? 'bg-rose-400' : 'bg-blue-400'} ${progress?.percent == null ? 'w-full animate-pulse opacity-30' : 'transition-[width] duration-150'}`}
                            style={progress?.percent != null ? { width: `${progress.percent}%` } : undefined} />
                        </div>
                      </div>
                    )}
                    {/* 失败原因提示 */}
                    {isFailed && plan.error && (
                      <div className="mb-3 p-2 rounded-xl bg-rose-950/30 border border-rose-500/20 text-[11px] font-sans text-rose-300 flex items-center gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-400" />
                        <span className="truncate" title={plan.error}>失败原因: {plan.error}</span>
                      </div>
                    )}

                    {/* 产物路径展示 (已完成时醒目展示 + 一键定位) */}
                    {isCompleted && plan.outputPath && (
                      <div className="mb-3 p-2 rounded-xl bg-emerald-950/30 border border-emerald-500/20 text-[11px] font-mono text-emerald-300 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 truncate">
                          <FolderOpen className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
                          <span className="truncate" title={plan.outputPath}>
                            产物: {plan.outputPath}
                          </span>
                        </div>
                        <button
                          onClick={() => plan.outputPath && handleRevealInExplorer(plan.outputPath)}
                          className="shrink-0 px-2 py-0.5 rounded bg-emerald-600/30 hover:bg-emerald-600 text-emerald-200 hover:text-white font-sans text-[10px] transition-all"
                        >
                          打开目录
                        </button>
                      </div>
                    )}

                    {plan.resolvedEncoder && <p className="text-xs text-zinc-400 mb-2">实际编码器：{plan.resolvedEncoder.toUpperCase()}</p>}
                    {/* 统计指标行 */}
                    <div className="grid grid-cols-3 gap-2 py-2 px-3 rounded-xl bg-black/40 border border-white/5 text-xs font-mono mb-3">
                      <div>
                        <span className="text-zinc-400 text-[10px] block">切点数</span>
                        <span className="text-white font-bold">{plan.cutsCount} 个</span>
                      </div>
                      <div>
                        <span className="text-zinc-400 text-[10px] block">保留时长</span>
                        <span className="text-emerald-400 font-bold">
                          {plan.keptDurationMs === null ? '时长待确认' : formatTimecode(plan.keptDurationMs, false)}
                        </span>
                      </div>
                      <div>
                        <span className="text-zinc-400 text-[10px] block">原片总长</span>
                        <span className="text-zinc-300">
                          {plan.totalDurationMs === null ? '时长待确认' : formatTimecode(plan.totalDurationMs, false)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 底部操作区 */}
                  <div className="pt-3 border-t border-white/5 flex items-center justify-between text-xs">
                    <span className="text-[11px] text-zinc-400 font-mono">
                      更新: {new Date(plan.updatedAt).toLocaleTimeString()}
                    </span>

                    <div className="flex items-center gap-2">
                      {/* 复制 JSON */}
                      <button
                        onClick={() => handleCopyJson(plan)}
                        className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-all focus-visible:ring-2 focus-visible:ring-blue-500"
                        title="复制方案 JSON"
                      >
                        {copiedId === plan.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>

                      {/* 编辑回载 */}
                      <button
                        onClick={() => onLoadPlanIntoCutter(plan)}
                        className="px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white flex items-center gap-1 transition-all border border-white/10 focus-visible:ring-2 focus-visible:ring-blue-500 active:scale-95"
                        title={plan.compressionOnly ? '编辑整片压缩参数' : '将方案回载至工作台进行二次编辑'}
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>编辑</span>
                      </button>

                      {/* 停止导出 / 移出队列 / 单独启动 / 立即执行 / 重新导出 / 重试 */}
                      {isProcessing ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setPlanToStop(plan)}
                            disabled={actionLoading}
                            className="px-2.5 py-1.5 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white font-bold flex items-center gap-1 transition-all shadow-md active:scale-95 text-xs focus-visible:ring-2 focus-visible:ring-rose-400"
                            title="中断导出并安全清理临时切片"
                          >
                            <Square className="w-3.5 h-3.5 fill-current" />
                            <span>停止导出</span>
                          </button>
                        </div>
                      ) : isQueued ? (
                        <div className="flex items-center gap-1.5">
                          {engine.queuePaused && (
                            plan.id === engine.priorityPlanId ? (
                              <span className="px-2.5 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 font-bold flex items-center gap-1 text-xs">
                                <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                                <span>优先任务</span>
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleSetPriority(plan.id)}
                                disabled={actionLoading}
                                className="px-2.5 py-1.5 rounded-lg bg-amber-600/90 hover:bg-amber-500 text-white font-bold flex items-center gap-1 transition-all shadow-md active:scale-95 text-xs focus-visible:ring-2 focus-visible:ring-amber-400"
                                title="队列暂停时，指定该任务为下一优先执行任务"
                              >
                                <Star className="w-3.5 h-3.5" />
                                <span>单独启动</span>
                              </button>
                            )
                          )}
                          <button
                            type="button"
                            onClick={() => handleCancelQueued(plan.id)}
                            disabled={actionLoading}
                            className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-zinc-300 hover:text-white font-medium flex items-center gap-1 transition-all text-xs"
                            title="移出调度队列，恢复为待执行状态"
                          >
                            <span>移出队列</span>
                          </button>
                        </div>
                      ) : isFailed ? (
                        <button
                          disabled={isRunning}
                          onClick={() => handleExecuteSingle(plan.id)}
                          className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold flex items-center gap-1.5 transition-all shadow-md active:scale-95 text-xs focus-visible:ring-2 focus-visible:ring-rose-400"
                        >
                          {isRunning ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>排队中...</span>
                            </>
                          ) : (
                            <>
                              <RefreshCw className="w-3.5 h-3.5" />
                              <span>↻ 重试剪辑</span>
                            </>
                          )}
                        </button>
                      ) : isCompleted ? (
                        <button
                          disabled={isRunning}
                          onClick={() => handleExecuteSingle(plan.id)}
                          className="px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white font-semibold flex items-center gap-1.5 transition-all shadow-md active:scale-95 text-xs focus-visible:ring-2 focus-visible:ring-blue-500"
                        >
                          {isRunning ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>排队中...</span>
                            </>
                          ) : (
                            <>
                              <RefreshCw className="w-3.5 h-3.5" />
                              <span>↻ 重新导出</span>
                            </>
                          )}
                        </button>
                      ) : (
                        <button
                          disabled={isRunning}
                          onClick={() => handleExecuteSingle(plan.id)}
                          className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 shadow-emerald-500/20 text-white font-semibold flex items-center gap-1.5 transition-all shadow-md active:scale-95 text-xs focus-visible:ring-2 focus-visible:ring-emerald-400"
                        >
                          {isRunning ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>提交中...</span>
                            </>
                          ) : (
                            <>
                              <Rocket className="w-3.5 h-3.5" />
                              <span>🚀 立即执行</span>
                            </>
                          )}
                        </button>
                      )}

                      {/* 删除按钮 */}
                      <button
                        onClick={() => handleDeleteClick(plan)}
                        disabled={isProcessing}
                        className="p-1.5 rounded-lg bg-white/5 hover:bg-rose-500/15 text-rose-400/80 hover:text-rose-300 transition-colors focus-visible:ring-2 focus-visible:ring-rose-500/40"
                        title={isProcessing ? '处理中，完成后可删除' : isQueued ? '移出队列并删除方案' : '删除方案'}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {pages > 1 && <div className="flex justify-center gap-4 text-xs text-zinc-300"><button disabled={visiblePage === 1} onClick={() => setPage(visiblePage - 1)}>上一页</button><span>第 {visiblePage} / {pages} 页，每页 50 项</span><button disabled={visiblePage === pages} onClick={() => setPage(visiblePage + 1)}>下一页</button></div>}
      </div>

      {/* 应用内置暗黑确认删除模态框（彻底消除白底系统弹窗） */}
      {planToDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in select-none"
          onClick={() => setPlanToDelete(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-[#161b22] border border-rose-500/30 p-6 shadow-2xl text-left relative animate-in zoom-in-95"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
                <AlertCircle className="w-5 h-5 text-rose-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-white mb-1.5">
                  确认删除方案记录？
                </h3>
                <p className="text-xs text-zinc-300 mb-2 leading-relaxed">
                  即将永久删除方案记录：
                  <span className="text-rose-300 font-mono font-semibold block mt-1 truncate" title={planToDelete.title}>
                    「{planToDelete.title}」
                  </span>
                </p>
                <p className="text-[11px] text-zinc-400 leading-normal">
                  此操作仅移除方案管理中心内的配置卡片，绝不会删除您的原始视频文件。
                </p>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setPlanToDelete(null)}
                className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-zinc-300 hover:text-white text-xs font-semibold transition-all focus-visible:ring-2 focus-visible:ring-blue-500 active:scale-95"
              >
                取消 (Esc)
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition-all shadow-lg shadow-rose-600/30 active:scale-95 focus-visible:ring-2 focus-visible:ring-rose-400 flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>确认永久删除</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 单任务中断停止确认模态框 */}
      {planToStop && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in select-none"
          onClick={() => setPlanToStop(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-[#161b22] border border-rose-500/40 p-6 shadow-2xl text-left relative animate-in zoom-in-95"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
                <Square className="w-5 h-5 text-rose-400 fill-current" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-white mb-1.5">
                  确认停止导出此任务？
                </h3>
                <p className="text-xs text-zinc-300 mb-2 leading-relaxed">
                  即将停止方案导出：
                  <span className="text-rose-300 font-mono font-semibold block mt-1 truncate" title={planToStop.title}>
                    「{planToStop.title}」
                  </span>
                </p>
                <p className="text-[11px] text-zinc-400 leading-normal">
                  系统将安全终止 FFmpeg 转码子进程并彻底删除未完成的临时资产，该方案将恢复为待执行状态（ready），不会被标记为执行失败。
                </p>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setPlanToStop(null)}
                className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-zinc-300 hover:text-white text-xs font-semibold transition-all focus-visible:ring-2 focus-visible:ring-blue-500 active:scale-95"
              >
                继续导出 (Esc)
              </button>
              <button
                type="button"
                disabled={actionLoading}
                onClick={handleConfirmStop}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition-all shadow-lg shadow-rose-600/30 active:scale-95 focus-visible:ring-2 focus-visible:ring-rose-400 flex items-center gap-1.5"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>确认停止</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 全局全部停止确认模态框 */}
      {confirmCancelAll && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in select-none"
          onClick={() => setConfirmCancelAll(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-[#161b22] border border-rose-500/40 p-6 shadow-2xl text-left relative animate-in zoom-in-95"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
                <Square className="w-5 h-5 text-rose-400 fill-current" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-white mb-1.5">
                  确认全部停止？
                </h3>
                <p className="text-xs text-zinc-300 mb-2 leading-relaxed">
                  即将建立全部停止屏障，中断正在运行的导出任务并清空所有排队与优先任务。
                </p>
                <p className="text-[11px] text-zinc-400 leading-normal">
                  所有未完成任务将安全清理临时切片并恢复为待执行状态；已完成导出并生成成片的任务将受到完好保护，不会被重置。
                </p>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmCancelAll(false)}
                className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-zinc-300 hover:text-white text-xs font-semibold transition-all focus-visible:ring-2 focus-visible:ring-blue-500 active:scale-95"
              >
                取消 (Esc)
              </button>
              <button
                type="button"
                disabled={actionLoading}
                onClick={handleConfirmCancelAll}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition-all shadow-lg shadow-rose-600/30 active:scale-95 focus-visible:ring-2 focus-visible:ring-rose-400 flex items-center gap-1.5"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>确认全部停止</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
