import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheMaintenanceService, CachePolicy, externalTemporaryDirectory, registerMediaSpawn } from '../src/main/services/CacheMaintenanceService';
import { PreviewCache } from '../src/main/services/PreviewCache';
import { runMediaTool } from '../src/main/services/MediaTools';

const base = path.resolve('../videoCutTool_tmp/cache-maintenance-qa/unit');
let clock: number, directory: string, root: string, manager: CacheMaintenanceService;
const managers: CacheMaintenanceService[] = [];
const policy: CachePolicy = { bytes: 8, count: 2, ttl: 1000, grace: 100 };
function make(registry = path.join(directory, 'registry')) {
  const item = new CacheMaintenanceService(registry, { now: () => clock, policies: { playback: policy, picture: policy, index: policy } });
  managers.push(item); return item;
}
async function cache(bytes: number, cacheId = String(Math.random())) {
  const file = await manager.create(root, 'playback', '.mp4', cacheId);
  await fs.promises.writeFile(file, Buffer.alloc(bytes, 3)); await manager.ready(file); return file;
}
beforeEach(async () => {
  clock = 10000; await fs.promises.mkdir(base, { recursive: true }); directory = await fs.promises.mkdtemp(path.join(base, 'case-'));
  root = path.join(directory, 'playback_cache/managed'); manager = make(); await manager.registerRoot(root);
});
afterEach(async () => { for (const item of managers.splice(0)) await item.close(); vi.restoreAllMocks(); });

describe('缓存回收的使用保护与所有权边界', () => {
  it('开发环境与 release 版本子目录解析到同一个临时空间', () => {
    const repo=path.resolve('.');expect(externalTemporaryDirectory(path.join(repo,'release/version'))).toBe(externalTemporaryDirectory(repo));
    expect(externalTemporaryDirectory(path.join(directory,'installed'))).toBe(path.join(directory,'videoCutTool_tmp'));
  });
  it('跨登记根统计软目标，避免每个根各保留一套大副本', async () => {
    const old=await cache(4);manager.release(old);await manager.sweep();clock+=200;
    const other=path.join(directory,'other/playback_cache/managed');await manager.registerRoot(other);const recent=await manager.create(other,'playback','.mp4','other');await fs.promises.writeFile(recent,Buffer.alloc(6));await manager.ready(recent);manager.release(recent);await manager.sweep();clock+=200;await manager.sweep();expect(fs.existsSync(old)).toBe(false);expect(fs.existsSync(recent)).toBe(true);
  });
  it('单份远超软目标仍能发布，持有引用时不删除，释放并过宽限期才回收', async () => {
    const file = await cache(200); await manager.sweep(); expect(fs.existsSync(file)).toBe(true);
    manager.release(file); clock += 50; await manager.sweep(); expect(fs.existsSync(file)).toBe(true);
    clock += 101; await manager.sweep(); expect(fs.existsSync(file)).toBe(false);
  });
  it('展示与媒体读取分别保护，同一文件的最后一个引用释放后才回收', async () => {
    const file = await cache(200), streamRelease = await manager.pin(file);
    manager.release(file); clock += 200; await manager.sweep(); expect(fs.existsSync(file)).toBe(true);
    streamRelease(); streamRelease(); await manager.sweep(); clock += 200; await manager.sweep(); expect(fs.existsSync(file)).toBe(false);
  });
  it('按最近使用时间淘汰，保留足够新的空闲副本', async () => {
    const old = await cache(4); manager.release(old); await manager.sweep(); clock += 200;
    const recent = await cache(6); manager.release(recent); await manager.sweep(); clock += 200;
    await manager.sweep(); expect(fs.existsSync(old)).toBe(false); expect(fs.existsSync(recent)).toBe(true);
  });
  it('即使没有新预览，独立维护也会回收超时缓存', async () => {
    const file = await cache(1); manager.release(file); await manager.sweep(); clock += 1001;
    await manager.sweep(); expect(fs.existsSync(file)).toBe(false);
  });
  it('配置、方案、恢复标记、验收记录和未知文件不因处在缓存根而被删除', async () => {
    const protectedFiles = ['config.json','workspace.json','plans/a.json','plans/a.deleted.json','walkthrough.md','result.json','evidence/shot.png','unknown.mp4'];
    for (const name of protectedFiles) { const file=path.join(root,name); await fs.promises.mkdir(path.dirname(file),{recursive:true});await fs.promises.writeFile(file,`保护 ${name}`); }
    const generated = await cache(200); manager.release(generated); await manager.sweep(); clock += 2000; await manager.sweep();
    expect(fs.existsSync(generated)).toBe(false);
    for (const name of protectedFiles) expect(await fs.promises.readFile(path.join(root,name),'utf8')).toBe(`保护 ${name}`);
  });
  it('工作数据与专用缓存冲突时保留登记资产', async () => {
    manager.protect(root); const file=await cache(200);manager.release(file);await manager.sweep();clock+=2000;await manager.sweep();expect(fs.existsSync(file)).toBe(true);
  });
  it('任务目录含新增配置或未知文件时整个跳过', async () => {
    const task=await manager.create(root,'task',''); const output=path.join(task,'out.mp4');await manager.allowTaskFile(task,output);await fs.promises.writeFile(output,'中间产物');await fs.promises.writeFile(path.join(task,'config.json'),'用户配置');
    await manager.abandon(task);manager.release(task);await manager.sweep();expect(fs.existsSync(output)).toBe(true);expect(await fs.promises.readFile(path.join(task,'config.json'),'utf8')).toBe('用户配置');
  });
  it('只回收登记过的已结束任务；字典原型名称不视为登记文件', async () => {
    const task=await manager.create(root,'task','');await fs.promises.writeFile(path.join(task,'constructor'),'未知');await manager.abandon(task);manager.release(task);await manager.sweep();expect(fs.existsSync(path.join(task,'constructor'))).toBe(true);
    const clean=await manager.create(root,'task','');const output=path.join(clean,'out.mp4');await manager.allowTaskFile(clean,output);await fs.promises.writeFile(output,'部分产物');await manager.abandon(clean);manager.release(clean);await manager.sweep();expect(fs.existsSync(clean)).toBe(false);
  });
  it('删除失败可追溯并退避重试，不把失败当成已回收', async () => {
    const file=await cache(200);manager.release(file);await manager.sweep();clock+=200;
    const unlink=fs.promises.unlink.bind(fs.promises);const spy=vi.spyOn(fs.promises,'unlink').mockImplementation(async target=>{if(String(target)===file)throw Object.assign(new Error('占用'),{code:'EBUSY'});return unlink(target);});
    await manager.sweep();expect(fs.existsSync(file)).toBe(true);expect(manager.issues.some(item=>item.path===file)).toBe(true);spy.mockRestore();
    await manager.sweep();expect(fs.existsSync(file)).toBe(true);clock+=61000;await manager.sweep();expect(fs.existsSync(file)).toBe(false);
  });
  it('文件身份变化后不认领替代内容', async () => {
    const file=await cache(200);manager.release(file);await manager.sweep();await fs.promises.writeFile(file,'后来放入的用户内容');clock+=200;await manager.sweep();expect(await fs.promises.readFile(file,'utf8')).toBe('后来放入的用户内容');
  });
  it('跨进程根锁保护：其他实例不能同时认领同一个根', async () => {
    const other=make(path.join(directory,'other-registry'));await expect(other.registerRoot(root)).rejects.toThrow('其他进程');
  });
  it('退出时仍有读取引用则保留根锁，避免新实例删除仍在读取的缓存', async () => {
    const file=await cache(200);await manager.close();const other=make(path.join(directory,'next-registry'));await expect(other.registerRoot(root)).rejects.toThrow('其他进程');expect(fs.existsSync(file)).toBe(true);manager.release(file);await manager.close();
  });
  it('根目录联接点及链接目标都不会进入回收', async () => {
    const outside=path.join(directory,'outside');await fs.promises.mkdir(outside);await fs.promises.writeFile(path.join(outside,'config.json'),'保护');
    const link=path.join(directory,'linked');await fs.promises.symlink(outside,link,process.platform==='win32'?'junction':'dir');
    await expect(manager.registerRoot(path.join(link,'managed'))).rejects.toThrow('链接');expect(await fs.promises.readFile(path.join(outside,'config.json'),'utf8')).toBe('保护');
  });
  it('正常重启后能发现登记资产，未知旧缓存不自动认领', async () => {
    const file=await cache(200);manager.release(file);await manager.sweep();await fs.promises.writeFile(path.join(root,'cache_old.mp4'),'未知');await manager.close();
    clock+=2000;manager=make();await manager.discover();await manager.sweep();expect(fs.existsSync(file)).toBe(false);expect(fs.existsSync(path.join(root,'cache_old.mp4'))).toBe(true);
  });
  it('重启后完整索引不因闲置或软目标被删除，验收附件保留', async () => {
    const indexes=path.join(directory,'stream_indexes','managed');await manager.registerRoot(indexes);
    const file=await manager.create(indexes,'index','.json','stream-test');await fs.promises.writeFile(file,'索引');await manager.ready(file);
    const attachment=path.join(indexes,'evidence','capture.json');await fs.promises.mkdir(path.dirname(attachment));await fs.promises.writeFile(attachment,'验收附件');
    manager.release(file);await manager.sweep();await manager.close();clock+=2000;
    manager=make();await manager.discover();await manager.sweep();
    expect(fs.existsSync(file)).toBe(true);expect(await fs.promises.readFile(attachment,'utf8')).toBe('验收附件');
    expect(manager.issues).toEqual([]);
  });
  it('登记损坏或路径逃逸不删除任何外部数据', async () => {
    const file=await cache(200);manager.release(file);await manager.sweep();const entry=(await fs.promises.readdir(root)).find(name=>name.startsWith('.vct-entry-'))!;
    const record=JSON.parse(await fs.promises.readFile(path.join(root,entry),'utf8'));record.name='../config.json';await fs.promises.writeFile(path.join(root,entry),JSON.stringify(record));await manager.close();
    const outside=path.join(path.dirname(root),'config.json');await fs.promises.writeFile(outside,'外部配置');manager=make();await manager.discover();clock+=2000;await manager.sweep();expect(await fs.promises.readFile(outside,'utf8')).toBe('外部配置');expect(fs.existsSync(file)).toBe(true);
  });
  it('已就绪登记缺少文件身份时不能自动认领或删除', async () => {
    const file=await cache(200);manager.release(file);await manager.sweep();const name=(await fs.promises.readdir(root)).find(item=>item.startsWith('.vct-entry-'))!;const record=JSON.parse(await fs.promises.readFile(path.join(root,name),'utf8'));record.files={};await fs.promises.writeFile(path.join(root,name),JSON.stringify(record));await manager.close();manager=make();await manager.discover();clock+=2000;await manager.sweep();expect(fs.existsSync(file)).toBe(true);
  });
  it('旧命中失效后可以复用新生成的有效资产，不反复生成', async () => {
    const preview=new PreviewCache(path.dirname(root),'playback',manager),first=await preview.acquire('replace','.mp4');await fs.promises.writeFile(first.file,'原缓存');await manager.ready(first.file);first.release();await manager.sweep();await fs.promises.writeFile(first.file,'用户替换内容');
    const second=await preview.acquire('replace','.mp4');expect(second.fresh).toBe(true);await fs.promises.writeFile(second.file,'新缓存');await manager.ready(second.file);const hit=await preview.acquire('replace','.mp4');expect(hit.fresh).toBe(false);expect(hit.file).toBe(second.file);hit.release();second.release();
  });
  it('PreviewCache 的新建与命中均通过引用保护，失败只回收本次新产物', async () => {
    const preview=new PreviewCache(path.dirname(root),'playback',manager);const first=await preview.acquire('same','.mp4');await fs.promises.writeFile(first.file,'成品');await manager.ready(first.file);
    const hit=await preview.acquire('same','.mp4');expect(hit.fresh).toBe(false);expect(hit.file).toBe(first.file);await preview.fail(hit);clock+=2000;await manager.sweep();expect(fs.existsSync(first.file)).toBe(true);
    first.release();await manager.sweep();clock+=2000;await manager.sweep();expect(fs.existsSync(first.file)).toBe(false);
  });
  it('登记期间取消不会给大缓存留下永久待启动状态，重启后仍能回收', async () => {
    const file=await cache(200),controller=new AbortController();
    const request=runMediaTool(process.execPath,['-e','process.exit(0)',file],{signal:controller.signal});controller.abort();
    await expect(request).rejects.toMatchObject({name:'AbortError'});
    manager.release(file);await manager.sweep();await manager.close();
    manager=make();await manager.discover();clock+=2000;await manager.sweep();expect(fs.existsSync(file)).toBe(false);
  });
  it('调用前已取消不登记进程，启动同步失败也能回收本次任务', async () => {
    const task=await manager.create(root,'task',''),output=path.join(task,'preview.mp4'),controller=new AbortController();controller.abort();
    await expect(manager.task(task,()=>runMediaTool(process.execPath,[output],{signal:controller.signal}))).rejects.toMatchObject({name:'AbortError'});
    await expect(manager.task(task,()=>runMediaTool('invalid\0executable',[output]))).rejects.toThrow();
    await manager.abandon(task);manager.release(task);await manager.sweep();expect(fs.existsSync(task)).toBe(false);
  });
  it('并发启动各自撤销，重复撤销不会清掉另一个未完成登记', async () => {
    const file=await cache(200),first=await registerMediaSpawn([file]),second=await registerMediaSpawn([file]);
    await first.cancel();await first.cancel();manager.release(file);await manager.sweep();clock+=2000;await manager.sweep();expect(fs.existsSync(file)).toBe(true);
    await second.cancel();await manager.sweep();expect(fs.existsSync(file)).toBe(false);
  });
  it('多个资产登记中途失败时撤销先前已成功的登记', async () => {
    const first=await cache(200),second=await cache(200),track=manager.trackSpawn.bind(manager);let calls=0;
    const spy=vi.spyOn(manager,'trackSpawn').mockImplementation(async (...args)=>{if(++calls===2)throw new Error('登记失败');return track(...args);});
    await expect(registerMediaSpawn([first,second])).rejects.toThrow('登记失败');spy.mockRestore();
    manager.release(first);manager.release(second);await manager.sweep();clock+=2000;await manager.sweep();expect(fs.existsSync(first)).toBe(false);expect(fs.existsSync(second)).toBe(false);
  });
  it('实际子进程运行期间保护缓存，取消并关闭后才允许回收', async () => {
    const file=await cache(200),controller=new AbortController();let started!:()=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    const request=runMediaTool(process.execPath,['-e',"console.log('ready');setInterval(()=>{},1000)",file],{signal:controller.signal,onOutput:()=>started()});
    const rejected=expect(request).rejects.toMatchObject({name:'AbortError'});
    try { await ready;manager.release(file);await manager.sweep();clock+=2000;await manager.sweep();expect(fs.existsSync(file)).toBe(true); }
    finally { controller.abort();await rejected; }
    await manager.sweep();expect(fs.existsSync(file)).toBe(false);
  });
});
