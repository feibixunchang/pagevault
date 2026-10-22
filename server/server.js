'use strict';

// PageVault sync server — Node zero-dependency.
// Stores full captured pages as self-contained HTML files + a metadata index.
// This same server becomes the Docker "end" later; the data format stays identical.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SyncEngine, extractMeta, ONLINE_WINDOW_MS } = require('./sync');
const { zipStore, zipRead } = require('./zip');

const VERSION = '0.6.1';
const PORT = process.env.PORT || 8731;
const ROOT = __dirname;
const DATA_ROOT = process.env.PAGEVAULT_DATA || path.join(ROOT, 'data');
const DATA_DIR = path.join(DATA_ROOT, 'pages');
const INDEX_FILE = path.join(DATA_ROOT, 'index.json');
const PREFS_FILE = path.join(DATA_ROOT, 'prefs.json');
const DELETIONS_FILE = path.join(DATA_ROOT, 'deletions.json');
const EXT_STATE_FILE = path.join(DATA_ROOT, 'extension-state.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 80 * 1024 * 1024; // 80MB cap per page

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(INDEX_FILE)) fs.writeFileSync(INDEX_FILE, '[]');

function log() {
  const line = new Date().toISOString() + ' ' + Array.from(arguments).join(' ') + '\n';
  try { fs.appendFileSync(path.join(DATA_ROOT, 'server.log'), line); } catch { /* 忽略 */ }
  console.log.apply(console, arguments);
}

// ---------- 公网 DNS 健康探测 ----------
// 只在同步报"域名解析失败"时才调用：用来区分"只有这个域名解析不了"和"本机 DNS 整体瘫痪"。
// 结果缓存 20 秒，避免状态栏 5 秒轮询把探测打爆。
let dnsProbeCache = { at: 0, ok: null };
function dnsProbe() {
  const now = Date.now();
  if (dnsProbeCache.ok !== null && now - dnsProbeCache.at < 20000) return Promise.resolve(dnsProbeCache.ok);
  const dns = require('dns');
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      dnsProbeCache = { at: Date.now(), ok };
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 4000);
    try {
      dns.lookup('www.baidu.com', (err) => { clearTimeout(timer); finish(!err); });
    } catch { clearTimeout(timer); finish(false); }
  });
}

// ---------- 扩展心跳状态（阅读器状态栏显示"扩展已连接"） ----------
let extState = { lastSeen: 0, version: '' };
try { extState = Object.assign(extState, JSON.parse(fs.readFileSync(EXT_STATE_FILE, 'utf8'))); } catch { /* 无文件用默认 */ }
function touchExtension(version) {
  extState.lastSeen = Date.now();
  if (version) extState.version = version;
  try { fs.writeFileSync(EXT_STATE_FILE, JSON.stringify(extState)); } catch { /* 只读环境忽略 */ }
}
function extensionOnline() {
  return extState.lastSeen > 0 && (Date.now() - extState.lastSeen) < ONLINE_WINDOW_MS;
}

// ---------- 浏览器扩展目录（随安装包分发；菜单"安装浏览器扩展…"定位到这里） ----------
function extensionDir() {
  // Mac 包：Contents/Resources/server → ../extension
  // Windows 包：resources/server → ../../extension（zip 根目录）
  // 开发仓库：server/ → ../extension
  const candidates = [
    path.join(ROOT, '..', 'extension'),
    path.join(ROOT, '..', '..', 'extension'),
    path.join(ROOT, 'extension')
  ];
  for (const d of candidates) {
    try { if (fs.existsSync(path.join(d, 'manifest.json'))) return d; } catch { /* 继续试下一个 */ }
  }
  return null;
}

// ---------- 删除记录（tombstone） ----------
function loadDeletions() {
  try { const a = JSON.parse(fs.readFileSync(DELETIONS_FILE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function saveDeletions(list) {
  try { fs.writeFileSync(DELETIONS_FILE, JSON.stringify(list, null, 2)); } catch { /* 只读环境忽略 */ }
}
function addDeletion(id) {
  const list = loadDeletions().filter(d => d.id !== id);
  list.push({ id, deletedAt: new Date().toISOString() });
  if (list.length > 2000) list.splice(0, list.length - 2000); // 防止无限增长
  saveDeletions(list);
}

// ---------- 同步引擎（WebDAV 账号 = 多端同步的"同一账号"） ----------
function loadPrefsRaw() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; }
}
const sync = new SyncEngine({
  loadIndex,
  saveIndex,
  loadDeletions,
  saveDeletions,
  readPage: (id) => { try { return fs.readFileSync(path.join(DATA_DIR, id + '.html'), 'utf8'); } catch { return null; } },
  writePage: (id, html) => fs.writeFileSync(path.join(DATA_DIR, id + '.html'), html, 'utf8'),
  deletePageFile: (id) => { try { fs.unlinkSync(path.join(DATA_DIR, id + '.html')); } catch { /* 已不存在 */ } },
  // 远端索引条目 + 页面文件 -> 规范化的本地 meta（优先用文件头 pv-meta 注释补全）
  normalizeMeta: (rm, html) => {
    const embedded = extractMeta(html) || {};
    const meta = Object.assign({}, rm, embedded);
    meta.id = rm.id || embedded.id;
    meta.title = String(rm.title || embedded.title || 'Untitled').slice(0, 300);
    meta.url = String(rm.url || embedded.url || '').slice(0, 2000);
    meta.savedAt = rm.savedAt || embedded.savedAt || new Date().toISOString();
    meta.platform = String(rm.platform || embedded.platform || 'unknown').slice(0, 60);
    meta.format = String(rm.format || embedded.format || 'html').slice(0, 20);
    meta.file = meta.id + '.html';
    try { meta.size = Buffer.byteLength(html); } catch { /* 忽略 */ }
    return meta;
  },
  log,
  onSynced: () => broadcastMeta({ type: 'synced', at: Date.now() })
});
function syncConfig() {
  const p = loadPrefsRaw();
  const s = p.sync || {};
  return { url: s.url || '', user: s.user || '', pass: s.pass || '', dir: s.dir || 'pagevault', intervalSec: s.intervalSec || 0 };
}
function restartSyncTimer() {
  const cfg = syncConfig();
  sync.stop();
  if (cfg.url && cfg.user && cfg.intervalSec > 0) sync.start(cfg);
}

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch { return []; }
}
function saveIndex(list) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2));
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS,DELETE,PATCH',
    'Access-Control-Allow-Headers': 'Content-Type'
  }, headers || {}));
  res.end(body);
}

function readBody(req, capBytes, cb) {
  let size = 0; const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > capBytes) { req.destroy(); cb(new Error('PAYLOAD_TOO_LARGE')); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', e => cb(e));
}

function sendFile(res, filepath, type) {
  fs.readFile(filepath, (err, data) => {
    if (err) { send(res, 404, 'not found'); return; }
    send(res, 200, data, { 'Content-Type': type });
  });
}

// ---- SSE: 保存事件实时推送（阅读器监听它自动刷新列表）----
const sseClients = new Set();
setInterval(() => { // 心跳，防止连接被闲置断开
  for (const c of sseClients) { try { c.res.write(': ping\n\n'); } catch { sseClients.delete(c); } }
}, 25000);

function broadcastSaved(meta) {
  const payload = `data: ${JSON.stringify({ type: 'saved', id: meta.id, title: meta.title })}\n\n`;
  for (const c of sseClients) { try { c.res.write(payload); } catch { sseClients.delete(c); } }
}

function broadcastDeleted(id) {
  const payload = `data: ${JSON.stringify({ type: 'deleted', id })}\n\n`;
  for (const c of sseClients) { try { c.res.write(payload); } catch { sseClients.delete(c); } }
}

// 外观/语言等偏好变化 → 广播给其他端实时应用（阅读器收到后本地 apply，不重载页面）
function broadcastPrefs(prefs) {
  const payload = `data: ${JSON.stringify({ type: 'prefs', prefs })}\n\n`;
  for (const c of sseClients) { try { c.res.write(payload); } catch { sseClients.delete(c); } }
}

function broadcastMeta(evt) {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const c of sseClients) { try { c.res.write(payload); } catch { sseClients.delete(c); } }
}

// ---- 远程图片代理：兜底渲染残留的远程图片（旧存档/防盗链图）----
const imgCache = new Map();
async function fetchImage(targetUrl, referer) {
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) return null;
  const key = targetUrl + '|' + (referer || '');
  const hit = imgCache.get(key);
  if (hit) return hit;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' };
    try { if (referer) headers['Referer'] = new URL(referer).origin + '/'; } catch { /* referer 非法就忽略 */ }
    const r = await fetch(targetUrl, { headers, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return null;
    const type = r.headers.get('content-type') || 'application/octet-stream';
    if (!/^image\//i.test(type)) return null;
    const entry = { buf, type };
    if (imgCache.size > 400) imgCache.clear();
    imgCache.set(key, entry);
    return entry;
  } catch { return null; } finally { clearTimeout(timer); }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') { send(res, 204, ''); return; }

  // Reader UI
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  // Reader-mode library (vendored Mozilla Readability)
  if (req.method === 'GET' && p === '/readability.js') {
    sendFile(res, path.join(PUBLIC_DIR, 'readability.js'), 'text/javascript; charset=utf-8');
    return;
  }

  // List pages (newest first), metadata only
  if (req.method === 'GET' && p === '/api/pages') {
    const list = loadIndex()
      .map(({ file, ...m }) => m)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    send(res, 200, JSON.stringify(list), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  // 远程图片代理（带来源页 referer 过防盗链，内存缓存）
  if (req.method === 'GET' && p === '/api/img') {
    const target = url.searchParams.get('u');
    const ref = url.searchParams.get('r') || '';
    fetchImage(target, ref).then(entry => {
      if (!entry) { send(res, 404, 'img fetch failed'); return; }
      send(res, 200, entry.buf, { 'Content-Type': entry.type, 'Cache-Control': 'max-age=86400' });
    });
    return;
  }

  // SSE 事件流
  if (req.method === 'GET' && p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    const client = { res };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }

  // 偏好设置（主题/语言，阅读器与桌面端主进程共用）
  if (req.method === 'GET' && p === '/api/prefs') {
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { /* 无文件用默认 */ }
    send(res, 200, JSON.stringify(prefs), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }
  if (req.method === 'PUT' && p === '/api/prefs') {
    readBody(req, 1024 * 1024, (err, buf) => {
      if (err) { send(res, 413, JSON.stringify({ error: 'too large' }), { 'Content-Type': 'application/json' }); return; }
      let prefs;
      try { prefs = JSON.parse(buf.toString('utf8')); } catch { send(res, 400, JSON.stringify({ error: 'invalid json' }), { 'Content-Type': 'application/json' }); return; }
      const clean = {};
      if (['system', 'light', 'dark'].includes(prefs.theme)) clean.theme = prefs.theme;
      if (['system', 'zh', 'en'].includes(prefs.lang)) clean.lang = prefs.lang;
      if (['system', 'songti', 'kaiti', 'heiti', 'yuanti', 'yahei', 'pingfang', 'mono'].includes(prefs.font)) clean.font = prefs.font;
      if (['s', 'm', 'l', 'xl'].includes(prefs.fontSize)) clean.fontSize = prefs.fontSize;
      if (typeof prefs.autoUpdate === 'boolean') clean.autoUpdate = prefs.autoUpdate;
      if (prefs.sync && typeof prefs.sync === 'object') {
        // 同步配置（WebDAV 账号 = 多端同步的同一账号）
        const s = prefs.sync;
        clean.sync = {
          url: String(s.url || '').slice(0, 500),
          user: String(s.user || '').slice(0, 200),
          pass: String(s.pass || '').slice(0, 500),
          dir: String(s.dir || 'pagevault').slice(0, 100).replace(/[\\/:*?"<>|]+/g, ''),
          intervalSec: [0, 10, 30, 60].includes(s.intervalSec) ? s.intervalSec : 0
        };
      }
      try { fs.writeFileSync(PREFS_FILE, JSON.stringify(clean, null, 2)); } catch { /* 只读环境忽略 */ }
      send(res, 200, JSON.stringify(clean), { 'Content-Type': 'application/json; charset=utf-8' });
      restartSyncTimer();
      // 广播给其他端：主题/语言/字体等外观设置实时互相同步（不重载页面，只应用）
      broadcastPrefs(clean);
    });
    return;
  }

  // 运行状态：阅读器状态栏用（本地服务 / 扩展连接 / 同步状态 / 计数）
  if (req.method === 'GET' && p === '/api/status') {
    const list = loadIndex();
    const s = sync.getStatus();
    const cfg = syncConfig();
    // 同步报"域名解析失败"时，顺手探一下公网 DNS：能区分"只是这个域名坏了"还是"本机 DNS 整体不可用"
    const needDnsProbe = /域名解析失败/.test(s.lastError || '');
    const respond = (dnsOk) => {
      let lastError = s.lastError;
      if (needDnsProbe && dnsOk === false) {
        lastError += '（本机 DNS 整体不可用：连 www.baidu.com 也解析不了，请检查网络后再试）';
      }
      send(res, 200, JSON.stringify({
        ok: true, version: VERSION, port: PORT,
        extension: { lastSeen: extState.lastSeen, version: extState.version, online: extensionOnline() },
        extensionPath: extensionDir(),
        sync: { configured: !!(cfg.url && cfg.user), status: s.status, lastSyncAt: s.lastSyncAt, lastError: lastError, lastStats: s.lastStats },
        counts: { total: list.length, starred: list.filter(m => m.starred).length }
      }), { 'Content-Type': 'application/json; charset=utf-8' });
    };
    if (needDnsProbe) dnsProbe().then(respond);
    else respond(null);
    return;
  }

  // 扩展心跳：保存整页即算一次活动；扩展用 alarms 每 30 秒保活，浏览器有活动时也会补发
  if ((req.method === 'POST' || req.method === 'GET') && p === '/api/ping') {
    readBody(req, 4096, (err, buf) => {
      let v = '';
      if (!err && buf && buf.length) {
        try { const j = JSON.parse(buf.toString('utf8')); if (j && typeof j.v === 'string') v = j.v.slice(0, 20); } catch { /* 老版本扩展无 body */ }
      }
      touchExtension(v);
      send(res, 200, JSON.stringify({ ok: true, lastSeen: extState.lastSeen, server: VERSION }), { 'Content-Type': 'application/json; charset=utf-8' });
    });
    return;
  }

  // ---------- WebDAV 同步 ----------
  if (req.method === 'POST' && p === '/api/sync/test') {
    readBody(req, 1024 * 1024, (err, buf) => {
      if (err) { send(res, 413, JSON.stringify({ ok: false, message: 'too large' }), { 'Content-Type': 'application/json' }); return; }
      let cfg;
      try { cfg = JSON.parse(buf.toString('utf8')); } catch { send(res, 400, JSON.stringify({ ok: false, message: 'invalid json' }), { 'Content-Type': 'application/json' }); return; }
      (async () => {
        try {
          const { WebDAV } = require('./webdav');
          const dav = new WebDAV(cfg.url.replace(/\/+$/, '') + '/' + String(cfg.dir || 'pagevault').replace(/^\/+|\/+$/g, ''));
          dav.auth(cfg.user, cfg.pass);
          const r = await dav.test();
          send(res, 200, JSON.stringify(r), { 'Content-Type': 'application/json; charset=utf-8' });
        } catch (e) {
          send(res, 200, JSON.stringify({ ok: false, message: e && e.message ? e.message : String(e) }), { 'Content-Type': 'application/json; charset=utf-8' });
        }
      })();
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/sync/run') {
    sync.run(syncConfig()).then(stats => {
      broadcastMeta({ type: 'synced', at: Date.now() });
      send(res, 200, JSON.stringify({ ok: sync.getStatus().status !== 'error', stats, status: sync.getStatus() }), { 'Content-Type': 'application/json; charset=utf-8' });
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/sync/status') {
    send(res, 200, JSON.stringify(sync.getStatus()), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  // 整库导出：store 模式 zip（index.json + pages/*.html），自包含、可再次导入
  if (req.method === 'GET' && p === '/api/export.zip') {
    const list = loadIndex();
    const files = [{ name: 'index.json', data: Buffer.from(JSON.stringify(list, null, 2), 'utf8') }];
    for (const meta of list) {
      let html;
      try { html = fs.readFileSync(path.join(DATA_DIR, meta.file || (meta.id + '.html')), 'utf8'); } catch { continue; }
      files.push({ name: 'pages/' + meta.id + '.html', data: Buffer.from(html, 'utf8') });
    }
    const zip = zipStore(files);
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    send(res, 200, zip, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('网页收藏备份-' + stamp + '.zip')}`
    });
    log('exported backup zip, pages =', files.length - 1);
    return;
  }

  // 整库导入：上传本工具导出的 zip，按 id 合并（不覆盖已有页面）
  if (req.method === 'POST' && p === '/api/import') {
    readBody(req, 500 * 1024 * 1024, (err, buf) => {
      if (err) { send(res, 413, JSON.stringify({ ok: false, message: '文件太大（上限 500MB）' }), { 'Content-Type': 'application/json' }); return; }
      let entries;
      try { entries = zipRead(buf); } catch (e) {
        send(res, 400, JSON.stringify({ ok: false, message: '无法解析 zip：' + (e && e.message ? e.message : e) }), { 'Content-Type': 'application/json' });
        return;
      }
      const list = loadIndex();
      const have = new Set(list.map(m => m.id));
      let imported = 0;
      const metasFromIndex = new Map();
      for (const en of entries) {
        if (en.name === 'index.json') {
          try {
            const arr = JSON.parse(en.data.toString('utf8'));
            for (const m of (Array.isArray(arr) ? arr : [])) if (m && m.id) metasFromIndex.set(m.id, m);
          } catch { /* 忽略，走文件头注释 */ }
        }
      }
      for (const en of entries) {
        const mm = /^pages\/([\w-]+)\.html$/.exec(en.name);
        if (!mm) continue;
        const id = mm[1];
        if (have.has(id)) continue;
        const html = en.data.toString('utf8');
        const meta = sync.hooks.normalizeMeta(metasFromIndex.get(id) || { id }, html);
        if (!meta.id) continue;
        fs.writeFileSync(path.join(DATA_DIR, id + '.html'), html, 'utf8');
        list.push(meta);
        have.add(id);
        imported++;
      }
      if (imported) { saveIndex(list); broadcastMeta({ type: 'imported', count: imported }); }
      log('imported backup, new pages =', imported);
      sync.schedule(syncConfig()); // 导入后推给其他端
      send(res, 200, JSON.stringify({ ok: true, imported }), { 'Content-Type': 'application/json; charset=utf-8' });
    });
    return;
  }

  // 扩展文件静态托管（随安装包分发；供查看 manifest / 高级用户取用）
  if (req.method === 'GET' && p.startsWith('/extension/')) {
    const dir = extensionDir();
    if (!dir) { send(res, 404, 'extension not bundled'); return; }
    const rel = decodeURIComponent(p.slice('/extension/'.length)).replace(/\\/g, '/').replace(/^\/+/, '');
    const filePath = path.normalize(path.join(dir, rel));
    if (rel && !filePath.startsWith(dir + path.sep)) { send(res, 403, 'forbidden'); return; }
    const type = /\.json$/.test(rel) ? 'application/json' : /\.js$/.test(rel) ? 'text/javascript'
      : /\.html?$/.test(rel) ? 'text/html' : /\.css$/.test(rel) ? 'text/css' : 'application/octet-stream';
    sendFile(res, filePath, type + '; charset=utf-8');
    return;
  }

  // Save a page
  if (req.method === 'POST' && p === '/api/pages') {
    readBody(req, MAX_BODY, (err, buf) => {
      if (err) { send(res, 413, JSON.stringify({ error: 'payload too large' }), { 'Content-Type': 'application/json' }); return; }
      let payload;
      try { payload = JSON.parse(buf.toString('utf8')); }
      catch { send(res, 400, JSON.stringify({ error: 'invalid json' }), { 'Content-Type': 'application/json' }); return; }

      const html = payload.html;
      if (!html || typeof html !== 'string') {
        send(res, 400, JSON.stringify({ error: 'missing html' }), { 'Content-Type': 'application/json' });
        return;
      }

      const id = crypto.randomUUID();
      const meta = {
        id,
        title: String(payload.title || 'Untitled').slice(0, 300),
        url: String(payload.url || '').slice(0, 2000),
        savedAt: new Date().toISOString(),
        platform: String(payload.platform || 'unknown').slice(0, 60),
        format: String(payload.format || 'html').slice(0, 20),
        size: Buffer.byteLength(html),
        file: id + '.html'
      };
      // 文件头注入元数据注释：WebDAV 同步时即使 index.json 丢了也能自愈重建
      const embedded = Object.assign({}, meta);
      delete embedded.file;
      const htmlWithMeta = '<!-- pv-meta:' + JSON.stringify(embedded) + ' -->\n' + html;
      fs.writeFileSync(path.join(DATA_DIR, meta.file), htmlWithMeta, 'utf8');
      const list = loadIndex();
      list.push(meta);
      saveIndex(list);
      touchExtension(); // 扩展刚保存过，状态栏立刻显示"已连接"
      send(res, 200, JSON.stringify({ id, savedAt: meta.savedAt }), { 'Content-Type': 'application/json; charset=utf-8' });
      broadcastSaved(meta);
      sync.schedule(syncConfig()); // 即时同步给其他端
    });
    return;
  }

  // Star / unstar a page
  const sm = p.match(/^\/api\/pages\/([\w-]+)\/star$/);
  if (req.method === 'PATCH' && sm) {
    const id = sm[1];
    const list = loadIndex();
    const meta = list.find(x => x.id === id);
    if (!meta) { send(res, 404, JSON.stringify({ error: 'not found' }), { 'Content-Type': 'application/json' }); return; }
    meta.starred = !meta.starred;
    meta.starredAt = new Date().toISOString(); // 多端同步时按时间戳解决收藏冲突
    saveIndex(list);
    broadcastMeta({ type: 'starred', id, starred: !!meta.starred });
    send(res, 200, JSON.stringify({ ok: true, starred: !!meta.starred }), { 'Content-Type': 'application/json; charset=utf-8' });
    sync.schedule(syncConfig());
    return;
  }

  // Export a page as a standalone .html download
  if (req.method === 'GET' && p.startsWith('/api/pages/') && p.endsWith('/export')) {
    const id = p.slice('/api/pages/'.length, p.length - '/export'.length);
    const meta = loadIndex().find(x => x.id === id);
    if (!meta) { send(res, 404, 'not found'); return; }
    const fname = (meta.title || 'page').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) + '.html';
    sendFile(res, path.join(DATA_DIR, meta.file), 'text/html; charset=utf-8',
      { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}` });
    return;
  }

  // Full-text search (title/url + page body text)
  if (req.method === 'GET' && p === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (!q) { send(res, 200, '[]', { 'Content-Type': 'application/json; charset=utf-8' }); return; }
    const list = loadIndex().sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    const results = [];
    const strip = (s) => s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const meta of list.slice(0, 500)) {
      let snippet = '';
      let hit = (meta.title || '').toLowerCase().includes(q) || (meta.url || '').toLowerCase().includes(q);
      if (!hit) {
        try {
          if (meta.size < 30 * 1024 * 1024) {
            const raw = strip(fs.readFileSync(path.join(DATA_DIR, meta.file), 'utf8'));
            const i = raw.toLowerCase().indexOf(q);
            if (i >= 0) { hit = true; snippet = raw.slice(Math.max(0, i - 40), i + 80).trim(); }
          }
        } catch { /* 文件损坏/已删则跳过 */ }
      }
      if (hit) results.push({ id: meta.id, title: meta.title, savedAt: meta.savedAt, platform: meta.platform, snippet });
      if (results.length >= 50) break;
    }
    send(res, 200, JSON.stringify(results), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  // Delete a page
  const dm = p.match(/^\/api\/pages\/([\w-]+)$/);
  if (req.method === 'DELETE' && dm) {
    const id = dm[1];
    const list = loadIndex();
    const meta = list.find(x => x.id === id);
    if (!meta) { send(res, 404, JSON.stringify({ error: 'not found' }), { 'Content-Type': 'application/json' }); return; }
    try { fs.unlinkSync(path.join(DATA_DIR, meta.file)); } catch { /* 文件可能已不存在 */ }
    saveIndex(list.filter(x => x.id !== id));
    addDeletion(id); // tombstone：同步时让其他端也删掉，防止复活
    send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json; charset=utf-8' });
    broadcastDeleted(id);
    sync.schedule(syncConfig());
    return;
  }

  // Single page raw HTML (for iframe rendering) —— 残留远程图片改走本地代理，避免裂图
  const m = p.match(/^\/p\/([\w-]+)$/);
  if (req.method === 'GET' && m) {
    const meta = loadIndex().find(x => x.id === m[1]);
    if (!meta) { send(res, 404, 'not found'); return; }
    let html;
    try { html = fs.readFileSync(path.join(DATA_DIR, meta.file), 'utf8'); } catch { send(res, 404, 'not found'); return; }
    if (/<img[^>]+src="https?:|url\(\s*['"]?https?:/i.test(html)) {
      const proxyBase = '/api/img?r=' + encodeURIComponent(meta.url || '') + '&u=';
      html = html
        .replace(/(<img[^>]+src\s*=\s*["'])(https?:\/\/[^"']+)(["'])/gi, (mm, a, u, b) => a + proxyBase + encodeURIComponent(u) + b)
        .replace(/(url\(\s*["']?)(https?:\/\/[^)"']+)(["']?\s*\))/gi, (mm, a, u, b) => a + proxyBase + encodeURIComponent(u) + b);
    }
    send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    return;
  }

  send(res, 404, 'not found');
});

server.listen(PORT, () => {
  console.log(`网页收藏 sync server running at http://localhost:${PORT}`);
  restartSyncTimer(); // 按保存的同步配置恢复轮询
});
