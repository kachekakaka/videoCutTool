import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishOutput, removePublished } from '../src/main/services/OutputPublisher';

afterEach(() => vi.restoreAllMocks());
async function setup() {
  const base = path.resolve('../videoCutTool_tmp/20261117-same-volume/unit');
  await fs.promises.mkdir(base, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(base, 'publish-'));
  const source = path.join(directory, 'source.bin'), output = path.join(directory, 'output.bin');
  await fs.promises.writeFile(source, '完整内容');
  return { source, output };
}
describe('统一排他发布', () => {
  it('同卷发布只增加名称，取消和删除临时名称不影响成品', async () => {
    const x = await setup(), controller = new AbortController();
    const identity = await publishOutput(x.source, x.output, controller.signal);
    expect((await fs.promises.stat(x.output)).ino).toBe(identity.ino);
    controller.abort(); await fs.promises.unlink(x.source);
    expect(await fs.promises.readFile(x.output, 'utf8')).toBe('完整内容');
  });
  it.each(['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'ENOSPC'])('%s 直接失败且不复制', async code => {
    const x = await setup();
    vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    const copy = vi.spyOn(fs.promises, 'copyFile'), open = vi.spyOn(fs.promises, 'open');
    await expect(publishOutput(x.source, x.output)).rejects.toMatchObject({ code });
    expect(copy).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(fs.existsSync(x.output)).toBe(false);
  });
  it('占用和竞争者文件均不会覆盖或撤销', async () => {
    const x = await setup(); const identity = await fs.promises.stat(x.source);
    await fs.promises.writeFile(x.output, '其他文件');
    await expect(publishOutput(x.source, x.output)).rejects.toMatchObject({ code: 'EEXIST' });
    await removePublished(x.output, identity);
    expect(await fs.promises.readFile(x.output, 'utf8')).toBe('其他文件');
  });
  it('发布前取消不创建成品', async () => {
    const x = await setup(), controller = new AbortController(); controller.abort();
    await expect(publishOutput(x.source, x.output, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(x.output)).toBe(false);
  });
});
