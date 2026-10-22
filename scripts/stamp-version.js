#!/usr/bin/env node
'use strict';

// 版本号单一来源：desktop/package.json 的 version。
// 本脚本把它同步写入所有需要版本号的地方，避免出现"扩展 0.5.0 / 应用 0.6.0"这种错位：
//   1. server/server.js       的 const VERSION
//   2. server/package.json    的 version
//   3. extension/manifest.json 的 version
// 用法：node scripts/stamp-version.js [--check]
//   --check 只校验不写入（不一致时退出码 1，可用于 CI / 构建前自检）

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'desktop', 'package.json');
const SERVER_JS = path.join(ROOT, 'server', 'server.js');
const SERVER_PKG = path.join(ROOT, 'server', 'package.json');
const MANIFEST = path.join(ROOT, 'extension', 'manifest.json');

const checkOnly = process.argv.includes('--check');

function readJson(f) {
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function writeJson(f, obj) {
  fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n');
}

const version = readJson(PKG).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('[stamp-version] desktop/package.json version 不合法:', version);
  process.exit(1);
}

const problems = [];

// 1) server/server.js 的 VERSION 常量
let serverSrc = fs.readFileSync(SERVER_JS, 'utf8');
const m = serverSrc.match(/const VERSION = '([^']*)';/);
if (!m) {
  problems.push('server/server.js 里找不到 const VERSION = \'x.y.z\';');
} else if (m[1] !== version) {
  problems.push('server/server.js VERSION=' + m[1] + ' → ' + version);
  if (!checkOnly) {
    serverSrc = serverSrc.replace(/const VERSION = '[^']*';/, "const VERSION = '" + version + "';");
    fs.writeFileSync(SERVER_JS, serverSrc);
  }
}

// 2) server/package.json
const sp = readJson(SERVER_PKG);
if (sp.version !== version) {
  problems.push('server/package.json version=' + sp.version + ' → ' + version);
  if (!checkOnly) { sp.version = version; writeJson(SERVER_PKG, sp); }
}

// 3) extension/manifest.json
const mf = readJson(MANIFEST);
if (mf.version !== version) {
  problems.push('extension/manifest.json version=' + mf.version + ' → ' + version);
  if (!checkOnly) { mf.version = version; writeJson(MANIFEST, mf); }
}

if (problems.length === 0) {
  console.log('[stamp-version] 全部一致：v' + version);
  process.exit(0);
}

if (checkOnly) {
  console.error('[stamp-version] 版本不一致：\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
console.log('[stamp-version] 已同步到 v' + version + '：\n  - ' + problems.join('\n  - '));
