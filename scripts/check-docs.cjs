// 手动检查文档的本地链接；不联网、不修改文件、不接入 CI。
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const projectRoot = path.resolve(__dirname, '..');

function withoutFences(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker && !fence) { fence = marker[1]; return ''; }
    if (marker && fence && marker[1][0] === fence[0] && marker[1].length >= fence.length) {
      fence = null; return '';
    }
    return fence ? '' : line;
  }).join('\n');
}

function anchors(text, extension) {
  const found = new Set();
  const visible = withoutFences(text);
  for (const match of visible.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) found.add(match[1]);
  if (extension !== '.md') return found;
  const used = new Set(found);
  for (const match of visible.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1].replace(/<[^>]*>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    let slug = base;
    for (let suffix = 1; used.has(slug); suffix++) slug = `${base}-${suffix}`;
    used.add(slug); found.add(slug);
  }
  return found;
}

function localLinks(text) {
  const source = withoutFences(text).replace(/(`+)[^`\n]*?\1/g, '');
  const links = [];
  const add = (target, offset) => links.push({ target, line: source.slice(0, offset).split('\n').length });
  // 目标每次消费单个字符或一组括号；避免嵌套重复量词在未闭合链接上大量回溯。
  // 支持普通链接、图片、带空格的尖括号目标，以及一层路径括号。
  const inline = /!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|((?:[^()\s]|\([^()\n]*\))*))(?:\s+["'][^"'\n]*["'])?\s*\)/g;
  for (const match of source.matchAll(inline)) add(match[1] ?? match[2], match.index);
  // 引用式目标直接检查定义，包含尚未使用的定义。
  const reference = /^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>]+)>|(\S+))/gm;
  for (const match of source.matchAll(reference)) add(match[1] ?? match[2], match.index);
  return links;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function markdownFiles(directory, recursive = true) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return recursive ? markdownFiles(target) : [];
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [target] : [];
  });
}

function checkFiles(root, files) {
  const issues = [];
  const cache = new Map();
  let count = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const link of localLinks(text)) {
      if (/^(?:https?:|mailto:|data:|app:|plugin:|codex:|javascript:)/i.test(link.target)) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(link.target) && !/^file:/i.test(link.target) && !/^[a-z]:[\\/]/i.test(link.target)) continue;
      count++;
      let target;
      let fragment;
      try {
        const hash = link.target.indexOf('#');
        const rawPath = (hash < 0 ? link.target : link.target.slice(0, hash)).split('?')[0];
        fragment = hash < 0 ? '' : decodeURIComponent(link.target.slice(hash + 1));
        target = /^file:/i.test(rawPath) ? fileURLToPath(rawPath)
          : rawPath ? path.resolve(path.dirname(file), decodeURIComponent(rawPath)) : file;
      } catch (error) {
        issues.push({ level: '错误', file, ...link, reason: `路径无法解析：${error.message}` });
        continue;
      }
      const level = isInside(root, target) ? '错误' : '警告';
      if (!fs.existsSync(target)) {
        issues.push({ level, file, ...link, reason: '目标不存在' });
        continue;
      }
      const ext = path.extname(target).toLowerCase();
      if (fragment && ['.md', '.html', '.htm'].includes(ext) && fs.statSync(target).isFile()) {
        if (!cache.has(target)) cache.set(target, anchors(fs.readFileSync(target, 'utf8'), ext));
        if (!cache.get(target).has(fragment)) issues.push({ level, file, ...link, reason: `锚点不存在：${fragment}` });
      }
    }
  }
  return { files: files.length, links: count, issues };
}

if (require.main === module) {
  const files = process.argv.length > 2 ? process.argv.slice(2).map(p => path.resolve(p)) : [
    ...markdownFiles(projectRoot, false),
    ...markdownFiles(path.join(projectRoot, 'docs')),
    ...markdownFiles(path.join(projectRoot, 'archive', 'docs')),
  ];
  const result = checkFiles(projectRoot, files);
  for (const issue of result.issues) {
    console.log(`${issue.level} ${path.relative(projectRoot, issue.file)}:${issue.line} ${issue.target} — ${issue.reason}`);
  }
  const errors = result.issues.filter(issue => issue.level === '错误').length;
  console.log(`文档 ${result.files}，本地链接 ${result.links}，错误 ${errors}，警告 ${result.issues.length - errors}。`);
  process.exitCode = errors ? 1 : 0;
}

module.exports = { anchors, localLinks, checkFiles };
