import React, { useState, useEffect } from 'react';
import { PlanRecord } from '../../shared/types';
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
} from 'lucide-react';
import { formatTimecode } from './VideoPlayer';

interface PlansPageProps {
  onLoadPlanIntoCutter: (plan: PlanRecord) => void;
}

export const PlansPage: React.FC<PlansPageProps> = ({ onLoadPlanIntoCutter }) => {
  const [plans, setPlans] = useState<PlanRecord[]>([]);
  const [filter, setFilter] = useState<'all' | 'ready' | 'completed'>('all');
  const [loading, setLoading] = useState(false);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchPlans = async () => {
    setLoading(true);
    try {
      if (window.electronAPI) {
        const loaded = await window.electronAPI.listPlans();
        setPlans(loaded);
      }
    } catch (err) {
      console.error('获取方案列表失败:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlans();
  }, []);

  const handleExecuteSingle = async (planId: string) => {
    setExecutingId(planId);
    try {
      if (window.electronAPI) {
        await window.electronAPI.executePlan(planId);
        await fetchPlans();
      }
    } catch (err) {
      console.error('执行方案失败:', err);
    } finally {
      setExecutingId(null);
    }
  };

  const handleBatchExecute = async () => {
    setBatchRunning(true);
    try {
      if (window.electronAPI) {
        await window.electronAPI.batchExecutePlans();
        await fetchPlans();
      }
    } catch (err) {
      console.error('批量执行方案失败:', err);
    } finally {
      setBatchRunning(false);
    }
  };

  const handleDelete = async (planId: string) => {
    if (window.confirm('确定要永久删除该方案记录吗？')) {
      if (window.electronAPI) {
        await window.electronAPI.deletePlan(planId);
        await fetchPlans();
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
    if (filter === 'completed') return p.status === 'completed';
    return true;
  });

  const readyCount = plans.filter((p) => p.status === 'ready').length;
  const completedCount = plans.filter((p) => p.status === 'completed').length;

  return (
    <div className="flex-1 h-full overflow-y-auto px-8 py-6">
      <div className="max-w-[1360px] mx-auto space-y-6">
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
              集中管理所有持久化保存的剪辑方案，已完成剪辑方案清晰标记，支持批量极速无损导出
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
                全部方案 ({plans.length})
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
              <button
                onClick={() => setFilter('completed')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                  filter === 'completed'
                    ? 'bg-emerald-600 text-white shadow-sm font-bold'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>已完成剪辑 ({completedCount})</span>
              </button>
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
                    <span>批量剪辑中...</span>
                  </>
                ) : (
                  <>
                    <Rocket className="w-4 h-4" />
                    <span>🚀 批量执行待办 ({readyCount})</span>
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
              在工作台载入视频并打标后，点击【存为方案】或【立即执行剪辑】，对应方案将自动保存并出现在这里。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredPlans.map((plan) => {
              const isCompleted = plan.status === 'completed';
              const isRunning = executingId === plan.id;

              return (
                <div
                  key={plan.id}
                  className={`p-5 rounded-2xl border transition-all shadow-xl flex flex-col justify-between ${
                    isCompleted
                      ? 'bg-[#161b22]/90 border-emerald-500/30'
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

                      {/* 状态徽章 */}
                      {isCompleted ? (
                        <span className="shrink-0 text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1 font-bold">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          <span>已完成剪辑</span>
                        </span>
                      ) : (
                        <span className="shrink-0 text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1 font-medium">
                          <Clock className="w-3.5 h-3.5 text-amber-400" />
                          <span>⏳ 待执行</span>
                        </span>
                      )}
                    </div>

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

                    {/* 统计指标行 (text-zinc-400 满足 WCAG AA 4.5:1 对比度) */}
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
                        title="复制方案 JSON (兼容 JA_WORKSPACE)"
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

                      {/* 立即执行 / 重新导出 */}
                      <button
                        disabled={isRunning}
                        onClick={() => handleExecuteSingle(plan.id)}
                        className={`px-3 py-1.5 rounded-lg text-white font-semibold flex items-center gap-1.5 transition-all shadow-md active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-blue-500 ${
                          isCompleted
                            ? 'bg-zinc-700 hover:bg-zinc-600'
                            : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-500/20'
                        }`}
                      >
                        {isRunning ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>剪辑中...</span>
                          </>
                        ) : isCompleted ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5" />
                            <span>↻ 重新导出</span>
                          </>
                        ) : (
                          <>
                            <Rocket className="w-3.5 h-3.5" />
                            <span>🚀 立即执行</span>
                          </>
                        )}
                      </button>

                      {/* 删除按钮 */}
                      <button
                        onClick={() => handleDelete(plan.id)}
                        className="p-1.5 rounded-lg bg-white/5 hover:bg-rose-500/15 text-rose-400/80 hover:text-rose-300 transition-colors focus-visible:ring-2 focus-visible:ring-rose-500/40"
                        title="删除方案"
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
      </div>
    </div>
  );
};
