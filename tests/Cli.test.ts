import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { parseArguments } from '../src/main/cli/arguments';
import { acquireCliDirectory } from '../src/main/cli/DataDirectory';
import { ConfigService } from '../src/main/services/ConfigService';

const root = path.resolve('../videoCutTool_tmp/20261117-cli/unit');
const common = ['--input', path.join(root, '中文 空格 & [原片].mp4'), '--output', path.join(root, '成品.mp4'), '--data-dir', path.join(root, 'data')];
describe('CLI 参数和数据目录', () => {
  it('帮助和版本仅解析，不创建目录；中文和特殊字符保持原值', () => {
    expect(parseArguments(['--help'])).toEqual({ kind: 'help' });
    expect(parseArguments(['--version'])).toEqual({ kind: 'version' });
    expect(parseArguments(['compress', ...common])).toMatchObject({ kind: 'task', request: { inputPath: common[1], compress: { preset: 'balanced', encoder: 'auto' } } });
  });
  it.each([
    ['compress', ...common, '--unknown'], ['compress', ...common, '--input', common[1]],
    ['compress', ...common, '--encoder'], ['compress', ...common, '--crf', '24'],
    ['compress', ...common, '--preset', 'custom', '--crf', '52'], ['compress', ...common, '--preset', 'custom', '--max-height', '1'],
    ['compress', ...common, '--encoder', 'invalid'], ['cut', ...common],
    ['cut', ...common, '--range', '10:10'], ['cut', ...common, '--range', '-1:10'],
    ['cut', ...common, '--range', '0:10', '--range', '9:20'], ['cut', ...common, '--range', '0:1.5'],
    ['cut', ...common, '--range', '0:10', '--preset', 'balanced'], ['--help', ...common],
    ['compress', '--input', 'relative.mp4', ...common.slice(2)],
  ])('拒绝非法命令 %j', (...args) => { expect(() => parseArguments(args)).toThrow(); });
  it('允许 custom 和顺序相邻区间', () => {
    expect(parseArguments(['compress', ...common, '--preset', 'custom', '--crf', '24', '--max-height', '1080'])).toMatchObject({ request: { compress: { crf: 24, maxHeight: 1080 } } });
    expect(parseArguments(['cut', ...common, '--range', '0:10', '--range', '10:20'])).toMatchObject({ request: { ranges: [{ startMs: 0, endMs: 10 }, { startMs: 10, endMs: 20 }] } });
  });
  it('OS 锁拒绝并发和目录别名，释放后可重取；桌面/CLI 目录双向隔离', async () => {
    await fs.promises.mkdir(root, { recursive: true });
    const directory = await fs.promises.mkdtemp(path.join(root, 'data-'));
    const alias = directory + '-alias';
    await fs.promises.symlink(directory, alias, 'junction');
    const first = await acquireCliDirectory(directory);
    try {
      await expect(acquireCliDirectory(alias)).rejects.toMatchObject({ code: 'DIRECTORY_BUSY' });
      expect(() => new ConfigService(directory)).toThrow('CLI');
      const cliConfig = new ConfigService(directory, undefined, 'cli').getConfig();
      expect(cliConfig.ffmpegPath).toBe(''); expect(cliConfig.ffprobePath).toBe('');
      expect(cliConfig.plansStoragePath).toBe(path.join(directory, 'plans'));
      expect(() => ConfigService.setupDataDirectory(root, directory)).toThrow('CLI');
      expect(fs.existsSync(path.join(root, 'workspace.json'))).toBe(false);
    } finally { await first.close(); }
    const second = await acquireCliDirectory(alias); await second.close();
    const desktop = await fs.promises.mkdtemp(path.join(root, 'desktop-')); new ConfigService(desktop);
    await expect(acquireCliDirectory(desktop)).rejects.toMatchObject({ code: 'DATA_DIRECTORY_INVALID' });
  });
});
