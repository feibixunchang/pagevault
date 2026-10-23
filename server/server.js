'use strict';

// PageVault sync server — Node zero-dependency.
// Stores full captured pages as self-contained HTML files + a metadata index.
// This same server becomes the Docker "end" later; the data format stays identical.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SyncEngine, extractMeta, ONLINE_WINDOW_MS } = require('./sync');
const { createProvider } = require('./providers');
const { zipStore, zipRead } = require('./zip');

const VERSION = '1.4.0';
const PORT = process.env.PORT || 8731;
// 运行形态：desktop（Electron 壳） / docker（容器） / web（裸跑 node）。
// 各端据此显示自己的名字与版本号，用户在状态栏一眼能看出连的是哪个端。
const PLATFORM = (function () {
  if (process.env.PAGEVAULT_PLATFORM) return process.env.PAGEVAULT_PLATFORM;
  try { if (fs.existsSync('/.dockerenv')) return 'docker'; } catch { /* 忽略 */ }
  return process.env.PAGEVAULT_DESKTOP === '1' ? 'desktop' : 'web';
})();
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

// 合并对端推来的删除记录（tombstone 并集），并立刻应用到本地库。
// 这是"在一台机器上删掉、其他机器不会再冒出来"的关键。
function mergeDeletions(incoming) {
  const map = new Map();
  for (const d of loadDeletions()) if (d && d.id) map.set(d.id, String(d.deletedAt || ''));
  for (const d of (incoming || [])) {
    if (!d || !d.id) continue;
    const at = String(d.deletedAt || '');
    const prev = map.get(d.id);
    if (prev === undefined || at > prev) map.set(d.id, at);
  }
  const list = loadIndex();
  const kept = [];
  let changed = false;
  for (const m of list) {
    if (map.has(m.id)) {
      try { fs.unlinkSync(path.join(DATA_DIR, m.file || (m.id + '.html'))); } catch { /* 已不存在 */ }
      broadcastDeleted(m.id);
      changed = true;
    } else kept.push(m);
  }
  if (changed) saveIndex(kept);
  const out = [...map].map(([id, deletedAt]) => ({ id, deletedAt }));
  saveDeletions(out);
  if (changed) log('peer deletions applied, removed =', list.length - kept.length);
  return out;
}

// 对端推来一个页面：新增或覆盖，星标按 starredAt 新的赢。
// 本地已经删掉的 id 拒绝复活（否则一台机器删、另一台推，会永远来回打架）。
function upsertPageFromPeer(id, html, metaIn) {
  if (loadDeletions().some(d => d && d.id === id)) return { ok: true, written: false, skipped: 'deleted' };
  const embedded = extractMeta(html) || {};
  const inc = Object.assign({}, embedded, metaIn || {});
  const list = loadIndex();
  const cur = list.find(m => m.id === id);
  const file = id + '.html';
  try { fs.writeFileSync(path.join(DATA_DIR, file), html, 'utf8'); } catch (e) {
    return { ok: false, written: false, error: String(e && e.message || e) };
  }
  const size = Buffer.byteLength(html);
  if (cur) {
    if (String(inc.starredAt || '') > String(cur.starredAt || '')) {
      cur.starred = !!inc.starred;
      cur.starredAt = inc.starredAt || '';
    }
    if (inc.title) cur.title = String(inc.title).slice(0, 300);
    if (inc.url) cur.url = String(inc.url).slice(0, 2000);
    cur.size = size;
    saveIndex(list);
    return { ok: true, written: true, added: false, title: cur.title };
  }
  const meta = {
    id,
    title: String(inc.title || 'Untitled').slice(0, 300),
    url: String(inc.url || '').slice(0, 2000),
    savedAt: inc.savedAt || new Date().toISOString(),
    platform: String(inc.platform || 'sync').slice(0, 60),
    format: String(inc.format || 'html').slice(0, 20),
    size,
    file
  };
  if (inc.starred) { meta.starred = true; meta.starredAt = inc.starredAt || new Date().toISOString(); }
  list.push(meta);
  saveIndex(list);
  return { ok: true, written: true, added: true, title: meta.title };
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
  let raw = Array.isArray(s.targets) ? s.targets : [];
  // 兼容 1.0.x 的「单个 WebDAV」配置：自动当成一个 webdav 目标
  if (!raw.length && s.url && s.user) {
    raw = [{ id: 'webdav-1', type: 'webdav', name: 'WebDAV', enabled: true,
      url: s.url, user: s.user, pass: s.pass, dir: s.dir || 'pagevault' }];
  }
  const targets = raw.filter(t => t && t.id && t.type).map(t => ({
    id: String(t.id),
    type: t.type === 'peer' ? 'peer' : 'webdav',
    name: String(t.name || (t.type === 'peer' ? 'PageVault' : 'WebDAV')),
    enabled: t.enabled !== false,
    url: String(t.url || ''),
    user: String(t.user || ''),
    pass: String(t.pass || ''),
    dir: String(t.dir || 'pagevault'),
    token: String(t.token || ''),
    intervalSec: (t.intervalSec === null || t.intervalSec === undefined) ? null : (Number(t.intervalSec) || 0)
  }));
  return { intervalSec: Number(s.intervalSec) || 0, targets };
}
function restartSyncTimer() {
  sync.stop();
  sync.start(syncConfig());
}

// ---------- 本机作为同步源（别的机器把我们加成 peer 目标） ----------
// token 首次启动自动生成并落盘；用户可以在设置里查看/复制/重置。
// 有了它，NAS 才能安全地暴露在同一局域网（甚至反代到公网）供其他端同步。
let syncServerCache = null;
function ensureSyncServer() {
  if (syncServerCache) return syncServerCache;
  const p = loadPrefsRaw();
  const s = p.syncServer || {};
  let changed = false;
  if (!s.token || typeof s.token !== 'string') { s.token = crypto.randomBytes(18).toString('hex'); changed = true; }
  if (typeof s.enabled !== 'boolean') { s.enabled = true; changed = true; }
  if (changed) { p.syncServer = s; try { fs.writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2)); } catch { /* 只读环境忽略 */ } }
  syncServerCache = s;
  return s;
}
function resetSyncServerToken() {
  const p = loadPrefsRaw();
  const s = p.syncServer || {};
  s.token = crypto.randomBytes(18).toString('hex');
  s.enabled = s.enabled !== false;
  p.syncServer = s;
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2)); } catch { /* 忽略 */ }
  syncServerCache = s;
  return s;
}

function isPrivateAddr(ip) {
  if (!ip) return false;
  const a = String(ip).replace(/^::ffff:/i, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(a)) return true;  // fc00::/7 内网
  if (/^fe80:/i.test(a)) return true;            // 链路本地
  return false;
}

// 对端接口鉴权：必须带 Bearer token（?token= 也接受，方便浏览器里手测）
function peerAuthorized(req, url) {
  const srv = ensureSyncServer();
  if (srv.enabled === false) return false;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const given = (m ? m[1] : (url.searchParams.get('token') || '')).trim();
  if (!given) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(srv.token, 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}
function peerDeny(res) {
  send(res, 401, JSON.stringify({ ok: false, error: 'unauthorized', message: '同步令牌不正确' }),
    { 'Content-Type': 'application/json; charset=utf-8' });
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
      if (typeof prefs.bold === 'boolean') clean.bold = prefs.bold;
      if (typeof prefs.autoUpdate === 'boolean') clean.autoUpdate = prefs.autoUpdate;
      // 同步目标：数组，每项 webdav（网盘）或 peer（另一台本程序 = NAS）
      if (prefs.sync && typeof prefs.sync === 'object') {
        const s = prefs.sync;
        const targets = [];
        const seen = new Set();
        for (const t of (Array.isArray(s.targets) ? s.targets : [])) {
          if (!t || typeof t !== 'object') continue;
          const type = t.type === 'peer' ? 'peer' : 'webdav';
          let id = String(t.id || '').replace(/[^\w-]/g, '').slice(0, 40);
          if (!id) id = 't' + crypto.randomBytes(4).toString('hex');
          while (seen.has(id)) id = id + crypto.randomBytes(1).toString('hex');
          const item = {
            id,
            type,
            name: String(t.name || (type === 'peer' ? 'PageVault' : 'WebDAV')).slice(0, 60),
            enabled: t.enabled !== false,
            url: String(t.url || '').trim().slice(0, 500),
            intervalSec: [null, 0, 10, 30, 60, 300].includes(t.intervalSec) ? t.intervalSec : null
          };
          if (!item.url) continue; // 没地址的目标没意义，直接丢掉
          if (type === 'webdav') {
            item.user = String(t.user || '').slice(0, 200);
            item.pass = String(t.pass || '').slice(0, 500);
            item.dir = (String(t.dir || 'pagevault').slice(0, 100).replace(/[\\/:*?"<>|]+/g, '') || 'pagevault');
            if (!item.user) continue;
          } else {
            item.token = String(t.token || '').trim().slice(0, 200);
          }
          seen.add(id);
          targets.push(item);
        }
        clean.sync = {
          intervalSec: [0, 10, 30, 60].includes(s.intervalSec) ? s.intervalSec : 0,
          targets
        };
      } else {
        const old = loadPrefsRaw();
        if (old.sync) clean.sync = old.sync;
      }
      // syncServer 由服务端自己维护（令牌不可从前端改写），原样保留
      const prev = loadPrefsRaw();      if (prev.syncServer) clean.syncServer = prev.syncServer;
      try { fs.writeFileSync(PREFS_FILE, JSON.stringify(clean, null, 2)); } catch { /* 只读环境忽略 */ }
      syncServerCache = null;
      send(res, 200, JSON.stringify(Object.assign({}, clean, { syncServer: ensureSyncServer() })), { 'Content-Type': 'application/json; charset=utf-8' });
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
    // 同步报"域名解析失败"时，顺手探一下公网 DNS：能区分"只是这个域名坏了"还是"本机 DNS 整体不可用"
    const needDnsProbe = /域名解析失败/.test(s.lastError || '');
    const respond = (dnsOk) => {
      let lastError = s.lastError;
      if (needDnsProbe && dnsOk === false) {
        lastError += '（本机 DNS 整体不可用：连 www.baidu.com 也解析不了，请检查网络后再试）';
      }
      send(res, 200, JSON.stringify({
        ok: true, version: VERSION, port: PORT, platform: PLATFORM,
        extension: { lastSeen: extState.lastSeen, version: extState.version, online: extensionOnline() },
        extensionPath: extensionDir(),
        sync: {
          configured: s.configured,
          status: s.status,
          lastSyncAt: s.lastSyncAt,
          lastError: lastError,
          lastStats: s.lastStats,
          targets: s.targets
        },
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

  // ---------- 同步：目标测试 / 立即同步 / 状态 / 本机令牌 ----------
  if (req.method === 'POST' && p === '/api/sync/test') {
    readBody(req, 1024 * 1024, (err, buf) => {
      if (err) { send(res, 413, JSON.stringify({ ok: false, message: 'too large' }), { 'Content-Type': 'application/json' }); return; }
      let cfg;
      try { cfg = JSON.parse(buf.toString('utf8')); } catch { send(res, 400, JSON.stringify({ ok: false, message: 'invalid json' }), { 'Content-Type': 'application/json' }); return; }
      (async () => {
        try {
          const prov = createProvider({
            id: 'test',
            type: cfg.type === 'peer' ? 'peer' : 'webdav',
            url: String(cfg.url || ''),
            user: cfg.user, pass: cfg.pass,
            dir: cfg.dir || 'pagevault',
            token: cfg.token
          });
          const r = await prov.test();
          send(res, 200, JSON.stringify(r), { 'Content-Type': 'application/json; charset=utf-8' });
        } catch (e) {
          send(res, 200, JSON.stringify({ ok: false, message: e && e.message ? e.message : String(e) }), { 'Content-Type': 'application/json; charset=utf-8' });
        }
      })();
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/sync/run') {
    readBody(req, 64 * 1024, (err, buf) => {
      let targetId = '';
      if (!err && buf && buf.length) {
        try { targetId = String(JSON.parse(buf.toString('utf8')).targetId || ''); } catch { /* 无 body 视为全量 */ }
      }
      const cfg = syncConfig();
      let job;
      if (targetId) {
        const t = cfg.targets.find(x => x.id === targetId);
        job = t ? sync.runOne(t, cfg) : Promise.resolve({ pulled: 0, pushed: 0, deleted: 0, errors: ['找不到该同步目标'] });
      } else {
        job = sync.runAll(cfg);
      }
      Promise.resolve(job).then(results => {
        const list = Array.isArray(results) ? results : [results];
        const agg = { pulled: 0, pushed: 0, deleted: 0, errors: [] };
        for (const r of list) {
          agg.pulled += r.pulled || 0;
          agg.pushed += r.pushed || 0;
          agg.deleted += r.deleted || 0;
          for (const e of (r.errors || [])) agg.errors.push(e);
        }
        broadcastMeta({ type: 'synced', at: Date.now() });
        const st = sync.getStatus();
        send(res, 200, JSON.stringify({ ok: st.status !== 'error', stats: agg, status: st }), { 'Content-Type': 'application/json; charset=utf-8' });
      });
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/sync/status') {
    send(res, 200, JSON.stringify(sync.getStatus()), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }
  // 本机作为同步源的令牌：设置面板显示/复制/重置
  if (req.method === 'GET' && p === '/api/sync/token') {
    const s = ensureSyncServer();
    const lan = [];
    try {
      for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family !== 'IPv4' || a.internal) continue;
          // 容器里的 eth0 是 Docker 内网段（172.16-31），别的机器根本连不上，
          // 显示出来只会误导用户去复制一个假地址
          if (PLATFORM === 'docker' && /^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) continue;
          lan.push({ name, address: a.address, url: 'http://' + a.address + ':' + PORT });
        }
      }
    } catch { /* 忽略 */ }
    // Docker / 反代后面，宿主地址没法自己推断：用 PAGEVAULT_PUBLIC_ADDR 显式给
    // （可写多个，逗号分隔，允许纯 IP、host:port 或完整 URL）
    for (const raw of String(process.env.PAGEVAULT_PUBLIC_ADDR || '').split(',')) {
      const v = raw.trim();
      if (!v) continue;
      const url = /^https?:\/\//i.test(v) ? v.replace(/\/+$/, '') : 'http://' + v + (v.includes(':') ? '' : ':' + PORT);
      if (!lan.some(a => a.url === url)) lan.unshift({ name: 'host', address: url.replace(/^https?:\/\//i, ''), url });
    }
    send(res, 200, JSON.stringify({ ok: true, token: s.token, enabled: s.enabled !== false, port: PORT, addresses: lan },
      { 'Content-Type': 'application/json; charset=utf-8' }));
    return;
  }
  if (req.method === 'POST' && p === '/api/sync/token/reset') {
    const s = resetSyncServerToken();
    log('sync server token rotated');
    send(res, 200, JSON.stringify({ ok: true, token: s.token, enabled: s.enabled !== false }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  // ---------- 对端接口（供其他 PageVault 实例把本机当同步源/备份源） ----------
  // 一律要求 Bearer 令牌，防止同一局域网里的其他设备偷偷读写你的库。
  if (p.startsWith('/api/sync/') && !p.startsWith('/api/sync/status')) {
    if (!peerAuthorized(req, url)) { peerDeny(res); return; }

    const hostName = (loadPrefsRaw().syncServer || {}).name || os.hostname() || 'PageVault';

    if (req.method === 'GET' && p === '/api/sync/probe') {
      send(res, 200, JSON.stringify({
        ok: true, name: hostName, version: VERSION, platform: PLATFORM,
        count: loadIndex().length
      }), { 'Content-Type': 'application/json; charset=utf-8' });
      return;
    }

    if (req.method === 'GET' && p === '/api/sync/manifest') {
      const pages = loadIndex()
        .map(({ file, ...m }) => m)
        .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
      send(res, 200, JSON.stringify({
        ok: true, name: hostName, version: VERSION, platform: PLATFORM,
        count: pages.length, pages, deletions: loadDeletions()
      }), { 'Content-Type': 'application/json; charset=utf-8' });
      return;
    }

    const pm = p.match(/^\/api\/sync\/page\/([\w-]+)$/);
    if (pm) {
      const id = pm[1];
      if (req.method === 'GET') {
        const meta = loadIndex().find(x => x.id === id);
        if (!meta) { send(res, 404, 'not found'); return; }
        try {
          const html = fs.readFileSync(path.join(DATA_DIR, meta.file || (id + '.html')), 'utf8');
          send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
        } catch { send(res, 404, 'not found'); }
        return;
      }
      if (req.method === 'PUT') {
        readBody(req, MAX_BODY, (err, buf) => {
          if (err) { send(res, 413, JSON.stringify({ ok: false, error: 'too large' }), { 'Content-Type': 'application/json' }); return; }
          const html = buf.toString('utf8');
          if (!html) { send(res, 400, JSON.stringify({ ok: false, error: 'empty body' }), { 'Content-Type': 'application/json' }); return; }
          let metaIn = null;
          const b64 = req.headers['x-pv-meta'];
          if (b64) { try { metaIn = JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8')); } catch { /* 头解析失败就靠文件头注释 */ } }
          const r = upsertPageFromPeer(id, html, metaIn);
          send(res, 200, JSON.stringify(r), { 'Content-Type': 'application/json; charset=utf-8' });
          if (r.written) broadcastSaved({ id, title: r.title || 'Untitled' });
        });
        return;
      }
      if (req.method === 'DELETE') {
        const list = loadIndex();
        const meta = list.find(x => x.id === id);
        if (meta) {
          try { fs.unlinkSync(path.join(DATA_DIR, meta.file || (id + '.html'))); } catch { /* 已不存在 */ }
          saveIndex(list.filter(x => x.id !== id));
          addDeletion(id);
          broadcastDeleted(id);
        }
        send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json; charset=utf-8' });
        return;
      }
    }

    const mm = p.match(/^\/api\/sync\/meta\/([\w-]+)$/);
    if (req.method === 'PUT' && mm) {
      readBody(req, 64 * 1024, (err, buf) => {
        if (err) { send(res, 413, JSON.stringify({ ok: false }), { 'Content-Type': 'application/json' }); return; }
        let body = {};
        try { body = JSON.parse(buf.toString('utf8')); } catch { /* 空 body */ }
        const list = loadIndex();
        const meta = list.find(x => x.id === mm[1]);
        if (!meta) { send(res, 404, JSON.stringify({ ok: false }), { 'Content-Type': 'application/json' }); return; }
        if (String(body.starredAt || '') > String(meta.starredAt || '')) {
          meta.starred = !!body.starred;
          meta.starredAt = body.starredAt || '';
          saveIndex(list);
          broadcastMeta({ type: 'starred', id: meta.id, starred: !!meta.starred });
        }
        send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json; charset=utf-8' });
      });
      return;
    }

    if (req.method === 'POST' && p === '/api/sync/deletions') {
      readBody(req, 1024 * 1024, (err, buf) => {
        if (err) { send(res, 413, JSON.stringify({ ok: false }), { 'Content-Type': 'application/json' }); return; }
        let incoming = [];
        try { const a = JSON.parse(buf.toString('utf8')); incoming = Array.isArray(a) ? a : []; } catch { /* 忽略 */ }
        const merged = mergeDeletions(incoming);
        send(res, 200, JSON.stringify({ ok: true, total: merged.length }), { 'Content-Type': 'application/json; charset=utf-8' });
      });
      return;
    }

    send(res, 404, JSON.stringify({ ok: false, error: 'not found' }), { 'Content-Type': 'application/json' });
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

  // 扩展整包下载（Docker / 网页版没有本地安装目录，用户必须能从这里把扩展拿走）
  // GET /api/extension.zip -> application/zip
  if (req.method === 'GET' && p === '/api/extension.zip') {
    const dir = extensionDir();
    if (!dir) { send(res, 404, JSON.stringify({ error: 'extension not bundled' }), { 'Content-Type': 'application/json' }); return; }
    try {
      const files = [];
      (function walk(sub) {
        const abs = sub ? path.join(dir, sub) : dir;
        for (const name of fs.readdirSync(abs)) {
          const rel = sub ? sub + '/' + name : name;
          const full = path.join(dir, rel);
          const st = fs.statSync(full);
          if (st.isDirectory()) walk(rel);
          else if (st.isFile()) files.push({ name: rel, data: fs.readFileSync(full) });
        }
      })('');
      const buf = zipStore(files);
      send(res, 200, buf, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="pagevault-extension.zip"',
        'Cache-Control': 'no-store'
      });
    } catch (e) {
      send(res, 500, JSON.stringify({ error: String(e && e.message || e) }), { 'Content-Type': 'application/json' });
    }
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
  ensureSyncServer();   // 确保本机作为同步源的令牌已生成
  restartSyncTimer();   // 按保存的同步配置恢复轮询
});
