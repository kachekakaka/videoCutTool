import React, { useState, useEffect } from 'react';
import { PlanRecord } from '../../shared/types';
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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [planToDelete, setPlanToDelete] = useState<PlanRecord | null>(null);

  useEffect(() => setPage(1), [filter]);

  // Esc 键关闭删除确认模态框
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && planToDelete) {
        setPlanToDelete(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [planToDelete]);

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
    setBatchRunning(true);
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.batchExecutePlans();
        setNotice(`已接受 ${result.queued} / ${result.total} 个方案${result.errors?.length ? '；' + result.errors.join('；') : ''}`);
      }
    } catch (err) {
      setNotice(`批量执行失败：${String(err)}`);
    } finally {
      setBatchRunning(false);
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
              集中管理所有持久化保存的剪辑方案，后台异步队列无缝调度，已完成方案支持一键定位产物
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

            <button
              onClick={fetchPlans}
              className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white border border-white/10 transition-all focus-visible:ring-2 focus-visible:ring-blue-500 active:scale-95"
              title="刷新列表"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* 方案卡片列表 */}
        {filteredPlans.length === 0 ? (
          <div className="border border-white/10 rounded-3xl p-16 flex flex-col items-center justify-center bg-[#161b22]/40 backdrop-blur-md">
            <FolderKanban className="w-12 h-12 text-zinc-600 mb-3" />
            <h3 className="text-sm font-semibold text-zinc-300">当前分类暂无方案记录</h3>
            <p className="text-xs text-zinc-400 mt-1 max-w-[360px] text-center">
              在工作台载入视频并打标后，点击【存为方案】或【立即执行剪辑】，方案将自动保存至本中心并在后台队列异步调度。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredPlans.slice((visiblePage - 1) * 50, visiblePage * 50).map((plan) => {
              const isCompleted = plan.status === 'completed';
              const isProcessing = plan.status === 'processing';
              const isQueued = plan.status === 'queued';
              const isFailed = plan.status === 'failed';
              const isRunning = executingId === plan.id;

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
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <FileVideo className="w-4 h-4 text-blue-400 shrink-0" />
                        <h3 className="text-sm font-bold text-white truncate" title={plan.title}>
                          {plan.title}
                        </h3>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {/* 导出模式属性徽章 */}
                        {plan.compress?.enabled ? (
                          <span className="text-[11px] bg-purple-500/15 text-purple-300 border border-purple-500/30 px-2 py-0.5 rounded-full flex items-center gap-1 font-mono font-medium" title={plan.compress.preset === 'custom' ? '自定义 CRF 压缩' : COMPRESS_PRESETS[plan.compress.preset]?.summary}>
                            <span>📦</span>
                            <span>
                              {plan.compress.preset === 'custom'
                                ? `自定义 (CRF ${plan.compress.crf ?? 22})`
                                : `${COMPRESS_PRESETS[plan.compress.preset]?.title || '降码'} (CRF ${plan.compress.crf ?? COMPRESS_PRESETS[plan.compress.preset]?.defaultCrf ?? 22})`}
                            </span>
                          </span>
                        ) : (
                          <span className="text-[11px] bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 px-2 py-0.5 rounded-full flex items-center gap-1 font-mono font-medium" title="无损流复制秒级导出">
                            <Zap className="w-3 h-3 text-cyan-400" />
                            <span>无损秒切</span>
                          </span>
                        )}

                        {/* 状态徽章 */}
                        {isCompleted ? (
                          <span className="text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1 font-bold">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            <span>已完成</span>
                          </span>
                        ) : isProcessing ? (
                          <span className="text-xs bg-blue-500/20 text-blue-300 border border-blue-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1 font-bold animate-pulse">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
                            <span>处理中...</span>
                          </span>
                        ) : isQueued ? <span className="text-xs text-blue-300">排队中</span> : isFailed ? (
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
                          onClick={() => handleRevealInExplorer(plan.outputPath)}
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
                          {formatTimecode(plan.keptDurationMs, false)}
                        </span>
                      </div>
                      <div>
                        <span className="text-zinc-400 text-[10px] block">原片总长</span>
                        <span className="text-zinc-300">
                          {formatTimecode(plan.totalDurationMs, false)}
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
                        title="将方案回载至工作台进行二次编辑"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>编辑</span>
                      </button>

                      {/* 立即执行 / 重新导出 / 重试 */}
                      {isProcessing || isQueued ? (
                        <button
                          disabled={true}
                          className="px-3 py-1.5 rounded-lg text-white font-semibold flex items-center gap-1.5 bg-blue-600/50 cursor-not-allowed opacity-80 text-xs"
                        >
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>{isQueued ? '排队中...' : '后台处理中...'}</span>
                        </button>
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
    </div>
  );
};
