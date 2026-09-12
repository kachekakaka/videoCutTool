const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const pkg = require('../package.json');

function mediaTool(name, variable) {
  const configured = process.env[variable];
  const candidates = configured ? [configured] : [path.resolve(__dirname, '../tools', `${name}.exe`), `D:/Tools/ffmpeg/${name}.exe`, ...(process.env.PATH || '').split(path.delimiter).map(directory => path.join(directory, `${name}.exe`))];
  const file = candidates.find(candidate => fs.existsSync(candidate));
  if (!file) throw new Error(`缺少 ${name}，请通过 ${variable} 指定可执行文件完整路径`);
  const result = spawnSync(file, ['-version'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error(`${name} 不可运行：${file}`);
  return path.resolve(file);
}

module.exports = {
  ...pkg.build,
  extraResources: [
    { from: mediaTool('ffmpeg', 'VCT_FFMPEG_PATH'), to: 'bin/ffmpeg.exe' },
    { from: mediaTool('ffprobe', 'VCT_FFPROBE_PATH'), to: 'bin/ffprobe.exe' },
  ],
};
