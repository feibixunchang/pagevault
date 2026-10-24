#!/usr/bin/env node
'use strict';

// 修历史收藏的标题。
//
// 背景：1.5.3 及更早，服务端只从 <title> 取标题。微信文章的 <title></title> 是**空的**
// （标题靠页面脚本往 h1 里填），于是抓下来标题为空、退回显示网址，列表里就是一长串
// https://mp.weixin.qq.com/s/xxxx。1.5.4 起改成 og:title → <title> → h1 多源提取。
// 这个脚本负责把**已经存进库的**这类条目也补上标题，不用手动一条条改。
//
//   node scripts/fix-titles.js <数据目录>            # 只报告，不动文件（默认）
//   node scripts/fix-titles.js <数据目录> --write    # 真改（先把 index.json 备份一份）
//
// 数据目录里应该有 index.json 和一堆 <id>.html。

const fs = require('fs');
const path = require('path');

// titles.js 在两个位置跑得到：仓库里是 server/titles.js，
// 容器里（镜像把 server/*.js 平铺到 /app）是 ./titles.js。两边都认。
const titles = (function () {
  for (const p of ['../server/titles.js', '../titles.js']) {
    try { return require(p); } catch { /* 试下一个 */ }
  }
  console.error('找不到 titles.js（应该在 server/titles.js）');
  process.exit(1);
})();
const { pageTitle, usableTitle } = titles;

const args = process.argv.slice(2);
const write = args.includes('--write');
const dirArg = args.find(a => !a.startsWith('--'));

const DATA_DIR = path.resolve(dirArg || process.env.PAGEVAULT_DATA || path.join(__dirname, '..', 'data'));
const INDEX = path.join(DATA_DIR, 'index.json');
// 页面正文放在 <数据目录>/pages/ 下（和 server.js 的 DATA_DIR 一致）。
// 老版本有直接放根目录的，这里两个位置都试。
const PAGES_DIR = path.join(DATA_DIR, 'pages');

function pageFile(meta) {
  const name = meta.file || (meta.id + '.html');
  const inPages = path.join(PAGES_DIR, name);
  if (fs.existsSync(inPages)) return inPages;
  const flat = path.join(DATA_DIR, name);
  if (fs.existsSync(flat)) return flat;
  return inPages;
}

if (!fs.existsSync(INDEX)) {
  console.error('找不到索引文件：' + INDEX);
  console.error('用法：node scripts/fix-titles.js <数据目录> [--write]');
  process.exit(1);
}

let list;
try {
  list = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
} catch (e) {
  console.error('index.json 解析失败：' + (e && e.message || e));
  process.exit(1);
}
if (!Array.isArray(list)) {
  console.error('index.json 不是数组，可能不是 PageVault 的数据目录');
  process.exit(1);
}

console.log('数据目录：' + DATA_DIR);
console.log('共 ' + list.length + ' 条' + (write ? '' : '（预览模式，不改文件；加 --write 才写入）'));
console.log('');

const fixed = [];
const remainBad = [];
let noFile = 0;
let okCount = 0;

for (const meta of list) {
  const cur = String(meta.title || '').trim();
  // 标题本身没问题就跳过（usableTitle 会挡掉空串、Untitled、纯网址、纯域名、拦截页文案）
  if (usableTitle(cur, meta.url) && cur !== 'Untitled') { okCount++; continue; }

  const file = pageFile(meta);
  let html;
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch {
    noFile++;
    remainBad.push({ meta, reason: '存档文件不见了' });
    continue;
  }

  const mined = pageTitle(html, meta.url);
  if (usableTitle(mined, meta.url)) {
    fixed.push({ meta, from: cur, to: mined });
    meta.title = mined.slice(0, 300);
  } else {
    remainBad.push({ meta, reason: '页面里也确实找不到标题' });
  }
}

if (fixed.length) {
  console.log('可修好的：' + fixed.length + ' 条');
  for (const f of fixed) {
    console.log('  · ' + (f.meta.url || f.meta.id));
    console.log('      原：' + (f.from || '(空)').slice(0, 90));
    console.log('      新：' + f.to.slice(0, 90));
  }
  console.log('');
}

if (remainBad.length) {
  console.log('修不了的：' + remainBad.length + ' 条');
  for (const r of remainBad) {
    console.log('  · ' + (r.meta.url || r.meta.id) + ' — ' + r.reason);
  }
  console.log('');
}

console.log('汇总：正常 ' + okCount + ' 条，可修复 ' + fixed.length + ' 条，修不了 ' + remainBad.length +
  ' 条' + (noFile ? '（其中 ' + noFile + ' 条存档丢失）' : ''));

if (!fixed.length) {
  console.log('\n没有需要修的条目。');
  process.exit(0);
}

if (!write) {
  console.log('\n预览结束，什么都没改。确认无误后加 --write 执行。');
  process.exit(0);
}

// 备份：宁可留一份旧的，也别把索引写坏
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = INDEX + '.bak-' + stamp;
fs.copyFileSync(INDEX, backup);
const tmp = INDEX + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
fs.renameSync(tmp, INDEX);
console.log('\n已写入 ' + fixed.length + ' 条标题。');
console.log('改动前的索引备份在：' + backup);
