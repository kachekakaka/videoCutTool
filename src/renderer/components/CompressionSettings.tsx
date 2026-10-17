import React, { useState } from 'react';
import { CompressConfig } from '../../shared/types';
import { COMPRESS_PRESETS } from '../../shared/compressPresets';

export const CompressionSettings: React.FC<{ value: CompressConfig; onChange: (value: CompressConfig) => void; disabled?: boolean }> = ({ value, onChange, disabled }) => {
  const [advanced, setAdvanced] = useState(false);
  return <fieldset disabled={disabled} className="space-y-3 disabled:opacity-50">
    <div className="grid grid-cols-2 gap-2">
      {Object.values(COMPRESS_PRESETS).map(preset => <button type="button" key={preset.id}
        onClick={() => onChange({ ...value, enabled: true, preset: preset.id, crf: preset.defaultCrf, maxHeight: preset.id === 'scale_1080p' ? 1080 : undefined })}
        className={`p-3 rounded-xl border text-left ${value.preset === preset.id ? 'bg-purple-600/20 border-purple-400 text-purple-200' : 'bg-black/20 border-white/10 text-zinc-300 hover:bg-white/5'}`}>
        <span className="block text-xs font-bold">{preset.title}</span><span className="block text-[10px] text-zinc-400 mt-1">{preset.summary}</span>
      </button>)}
    </div>
    <button type="button" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced} className="text-xs text-zinc-300">{advanced ? '收起' : '展开'}高级参数 · 画质 / 分辨率 / 硬件加速</button>
    {advanced && <div className="space-y-3 rounded-xl bg-black/20 p-3 border border-white/10 text-xs">
      <label className="block text-zinc-300">画质参数 CRF：{value.crf ?? 22}（越小画质越好）
        <input aria-label="画质参数 CRF" type="range" min={18} max={35} value={value.crf ?? 22} className="block w-full mt-2 accent-purple-500"
          onChange={e => onChange({ ...value, preset: 'custom', crf: Number(e.target.value) })} />
      </label>
      <label className="block text-zinc-300">分辨率限制
        <select aria-label="分辨率限制" value={value.maxHeight ?? (value.preset === 'scale_1080p' ? 1080 : 0)} className="mt-2 w-full p-2 bg-[#10131c] rounded-lg border border-white/10"
          onChange={e => onChange({ ...value, preset: value.preset === 'scale_1080p' ? 'custom' : value.preset, maxHeight: Number(e.target.value) || undefined })}>
          <option value={0}>原分辨率</option><option value={1080}>限高 1080p</option><option value={720}>限高 720p</option>
        </select>
      </label>
      <label className="flex gap-2 text-zinc-300"><input type="checkbox" checked={value.hardwareAcceleration !== false}
        onChange={e => onChange({ ...value, hardwareAcceleration: e.target.checked })} />优先启用 GPU 硬件加速</label>
    </div>}
    <p className="text-[11px] text-zinc-500">保留原始音轨，分辨率限制不放大小视频。实际体积与画质随素材变化。</p>
  </fieldset>;
};
