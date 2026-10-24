import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle } from 'lucide-react';
import { TimelineRepairConfirmation } from '../../shared/timelineRepair';

export function TimelineRepairDialog({ confirmation, onCancel, onConfirm }: {
  confirmation: TimelineRepairConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  // 浏览器模态层阻止背景点击和焦点穿透；不使用操作系统消息框。
  return createPortal(
    <dialog ref={dialogRef} aria-labelledby="timeline-repair-title" aria-describedby="timeline-repair-description"
      onCancel={event => { event.preventDefault(); onCancel(); }}
      onKeyDown={event => event.stopPropagation()}
      className="m-auto w-[calc(100%-2rem)] max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-white/10 bg-[#161b22] p-5 sm:p-6 text-zinc-200 shadow-2xl backdrop:bg-black/75 backdrop:backdrop-blur-sm">
      <div className="flex items-center gap-3 mb-4">
        <AlertCircle className="w-6 h-6 shrink-0 text-amber-400" />
        <h2 id="timeline-repair-title" className="text-base font-bold text-white">确认修复时间轴</h2>
      </div>
      <p id="timeline-repair-description" className="text-sm mb-4">无损保存为新 MP4 后继续编辑</p>
      <dl className="space-y-3 rounded-xl border border-white/10 bg-black/25 p-4 text-xs">
        <div><dt className="text-zinc-400 mb-1">原片（保留，不覆盖）</dt><dd className="break-all select-text leading-relaxed">{confirmation.source}</dd></div>
        <div><dt className="text-zinc-400 mb-1">新文件（MP4）</dt><dd className="break-all select-text leading-relaxed text-blue-300">{confirmation.output}</dd></div>
      </dl>
      <div className="mt-4 space-y-2 text-xs leading-relaxed text-zinc-300">
        <p>仅修复时间轴并无损另存为 MP4，不重新编码。原片和已保存方案都保留，不自动迁移切点。</p>
        <p>修复会读取整段录像，需要额外磁盘空间。跨盘保存会先在目标盘的受管临时目录完成复制。</p>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button type="button" autoFocus onClick={onCancel} className="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400">取消</button>
        <button type="button" onClick={onConfirm} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400">开始修复</button>
      </div>
    </dialog>, document.body
  );
}
