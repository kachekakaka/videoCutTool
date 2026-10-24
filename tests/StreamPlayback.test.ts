import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { StreamPlaybackSessionService } from '../src/main/services/StreamPlaybackSessionService';
import { StreamPlaybackIndexService } from '../src/main/services/StreamPlaybackIndexService';

describe('流式播放会话边界', () => {
  const create = (identify = async () => 'flv') => {
    const release = vi.fn();
    const indexes = { identify, acquire: vi.fn(async () => ({ release, job: { data: { container: 'flv' } } })), snapshot: () => ({}), check: async () => {}, shutdown: async () => {} };
    return { service: new StreamPlaybackSessionService(indexes as unknown as StreamPlaybackIndexService), indexes, release };
  };
  it('识别尚未结束就关闭时，不再取得索引引用', async () => {
    let resolve!: (value: string) => void;
    const { service, indexes } = create(() => new Promise<string>(r => { resolve = r; }));
    const pending = service.open(1, 'unused', 'pending');
    service.close(1, 'pending'); resolve('flv');
    await expect(pending).rejects.toThrow();
    expect(indexes.acquire).not.toHaveBeenCalled();
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
