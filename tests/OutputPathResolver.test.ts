import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveOutputBatch, resolveOutputDirectory } from '../src/main/services/OutputPathResolver';
import { ConfigService } from '../src/main/services/ConfigService';
import { RetentionDraft } from '../src/shared/RetentionDraft';

afterEach(() => vi.useRealTimers());

describe('裁剪产物共用 cut 目录', () => {
  it('不同素材、方案及无标题产物共用源目录下的 cut，整片压缩仍独立', () => {
    const parent = path.resolve('../videoCutTool_tmp/output-directory-20261026');
    for (const file of ['录像一.flv', '录像二.mp4']) {
      const source = path.join(parent, file), directory = resolveOutputDirectory(source);
      expect(directory).toBe(path.join(parent, 'cut'));
      expect(resolveOutputDirectory(source, true)).toBe(path.join(parent, '压缩'));
      for (const title of ['方案一', '方案二', undefined]) {
        const [output] = resolveOutputBatch({ directory, source, title, timestamp: '20261026_0010' });
        expect(path.dirname(output)).toBe(directory);
        expect(path.basename(output)).toContain(title ? `[${title}]` : '_cut_');
      }
    }
  });

  it('共用目录的分段重名会整组避让，旧目录、旧文件和原片保持原位', async () => {
    const base = path.resolve('../videoCutTool_tmp/output-directory-20261026');
    await fs.promises.mkdir(base, { recursive: true });
    const root = await fs.promises.mkdtemp(path.join(base, 'collision-'));
    const source = path.join(root, '原片.mp4'), oldDirectory = path.join(root, 'cut_方案');
    const directory = resolveOutputDirectory(source);
    await fs.promises.mkdir(directory); await fs.promises.mkdir(oldDirectory);
    const oldFile = path.join(oldDirectory, '旧成品.mp4');
    await fs.promises.writeFile(source, '原片哨兵'); await fs.promises.writeFile(oldFile, '旧成品哨兵');
    const options = { directory, source, title: '方案', segmented: true, count: 2, timestamp: '20261026_0010' };
    const first = resolveOutputBatch(options);
    await fs.promises.writeFile(first[1], '已存在分段');
    const next = resolveOutputBatch(options);
    expect(next).toHaveLength(2);
    expect(next.every(file => path.dirname(file) === directory && file.endsWith('_01.mp4'))).toBe(true);
    expect(new Set(next).size).toBe(2);
    expect(await fs.promises.readFile(first[1], 'utf8')).toBe('已存在分段');
    expect(await fs.promises.readFile(oldFile, 'utf8')).toBe('旧成品哨兵');
    expect(await fs.promises.readFile(source, 'utf8')).toBe('原片哨兵');
    expect((await fs.promises.readdir(root)).sort()).toEqual(['cut', 'cut_方案', '原片.mp4'].sort());
  });

  it('方案名进入文件名时仍拒绝路径分隔符', () => {
    const source = path.resolve('../videoCutTool_tmp/output-directory-20261026/原片.mp4');
    expect(() => resolveOutputBatch({ directory: resolveOutputDirectory(source), source, title: '../其他目录' })).toThrow('方案标题包含');
  });

  it.each(['keyframe', 'frame'] as const)('回载 %s 方案后预显检查所有分段，份数变化重新避让', async precision => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 26, 0, 10));
    const base = path.resolve('../videoCutTool_tmp/output-directory-20261026');
    await fs.promises.mkdir(base, { recursive: true });
    const root = await fs.promises.mkdtemp(path.join(base, 'preview-'));
    const source = path.join(root, '原片.mp4'), directory = resolveOutputDirectory(source);
    await fs.promises.mkdir(directory);
    const config = new ConfigService(path.join(root, 'data'));
    const draft = new RetentionDraft(source, 6000); draft.addCut(2000); draft.addCut(4000);
    draft.setOutputMode('separate'); draft.exportPrecision = precision;
    const record = draft.toRecord({ title: '方案', outputPath: path.join(root, 'cut_方案', '旧成品.mp4') });
    const original = JSON.stringify(record), restored = RetentionDraft.fromRecord(JSON.parse(original), 6000);
    expect(restored.exportPrecision).toBe(precision);
    expect(restored.getOutputs()).toEqual(draft.getOutputs());
    const options = { directory, source, title: record.title, segmented: true, count: 3, timestamp: '20261026_0010' };
    const paths = resolveOutputBatch(options);
    await fs.promises.writeFile(paths[2], '第三段已存在');
    expect(await config.resolveSafeOutputPath(source, 2, record.title, undefined, true, [], precision)).toBe(paths[0]);
    const expected = resolveOutputBatch(options)[0];
    expect(await config.resolveSafeOutputPath(source, restored.getOutputs().length, record.title, undefined, true, [], precision)).toBe(expected);
    expect(expected.endsWith('_01.mp4')).toBe(true);
    await fs.promises.writeFile(paths[1], '第二段已存在');
    expect(await config.resolveSafeOutputPath(source, 2, record.title, undefined, true, [], precision)).toBe(expected);
    expect(JSON.stringify(record)).toBe(original);
    expect(await fs.promises.readFile(paths[2], 'utf8')).toBe('第三段已存在');
    for (const count of [0, -1, 1.5, NaN, 10002]) await expect(config.resolveSafeOutputPath(source, count)).rejects.toThrow('输出份数无效');
  });
});
