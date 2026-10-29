import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { StreamPlaybackSessionService } from '../src/main/services/StreamPlaybackSessionService';
import { StreamPlaybackIndexService } from '../src/main/services/StreamPlaybackIndexService';
import type { StreamPreparationSnapshot } from '../src/shared/streamPlayback';
import type { MediaMetadata } from '../src/shared/types';

describe('流式播放会话边界', () => {
  const create = (identify = async () => 'flv') => {
    const release = vi.fn();
    const indexes = { identify, acquire: vi.fn(async () => ({ release, job: { data: { container: 'flv' } } })), snapshot: vi.fn(() => ({})), preparation: vi.fn((): StreamPreparationSnapshot => ({ complete: false, progress: 25 })), progress: vi.fn(() => ({ complete: false, progress: 25 })), check: vi.fn(async () => {}), shutdown: async () => {} };
    return { service: new StreamPlaybackSessionService(indexes as unknown as StreamPlaybackIndexService), indexes, release };
  };
  it.each(['open', 'openPreparation'] as const)('%s 识别尚未结束就关闭时，不再取得索引引用', async method => {
    let resolve!: (value: string) => void;
    const { service, indexes } = create(() => new Promise<string>(r => { resolve = r; }));
    const pending = service[method](1, 'unused', 'pending');
    service.close(1, 'pending'); resolve('flv');
    await expect(pending).rejects.toThrow();
    expect(indexes.acquire).not.toHaveBeenCalled();
    await service.shutdown();
  });
  it('准备仅生成编辑结果；播放接管后关闭准备会话不影响播放引用', async () => {
    const { service, indexes, release } = create();
    const metadata = { filePath: 'unused', keyframes: [0, 2000] } as MediaMetadata;
    try {
      expect(await service.openPreparation(1, 'unused', 'prepare')).toEqual({ complete: false, progress: 25 });
      expect(indexes.snapshot).not.toHaveBeenCalled();
      indexes.preparation.mockReturnValue({ complete: true, progress: 100, metadata });
      expect((await service.preparation(1, 'prepare')).metadata).toBe(metadata);
      expect(indexes.snapshot).not.toHaveBeenCalled();
      await expect(service.preparation(2, 'prepare')).rejects.toThrow();
      await service.open(1, 'unused', 'player');
      expect(release).not.toHaveBeenCalled();
      service.close(1, 'prepare'); service.close(1, 'prepare');
      expect(release).toHaveBeenCalledTimes(1);
      expect((await service.status(1, 'player')).id).toBe('player');
      await expect(service.preparation(1, 'prepare')).rejects.toThrow();
      service.close(1, 'player');
      expect(release).toHaveBeenCalledTimes(2);
    } finally { await service.shutdown(); }
  });
  it('准备报告时间轴异常时保留引用，允许同次分析继续到用户取消', async () => {
    const { service, indexes, release } = create();
    indexes.preparation.mockReturnValue({ complete: false, progress: 25, error: '时间轴异常', errorCode: 'TIMELINE_DISCONTINUITY' });
    try {
      expect((await service.openPreparation(1, 'unused', 'repair'))?.errorCode).toBe('TIMELINE_DISCONTINUITY');
      expect(release).not.toHaveBeenCalled();
      expect((await service.preparation(1, 'repair')).progress).toBe(25);
      expect(indexes.snapshot).not.toHaveBeenCalled();
      service.close(1, 'repair');
      expect(release).toHaveBeenCalledTimes(1);
    } finally { await service.shutdown(); }
  });
  it('进度请求不构建完整快照，且保持窗口和取消边界', async () => {
    const { service, indexes } = create();
    await service.open(1, 'unused', 'progress');
    indexes.snapshot.mockClear();
    expect(await service.progress(1, 'progress')).toEqual({ complete: false, progress: 25 });
    expect(indexes.snapshot).not.toHaveBeenCalled();
    expect(indexes.check).toHaveBeenCalledTimes(1);
    await expect(service.progress(2, 'progress')).rejects.toThrow();
    service.closeOwner(1);
    await expect(service.progress(1, 'progress')).rejects.toThrow();
    await service.shutdown();
  });
  it('窗口隔离、有限范围读取、越界拒绝及关闭后引用释放', async () => {
    const base = path.resolve('../videoCutTool_tmp/stream-integration-20261024/unit');
    await fs.promises.mkdir(base, { recursive: true });
    const directory = await fs.promises.mkdtemp(path.join(base, 'range-'));
    const file = path.join(directory, 'source.bin'); await fs.promises.writeFile(file, '0123456789');
    const { service, release } = create();
    try {
      await service.open(1, file, 'view');
      const request = (range: string) => new Request('media://stream/view', { headers: { range } });
      expect((await service.respond(2, request('bytes=0-1'))).status).toBe(403);
      service.close(2, 'view'); expect(release).not.toHaveBeenCalled();
      const response = await service.respond(1, request('bytes=3-5'));
      expect(response.status).toBe(206); expect(response.headers.get('content-range')).toBe('bytes 3-5/10');
      expect(await response.text()).toBe('345');
      for (const range of ['bytes=9-10', 'bytes=5-3', 'bytes=-1', 'bytes=0-1,3-4']) expect((await service.respond(1, request(range))).status).toBe(416);
      service.closeOwner(1); expect(release).toHaveBeenCalledTimes(1);
      expect((await service.respond(1, request('bytes=0-'))).status).toBe(403);
      expect(await fs.promises.readFile(file, 'utf8')).toBe('0123456789');
    } finally { await service.shutdown(); }
  });
});
