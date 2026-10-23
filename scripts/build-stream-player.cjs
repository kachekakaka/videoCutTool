// 固定版本、逐处匹配的构建补丁；不修改上游 node_modules 源码。
const fs = require('node:fs'), path = require('node:path'), esbuild = require('esbuild');
const root = path.resolve(__dirname, '..'), source = path.join(root, 'node_modules/mpegts.js/src');
if (require('mpegts.js/package.json').version !== '1.8.2') throw Error('流式播放器依赖版本不匹配');
function replace(text, from, to, label) {
  if (text.split(from).length !== 2) throw Error('播放器补丁匹配失败：' + label);
  return text.replace(from, to);
}
esbuild.build({ entryPoints: [path.join(source, 'index.js')], outfile: path.join(root, 'node_modules/.cache/vct-mpegts/player.js'), bundle: true, format: 'esm', platform: 'browser', plugins: [{ name: 'vct-stream-player', setup(build) {
  build.onLoad({ filter: /flv-demuxer\.js$/ }, args => {
    let s = fs.readFileSync(args.path, 'utf8');
    s = replace(s, '    resetMediaInfo() {', `    resetPendingSamples() {
        this._videoTrack.samples = []; this._videoTrack.length = 0;
        this._audioTrack.samples = []; this._audioTrack.length = 0;
    }
    resetMediaInfo() {`, '清空 FLV 旧样本');
    return { contents: s, loader: 'js' };
  });
  build.onLoad({ filter: /ts-demuxer\.ts$/ }, args => {
    let s = fs.readFileSync(args.path, 'utf8');
    s = replace(s, '    public resetMediaInfo() {', `    public resetPendingSamples() {
        this.video_track_.samples = []; this.video_track_.length = 0;
        this.audio_track_.samples = []; this.audio_track_.length = 0;
        this.pes_slice_queues_ = {}; this.section_slice_queues_ = {};
        this.audio_last_sample_pts_ = undefined; this.aac_last_incomplete_data_ = null;
        this.loas_previous_frame = null;
        this.last_pcr_ = undefined; this.last_pcr_base_ = NaN; this.timestamp_offset_ = 0;
    }
    public resetMediaInfo() {`, '清空 TS 拼包和旧样本');
    return { contents: s, loader: 'ts' };
  });
  build.onLoad({ filter: /transmuxing-controller\.js$/ }, args => {
    let s = fs.readFileSync(args.path, 'utf8');
    s = replace(s, '        let targetSegmentIndex = this._searchSegmentIndexContains(milliseconds);', '        this._demuxer.resetPendingSamples();\n        let targetSegmentIndex = this._searchSegmentIndexContains(milliseconds);', '字节寻址前清空');
    // 两种封装在同一公开配置入口使用受校验索引，数组引用允许后台追加。
    s = replace(s, '    _onMediaInfo(mediaInfo) {', `    _onMediaInfo(mediaInfo) {
        if (this._config.vctExternalIndex) {
            mediaInfo.hasKeyframesIndex = true;
            mediaInfo.keyframesIndex = this._config.vctExternalIndex;
        }`, '注入外部索引');
    return { contents: s, loader: 'js' };
  });
  build.onLoad({ filter: /loading-controller\.ts$/ }, args => ({ contents: replace(fs.readFileSync(args.path, 'utf8'), '    public suspendTransmuxer(): void {', `    public resetForSeek(): void {
        this._paused = false;
        this._media_element.removeEventListener('timeupdate', this.e.onMediaTimeUpdate);
    }
    public suspendTransmuxer(): void {`, '重置预读状态'), loader: 'ts' }));
  build.onLoad({ filter: /mp4-remuxer\.js$/ }, args => {
    let s = fs.readFileSync(args.path, 'utf8');
    const a = s.indexOf('    _remuxAudio(audioTrack, force) {'), v = s.indexOf('    _remuxVideo(videoTrack, force) {');
    let audio = replace(s.slice(a, v), '        if (samples.length === 1 && !force) {', "        if (samples.length === 1 && !force && this._audioMeta.codec === 'mp3') {", 'AAC 单包');
    audio = replace(audio, '        if (samples.length > 1) {', "        if (samples.length > 1 && this._audioMeta.codec === 'mp3') {", 'AAC 末包');
    s = s.slice(0, a) + audio + s.slice(v);
    s = replace(s, '        this._config = config;', '        this._config = config;\n        this._vctVideoPending = [];\n        this._vctVideoDecodeEnd = null;', '解码组初始化');
    for (const method of ['    seek(originalDts) {', '    destroy() {']) s = replace(s, method, method + '\n        this._vctVideoPending = [];\n        this._vctVideoDecodeEnd = null;', method);
    s = replace(s, '    _remuxVideo(videoTrack, force) {', fs.readFileSync(path.join(__dirname, 'stream-video-gop.txt'), 'utf8') + '    _remuxVideoBatch(videoTrack, force) {', '精确展示区间');
    const marker = '    _remuxVideoBatch(videoTrack, force) {'; let [head, tail] = s.split(marker);
    tail = replace(tail, '        if (samples.length > 1) {', '        if (samples.length > 1 && !force) {', '完整组不截尾');
    tail = replace(tail, '            if (isKeyframe) {', '            if (sample.vctPresentationDuration != null) sampleDuration = sample.vctPresentationDuration;\n\n            if (isKeyframe) {', '帧区间');
    return { contents: head + marker + tail, loader: 'js' };
  });
  build.onLoad({ filter: /mp4-generator\.js$/ }, args => ({ contents: replace(fs.readFileSync(args.path, 'utf8'), '            0x00, 0x00, 0x0F, 0x01,      // version(0) & flags', '            0x01, 0x00, 0x0F, 0x01,      // 有符号 CTS', '有符号 CTS'), loader: 'js' }));
  build.onLoad({ filter: /player-engine-(main|dedicated)-thread\.ts$/ }, args => {
    let s = fs.readFileSync(args.path, 'utf8').replace("import * as EventEmitter from 'events';", "import EventEmitter from 'events';").replace("import * as work from '../utils/webworkify-webpack';", "import work from '../utils/webworkify-webpack';");
    if (args.path.endsWith('player-engine-main-thread.ts')) {
      s = replace(s, '    private _onRequiredUnbufferedSeek(milliseconds: number): void {', '    private _onRequiredUnbufferedSeek(milliseconds: number): void {\n        this._loading_controller.resetForSeek();', '寻址后恢复预读');
      s = replace(s, '            this._loading_controller.notifyBufferedPositionChanged(ms.info.endDts / 1000);', '            this._loading_controller.notifyBufferedPositionChanged();', '按可播放区间控制预读');
    }
    return { contents: s, loader: 'ts' };
  });
} }] }).catch(error => { console.error(error); process.exitCode = 1; });
