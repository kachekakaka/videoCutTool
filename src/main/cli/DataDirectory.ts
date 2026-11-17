import fs from 'fs';
import path from 'path';
import net from 'net';
import { ProcessingError } from '../../shared/processingTask';

export const cliMarker = '.videocuttool-cli.json';
export async function acquireCliDirectory(directory: string) {
  await fs.promises.mkdir(directory, { recursive: true });
  const real = await fs.promises.realpath(directory);
  const identity = await fs.promises.stat(real, { bigint: true });
  // 目录的卷号和文件身份不随大小写、junction 或路径别名改变；命名管道由 OS 持有。
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\vct-cli-${identity.dev}-${identity.ino}` : path.join(real, '.cli-owner.sock');
  const server = net.createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', error => reject(new ProcessingError('DIRECTORY_BUSY', `CLI 数据目录无法独占：${error.message}`, 4)));
    server.listen(pipe, resolve);
  });
  const close = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  try {
    const marker = path.join(real, cliMarker);
    const entries = await fs.promises.readdir(real);
    if (!entries.includes(cliMarker)) {
      if (entries.some(entry => entry !== '.cli-owner.sock')) throw new ProcessingError('DATA_DIRECTORY_INVALID', '已有非空目录不能作为新的 CLI 数据目录，请选择独立空目录');
      await fs.promises.writeFile(marker, JSON.stringify({ purpose: 'videocuttool-cli', version: 1 }), { flag: 'wx' });
    } else {
      const value = JSON.parse(await fs.promises.readFile(marker, 'utf8'));
      if (value.purpose !== 'videocuttool-cli' || value.version !== 1) throw new ProcessingError('DATA_DIRECTORY_INVALID', 'CLI 用途标记无效');
    }
    return { directory: real, close };
  } catch (error) { await close(); throw error; }
}
