import { startCli } from './cli';
// CLI 引导仅含纯参数解析；桌面动态导入必须顶层等待，Electron 才会等待协议注册。
if (process.argv.includes('--vct-cli')) {
  void startCli();
} else {
  await import('./desktop');
}
