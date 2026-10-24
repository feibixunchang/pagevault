'use strict';

// PageVault sync server — Node zero-dependency.
// Stores full captured pages as self-contained HTML files + a metadata index.
// This same server becomes the Docker "end" later; the data format stays identical.

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SyncEngine, extractMeta, ONLINE_WINDOW_MS } = require('./sync');
const { createProvider } = require('./providers');
const { zipStore, zipStoreStream, zipRead } = require('./zip');
const { attachWebSocket } = require('./extws');
const { pageTitle, usableTitle, looksLikeGatePage } = require('./titles');
const { parseFeed, parseOpml } = require('./sources');
const { urlKey, sameUrl } = require('./urlkey.js');

const VERSION = '1.5.7';
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

const { HotListEngine } = require('./hotlist.js');
const { SOURCES: HOT_SOURCES } = require('./sources.js');

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
// 两种来源：
//   1) WebSocket 长连接（新版扩展）—— 实时、精确，断了立刻知道；
//   2) HTTP 心跳（旧版扩展）—— 兜底，按 2 分钟窗口判断。
let extState = { lastSeen: 0, version: '', wsSeen: false };
try { extState = Object.assign(extState, JSON.parse(fs.readFileSync(EXT_STATE_FILE, 'utf8'))); } catch { /* 无文件用默认 */ }
function touchExtension(version) {
  extState.lastSeen = Date.now();
  if (version) extState.version = version;
  try { fs.writeFileSync(EXT_STATE_FILE, JSON.stringify(extState)); } catch { /* 只读环境忽略 */ }
}
let extSockets = 0;   // 当前连着的扩展 WebSocket 数量
function extensionOnline() {
  // 扩展支持 WebSocket（新版）→ 以长连接为准：断了就是断了，秒级准确
  if (extState.wsSeen) return extSockets > 0;
  // 老扩展只有 HTTP 心跳 → 按 2 分钟窗口判断
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

// 安装包内置的扩展版本：用来判断浏览器里跑的是不是旧版扩展。
// 旧版扩展不会用 WebSocket 长连接，浏览器里不点「重新加载」就永远连不回来。
let bundledExtVersion = '';
try {
  const d = extensionDir();
  if (d) bundledExtVersion = String((JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')) || {}).version || '');
} catch { /* 读不到就当没有 */ }

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
    // 所有保存入口的最后一道标题兜底：扩展传上来的 title 偶尔是空的
    // （SingleFile 抓不到 document.title 时），旧版客户端也可能只传网址。
    // 这种情况下现从 HTML 里挖一次，总比列表里挂个 "Untitled" 强。
    title: resolveTitle(inc.title, html, inc.url),
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

// ---------- 热榜引擎（定时把知乎/V2EX/少数派…的热榜文章抓下来存库） ----------
const hotlist = new HotListEngine({
  listUrls: () => loadIndex().map(m => m.url).filter(Boolean),
  pageTitle: (html, url) => pageTitle(html, url),
  persistPage: (payload, opts) => persistPage(payload, opts),
  // 自定义 RSS 订阅：现造一个"来源"对象，热榜引擎就能照常处理
  resolveSource: (sid) => {
    const f = feedById(feedIdFromSource(sid));
    if (!f) return null;
    return {
      id: sid,
      name: f.title || f.url,
      type: 'rss',
      url: f.url,
      // 抽正文时不指定选择器 → 走站点选择器表 + 段落打分
      parse: (text) => parseFeed(text, f.url)
    };
  },
  log,
  onPulled: (r) => {
    log('hotlist pulled', r.sourceId, 'saved=' + r.saved.length, 'errors=' + r.errors.length);
    broadcastMeta({ type: 'hotlist', sourceId: r.sourceId, saved: r.saved.length, at: Date.now() });
  }
});

// ---------- 自定义 RSS 订阅 ----------
// 存在 prefs.json 的 hotlist.feeds 里（数组）。id 用 url 的 sha1 前 12 位。
function feedList() {
  const p = loadPrefsRaw();
  const h = p.hotlist || {};
  const arr = Array.isArray(h.feeds) ? h.feeds : [];
  return arr.filter(f => f && f.url).map(f => {
    const builtin = findBuiltinSourceForFeed(f.url);
    return {
      id: String(f.id || feedId(f.url)),
      url: String(f.url),
      title: String(f.title || f.url),
      limit: Math.max(1, Math.min(MAX_HOT_LIMIT, Number(f.limit) || DEFAULT_HOT_LIMIT)),
      enabled: f.enabled !== false,
      intervalSec: f.intervalSec === undefined
        ? DEFAULT_FEED_INTERVAL
        : Math.max(0, Math.min(86400 * 7, Number(f.intervalSec) || 0)),
      addedAt: f.addedAt || '',
      // 与内置热榜重复时告诉前端是哪个内置源，用户可以选择停用其中一个
      duplicateOf: builtin ? { id: builtin.id, name: builtin.name } : null
    };
  });
}
function feedId(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 12);
}
function feedById(id) {
  return feedList().find(f => f.id === id) || null;
}
function saveFeeds(list) {
  const p = loadPrefsRaw();
  p.hotlist = Object.assign({}, p.hotlist || {}, { feeds: list });
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2)); } catch { /* 只读环境忽略 */ }
  // 订阅变了要重排定时器：新加的订阅得能自动拉，删掉的不能再拉。
  restartHotlistTimer();
  return list;
}
/** 订阅 id 统一用 'feed:' 前缀，避免和内置来源重名 */
const feedSourceId = (id) => 'feed:' + id;
const feedIdFromSource = (sid) => String(sid || '').replace(/^feed:/, '');

/**
 * 找一个订阅是不是某个内置热榜源的"同一个源"。
 *
 * 内置热榜里的少数派 / IT之家 / 爱范儿 / 阮一峰 / Solidot / 极客公园 用的就是 RSS 地址，
 * 用户再从 OPML 里导入一遍，等于同一个站点被拉两遍 —— 文章虽然有去重，
 * 但用户看到的是"两个一模一样的源"，还会各自占一份自动拉取的名额。
 * 这里返回匹配上的内置源，前端可以提示"这个已经有了"。
 */
function findBuiltinSourceForFeed(url) {
  const target = urlKey(url);
  const targetHost = (() => {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
  })();
  for (const s of HOT_SOURCES) {
    if (s.type !== 'rss') continue;
    if (urlKey(s.url) === target) return s;
    // feedburner 镜像之类的等价域名也算同一个源
    try {
      const h = new URL(s.url).hostname.toLowerCase().replace(/^www\./, '');
      if (h && targetHost && h === targetHost) return s;
    } catch { /* 忽略 */ }
  }
  return null;
}

/**
 * 热榜配置存在 prefs.json 的 hotlist.sources 里
 *
 * 默认值：
 * - limit：10 篇（用户要求「每次默认 10 篇」，以前是 5）
 * - intervalSec：默认 0（不自动拉）。用户可以在界面上开自动拉取，
 *   开了之后这里读的就是用户设的值。
 */
const DEFAULT_HOT_LIMIT = 10;
const MAX_HOT_LIMIT = 50;
/**
 * 默认自动拉取间隔。
 * 用户要求「默认自动拉取每个 10 篇」——所以默认就该是开着的：
 * 热榜 6 小时一轮（榜单变化快），RSS 12 小时一轮（订阅更新慢）。
 * 显式设成 0 的用户仍然保持"不自动"，不会被默认值覆盖。
 */
const DEFAULT_HOT_INTERVAL = 6 * 3600;
const DEFAULT_FEED_INTERVAL = 12 * 3600;
function hotlistConfig() {
  const p = loadPrefsRaw();
  const h = p.hotlist || {};
  const raw = h.sources && typeof h.sources === 'object' ? h.sources : {};
  const sources = {};
  for (const s of HOT_SOURCES) {
    const c = raw[s.id] || {};
    sources[s.id] = {
      enabled: c.enabled !== false,
      limit: Math.max(1, Math.min(MAX_HOT_LIMIT, Number(c.limit) || DEFAULT_HOT_LIMIT)),
      intervalSec: c.intervalSec === undefined
        ? DEFAULT_HOT_INTERVAL
        : Math.max(0, Math.min(86400 * 7, Number(c.intervalSec) || 0)),
      cookie: String(c.cookie || '')
    };
  }
  // RSS 订阅也要进调度表 —— 以前只把内置来源放进去，
  // 于是「订阅的自动拉取间隔」这个字段存了也永远没人读，订阅永远不会自动拉。
  for (const f of feedList()) {
    sources[feedSourceId(f.id)] = {
      enabled: f.enabled !== false,
      limit: f.limit,
      intervalSec: f.intervalSec,
      cookie: ''
    };
  }
  return { sources };
}

function saveHotlistConfig(next) {
  const p = loadPrefsRaw();
  // ⚠️ 这里以前写成 `p.hotlist = { sources: next.sources || {} }`，
  // 结果是「改一个来源的 Cookie / 条数」会顺手把 hotlist 下的 feeds（RSS 订阅）整个抹掉 ——
  // 用户表现为：刚导入的 15 个订阅莫名消失。必须保留其它字段。
  // 同时要把 'feed:' 前缀的条目剔掉：那只是给调度器用的视图，不是用户配置。
  const src = {};
  for (const k of Object.keys(next.sources || {})) {
    if (k.startsWith('feed:')) continue;
    src[k] = next.sources[k];
  }
  p.hotlist = Object.assign({}, p.hotlist || {}, { sources: src });
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2)); } catch { /* 只读环境忽略 */ }
  hotlist.setConfig(hotlistConfig());
  return next;
}

function restartHotlistTimer() {
  hotlist.setConfig(hotlistConfig());
}

// 发出去的偏好里必须抹掉凭证：热榜 Cookie 是能登录你账号的东西，
// 而 /api/prefs 是局域网内谁都能 GET 的（SSE 的 prefs 广播同理）。
// 前端要知道"配没配"看 /api/sources 的 hasCookie 就够，不需要拿到原文。
function publicPrefs(prefs) {
  const out = Object.assign({}, prefs);
  const hs = out.hotlist && out.hotlist.sources;
  if (hs && typeof hs === 'object') {
    const m = {};
    for (const k of Object.keys(hs)) {
      const c = hs[k] || {};
      m[k] = { enabled: c.enabled !== false, limit: c.limit, intervalSec: c.intervalSec };
    }
    out.hotlist = { sources: m };
  }
  return out;
}

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

// ---------- 服务端抓网页（手机端「粘贴链接收藏」用） ----------
// 浏览器扩展是把渲染好的整页 DOM 抓下来上传，手机上做不到这一点（微信/Safari 都不给），
// 所以这里让服务端替手机去抓：拿原始 HTML + 注入 <base>，读的时候图片仍走 /api/img 代理。
const FETCH_MAX_BYTES = 12 * 1024 * 1024;
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetchHtml(targetUrl, hops) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch { return reject(new Error('网址格式不对')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('只支持 http/https 网址'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, {
      headers: {
        'User-Agent': DESKTOP_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        // 不要压缩：省得手动解 gzip/br，抓网页这点流量影响可忽略
        'Accept-Encoding': 'identity'
      },
      timeout: 20000
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if ((hops || 0) >= 6) return reject(new Error('重定向次数太多'));
        const next = new URL(res.headers.location, u).toString();
        return fetchHtml(next, (hops || 0) + 1).then(resolve, reject);
      }
      if (code >= 400) { res.resume(); return reject(new Error('对方网站返回 HTTP ' + code)); }
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > FETCH_MAX_BYTES) {
          req.destroy();
          reject(new Error('页面太大（超过 12MB），这个链接可能不是普通网页'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: String(res.headers['content-type'] || ''),
        finalUrl: u.toString()
      }));
    });
    req.on('timeout', () => req.destroy(new Error('抓取超时（20 秒），对方网站太慢或连不上')));
    req.on('error', (e) => reject(e));
  });
}

// 国内不少站点还是 GBK，Node 默认按 UTF-8 解会变乱码
function decodePage(buffer, contentType) {
  let charset = (String(contentType).match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!charset) {
    const head = buffer.slice(0, 4096).toString('latin1');
    charset = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  }
  charset = String(charset || 'utf-8').toLowerCase();
  if (charset === 'gb2312' || charset === 'gb-2312') charset = 'gbk';
  try { return new TextDecoder(charset).decode(buffer); } catch { return buffer.toString('utf8'); }
}

// 把 Node 的底层网络错误翻成人话——手机端会把这段原样显示在提示里
function friendlyFetchError(e) {
  const code = (e && e.code) || '';
  const msg = (e && e.message) || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败，检查网址有没有写错';
  if (code === 'ECONNREFUSED') return '对方网站拒绝连接';
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) return '连接超时，对方网站太慢或连不上';
  if (code === 'ECONNRESET' || /socket disconnected|TLS/i.test(msg)) return '连接被对方中断（可能限制了抓取，或需要代理）';
  if (/certificate/i.test(msg)) return '对方网站的 HTTPS 证书有问题';
  return msg || '抓取失败';
}

// 标题提取搬到 titles.js：微信这类页面 <title> 是空的，得从 og:title / h1 多源兜底。
// （这里保留一个薄封装，热榜抓取通过 hooks.pageTitle 复用它）

/**
 * 在库里找同一个 URL 的收藏（按归一化后的 key 比）。
 * 手动保存时用来判重：同一个链接带不同的追踪参数 / 末尾斜杠 / www 前缀，
 * 归一化之后是同一篇，不该存两份。
 */
function findPageByUrl(url) {
  const key = urlKey(url);
  if (!key) return null;
  const list = loadIndex();
  for (const m of list) {
    if (m && m.url && urlKey(m.url) === key) return m;
  }
  return null;
}

/**
 * 定这条收藏的标题：调用方给的能用就用，否则从 HTML 里挖，再不行退回网址。
 * 退回网址而不是"Untitled"：列表里显示一串链接，至少点进去能看出来源，
 * 用户能判断要不要留；"Untitled" 是完全无信息。
 */
function resolveTitle(inputTitle, html, pageUrl) {
  const t = String(inputTitle || '').trim();
  if (usableTitle(t, pageUrl)) return t.slice(0, 300);
  const mined = pageTitle(html || '', pageUrl);
  if (mined) return mined;
  return String(pageUrl || '').trim().slice(0, 300) || 'Untitled';
}


// 存档页里保留着原站自己的 JS，而阅读 iframe 是 allow-same-origin + allow-scripts ——
// 也就是说被收藏页面里的脚本跟我们**同源**，能直接 fetch('/api/pages/…', {method:'DELETE'}) 把库清空。
// 这里注入一条很窄的 CSP：脚本照旧能跑（不少页面靠它渲染），但不许发网络请求、不许提交表单。
// 存档本来就该是"死"的，顺带也堵住了把库里内容往外传的路。只限制 connect/form，
// 图片、样式、字体不受影响，所以不会变成裂图。
const PAGE_CSP = "connect-src 'none'; form-action 'none'";
function injectPageCsp(html) {
  const s = String(html);
  if (/http-equiv=["']?Content-Security-Policy/i.test(s)) return s; // 原页自己声明过就不插手
  const meta = '<meta http-equiv="Content-Security-Policy" content="' + PAGE_CSP + '">';
  if (/<head[^>]*>/i.test(s)) return s.replace(/<head([^>]*)>/i, (mm, a) => '<head' + a + '>' + meta);
  return meta + s;
}

/**
 * 阅读用的瘦身：剥掉所有 <script>，并解除"先用 CSS 藏起来等 JS 显示"的内联样式。
 *
 * 为什么必须剥脚本：
 *   1) 体积。微信文章整页 3.4MB，其中 98% 是 58 个 <script>；剥掉后只剩 70KB。
 *      手机上 WKWebView 加载 3.4MB + 一堆脚本会被系统直接杀掉——表现就是点开就闪退。
 *   2) 安全。同源脚本能直接调 /api 删库（CSP 只挡了 connect，挡不住同源读写 DOM）。
 *   3) 我们存的是抓取时的静态快照，脚本从来没跑过，删掉不影响已抓到的内容。
 * 副作用只有一个：靠 JS 显示出来的内容本来就没抓到，删不删都一样。
 *
 * 但微信这类页面把正文写成 visibility:hidden; opacity:0，等自己的 JS 排版完再显示。
 * 光删脚本会让正文永远藏着，所以必须同时把这两种内联样式解掉。
 */
const SCRIPT_TAG_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const INLINE_STYLE_RE = /(style\s*=\s*["'])([^"']*)(["'])/gi;
const HIDING_CSS_RE = /visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)/i;

function slimPageForReading(html) {
  let s = String(html).replace(SCRIPT_TAG_RE, '');
  s = s.replace(INLINE_STYLE_RE, (whole, open, css, close) => {
    if (!HIDING_CSS_RE.test(css)) return whole;
    const next = css
      .replace(/visibility\s*:\s*hidden\s*;?/gi, '')
      .replace(/opacity\s*:\s*0(?:\.0+)?\s*;?/gi, '')
      .trim();
    return open + next + close;
  });
  return s;
}

// 落盘 + 建索引 + 广播 + 触发同步。浏览器扩展上传、手机端按链接抓取，两条路都走这里，
// 保证存出来的数据格式完全一致（同步/WebDAV/离线缓存都依赖这一点）。
function persistPage(payload, opts) {
  opts = opts || {};
  const html = payload.html;
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
  if (payload.engine) meta.engine = String(payload.engine).slice(0, 40);
  // 文件头注入元数据注释：WebDAV 同步时即使 index.json 丢了也能自愈重建
  const embedded = Object.assign({}, meta);
  delete embedded.file;
  const htmlWithMeta = '<!-- pv-meta:' + JSON.stringify(embedded) + ' -->\n' + html;
  fs.writeFileSync(path.join(DATA_DIR, meta.file), htmlWithMeta, 'utf8');
  const list = loadIndex();
  list.push(meta);
  saveIndex(list);
  // 库里多了新文章 → 热榜的去重集合要失效重建，
  // 否则扩展刚保存的那篇，热榜这边还当"没存过"会再存一次。
  if (typeof hotlist !== 'undefined' && hotlist && hotlist.invalidateKnownUrls) {
    hotlist.invalidateKnownUrls();
  }
  if (opts.touchExtension) touchExtension(); // 扩展刚保存过，状态栏立刻显示"已连接"
  broadcastSaved(meta);
  sync.schedule(syncConfig()); // 即时同步给其他端
  return meta;
}

// 发文件。extraHeaders 用来带 Content-Disposition —— 以前这个参数没被接收，
// 「导出 .html」的下载文件名/后缀全丢了，存下来是个没有扩展名的文件。
function sendFile(res, filepath, type, extraHeaders) {
  fs.readFile(filepath, (err, data) => {
    if (err) { send(res, 404, 'not found'); return; }
    send(res, 200, data, Object.assign({ 'Content-Type': type }, extraHeaders || {}));
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

// 扩展连接状态变化 → 立刻推给所有界面（不用等心跳窗口过期）
function broadcastExt() {
  const payload = `data: ${JSON.stringify({
    type: 'ext',
    online: extensionOnline(),
    connected: extSockets > 0,
    lastSeen: extState.lastSeen,
    version: extState.version
  })}\n\n`;
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

  // ---------- 热榜 ----------
  // 来源清单（含每个来源的开关、拉多少篇、多久拉一次、有没有配 Cookie）
  if (req.method === 'GET' && p === '/api/sources') {
    send(res, 200, JSON.stringify(hotlist.status()), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }
  // 拉某个来源（或全部启用的来源）
  const hotPull = p.match(/^\/api\/sources\/([\w-]+)\/pull$/);
  if (req.method === 'POST' && hotPull) {
    readBody(req, 1024 * 256, (err, buf) => {
      if (err) { send(res, 413, JSON.stringify({ error: '请求体太大' }), { 'Content-Type': 'application/json' }); return; }
      let payload = {};
      try { payload = JSON.parse(buf.toString('utf8') || '{}'); } catch { payload = {}; }
      hotlist.pull(hotPull[1], {
        limit: Number(payload.limit) || 0,
        cookie: payload.cookie !== undefined ? String(payload.cookie) : undefined
      }).then(r => {
        send(res, 200, JSON.stringify(r), { 'Content-Type': 'application/json; charset=utf-8' });
      }).catch(e => {
        send(res, 502, JSON.stringify({ error: (e && e.message) || String(e) }), { 'Content-Type': 'application/json; charset=utf-8' });
      });
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/sources/pull-all') {
    const cfg = hotlistConfig();
    const ids = Object.keys(cfg.sources).filter(id => cfg.sources[id].enabled);
    const results = [];
    const runOne = (i) => {
      if (i >= ids.length) {
        send(res, 200, JSON.stringify({ ok: true, results }), { 'Content-Type': 'application/json; charset=utf-8' });
        return;
      }
      hotlist.pull(ids[i], { limit: cfg.sources[ids[i]].limit, cookie: cfg.sources[ids[i]].cookie })
        .then(r => { results.push(r); runOne(i + 1); })
        .catch(e => { results.push({ sourceId: ids[i], ok: false, errors: [{ error: (e && e.message) || String(e) }] }); runOne(i + 1); });
    };
    runOne(0);
    return;
  }
  // 改某个来源的配置（开关/条数/间隔/Cookie）
  const hotCfg = p.match(/^\/api\/sources\/([\w-]+)$/);
  if (req.method === 'PUT' && hotCfg) {
    if (!HOT_SOURCES.some(s => s.id === hotCfg[1])) {
      send(res, 404, JSON.stringify({ ok: false, error: '没有这个热榜来源' }), { 'Content-Type': 'application/json; charset=utf-8' });
      return;
    }
    readBody(req, 1024 * 256, (err, buf) => {
      if (err) { send(res, 413, JSON.stringify({ error: '请求体太大' }), { 'Content-Type': 'application/json' }); return; }
      let payload = {};
      try { payload = JSON.parse(buf.toString('utf8') || '{}'); } catch { payload = {}; }
      const cur = hotlistConfig();
      const c = cur.sources[hotCfg[1]] || {};
      // ⚠️ 没传的字段必须保留原值，不能拿默认值顶上。
      // 以前 intervalSec 写的是 `Number(payload.intervalSec) || 0`，
      // 于是「只改条数」或「只存 Cookie」的请求会把自动拉取间隔悄悄清零 —— 用户永远发现不了。
      const next = {
        enabled: typeof payload.enabled === 'boolean' ? payload.enabled : c.enabled,
        limit: payload.limit === undefined
          ? (c.limit || DEFAULT_HOT_LIMIT)
          : Math.max(1, Math.min(MAX_HOT_LIMIT, Number(payload.limit) || c.limit || DEFAULT_HOT_LIMIT)),
        intervalSec: payload.intervalSec === undefined
          ? (c.intervalSec || 0)
          : Math.max(0, Math.min(86400 * 7, Number(payload.intervalSec) || 0)),
        cookie: payload.cookie !== undefined ? String(payload.cookie) : (c.cookie || '')
      };
      cur.sources[hotCfg[1]] = next;
      saveHotlistConfig(cur);
      send(res, 200, JSON.stringify({ ok: true, config: cur.sources[hotCfg[1]] }), { 'Content-Type': 'application/json; charset=utf-8' });
    });
    return;
  }

  // ---------- 自定义 RSS 订阅 ----------
  if (req.method === 'GET' && p === '/api/feeds') {
    send(res, 200, JSON.stringify({ feeds: feedList() }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }
  if (req.method === 'POST' && p === '/api/feeds') {
    readBody(req, 1024 * 1024, (err, buf) => {
      if (err) { send(res, 413, JSON.stringify({ error: '请求体太大' }), { 'Content-Type': 'application/json' }); return; }
      let payload = {};
      try { payload = JSON.parse(buf.toString('utf8') || '{}'); } catch { payload = {}; }
      const url = String(payload.url || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        send(res, 400, JSON.stringify({ error: '请填 http:// 或 https:// 开头的订阅地址' }), { 'Content-Type': 'application/json; charset=utf-8' });
        return;
      }
      // 先真拉一次，确认这是真订阅（顺便拿到标题和条目数）
      fetchHtml(url, 0).then(({ buffer }) => {
        const xml = buffer.toString('utf8');
        const items = parseFeed(xml, url);
        if (!items.length) throw new Error('这个地址里没解析出文章（可能不是 RSS/Atom，或者需要登录）');
        const feedTitle = String(payload.title || '').trim() ||
          (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(xml) || [])[1] ||
          new URL(url).hostname;
        const list = feedList();
        const id = feedId(url);
        const exist = list.find(f => f.id === id);
        const rec = {
          id,
          url,
          title: feedTitle.slice(0, 200),
          limit: Math.max(1, Math.min(MAX_HOT_LIMIT, Number(payload.limit) || (exist ? exist.limit : DEFAULT_HOT_LIMIT))),
          enabled: true,
          intervalSec: exist ? exist.intervalSec : DEFAULT_FEED_INTERVAL,
          addedAt: exist ? exist.addedAt : new Date().toISOString()
        };
        saveFeeds([...(list.filter(f => f.id !== id)), rec]);
        const builtin = findBuiltinSourceForFeed(url);
        send(res, 200, JSON.stringify({
          ok: true, feed: rec, items: items.length,
          duplicateOf: builtin ? { id: builtin.id, name: builtin.name } : null
        }), { 'Content-Type': 'application/json; charset=utf-8' });
      }).catch((e) => {
        send(res, 502, JSON.stringify({ error: friendlyFetchError(e) }), { 'Content-Type': 'application/json; charset=utf-8' });
      });
    });
    return;
  }
  // 批量导入 OPML（RSS 阅读器导出的订阅清单）
  if (req.method === 'POST' && p === '/api/feeds/import') {
    readBody(req, 4 * 1024 * 1024, (err, buf) => {
      if (err) { send(res, 413, JSON.stringify({ error: '请求体太大' }), { 'Content-Type': 'application/json' }); return; }
      let payload = {};
      try { payload = JSON.parse(buf.toString('utf8') || '{}'); } catch { payload = {}; }
      const opml = String(payload.opml || '');
      const items = parseOpml(opml);
      if (!items.length) {
        send(res, 400, JSON.stringify({ error: '这个文件里没找到订阅地址（OPML 里的 xmlUrl）' }), { 'Content-Type': 'application/json; charset=utf-8' });
        return;
      }
      const list = feedList();
      const added = [];
      const dupOfBuiltin = [];
      for (const it of items) {
        const id = feedId(it.url);
        if (list.some(f => f.id === id)) continue;
        const rec = {
          id, url: it.url, title: String(it.title || it.url).slice(0, 200),
          limit: DEFAULT_HOT_LIMIT, enabled: true, intervalSec: DEFAULT_FEED_INTERVAL, addedAt: new Date().toISOString()
        };
        list.push(rec);
        added.push(rec);
        // 记一下哪些和内置热榜重复，前端要提示用户"这个热榜里已经有了"
        const b = findBuiltinSourceForFeed(it.url);
        if (b) dupOfBuiltin.push({ feed: { id: rec.id, title: rec.title }, builtin: { id: b.id, name: b.name } });
      }
      saveFeeds(list);
      send(res, 200, JSON.stringify({
        ok: true, added: added.length, total: list.length, feeds: feedList(),
        duplicates: dupOfBuiltin
      }), { 'Content-Type': 'application/json; charset=utf-8' });
    });
    return;
  }
  const feedM = p.match(/^\/api\/feeds\/([\w-]+)(\/pull)?$/);
  if (feedM) {
    const id = feedM[1];
    const feed = feedById(id);
    if (!feed) { send(res, 404, JSON.stringify({ error: '没有这个订阅' }), { 'Content-Type': 'application/json; charset=utf-8' }); return; }
    if (req.method === 'DELETE' && !feedM[2]) {
      saveFeeds(feedList().filter(f => f.id !== id));
      send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json; charset=utf-8' });
      return;
    }
    if (req.method === 'PUT' && !feedM[2]) {
      readBody(req, 256 * 1024, (err, buf) => {
        if (err) { send(res, 413, JSON.stringify({ error: '请求体太大' }), { 'Content-Type': 'application/json' }); return; }
        let payload = {};
        try { payload = JSON.parse(buf.toString('utf8') || '{}'); } catch { payload = {}; }
        const list = feedList();
        const cur = list.find(f => f.id === id);
        if (!cur) { send(res, 404, JSON.stringify({ error: '没有这个订阅' }), { 'Content-Type': 'application/json' }); return; }
        if (payload.title !== undefined) cur.title = String(payload.title).slice(0, 200);
        if (payload.limit !== undefined) cur.limit = Math.max(1, Math.min(MAX_HOT_LIMIT, Number(payload.limit) || cur.limit));
        if (typeof payload.enabled === 'boolean') cur.enabled = payload.enabled;
        if (payload.intervalSec !== undefined) cur.intervalSec = Math.max(0, Math.min(86400 * 7, Number(payload.intervalSec) || 0));
        saveFeeds(list);
        send(res, 200, JSON.stringify({ ok: true, feed: cur }), { 'Content-Type': 'application/json; charset=utf-8' });
      });
      return;
    }
    if (req.method === 'POST' && feedM[2] === '/pull') {
      readBody(req, 256 * 1024, (err, buf) => {
        if (err) { send(res, 413, JSON.stringify({ error: '请求体太大' }), { 'Content-Type': 'application/json; charset=utf-8' }); return; }
        let payload = {};
        try { payload = JSON.parse(buf.toString('utf8') || '{}'); } catch { payload = {}; }
        hotlist.pull(feedSourceId(id), { limit: Number(payload.limit) || feed.limit }).then(r => {
          send(res, 200, JSON.stringify(r), { 'Content-Type': 'application/json; charset=utf-8' });
        }).catch(e => {
          send(res, 502, JSON.stringify({ error: (e && e.message) || String(e) }), { 'Content-Type': 'application/json; charset=utf-8' });
        });
      });
      return;
    }
  }

// 偏好设置（主题/语言，阅读器与桌面端主进程共用）
  if (req.method === 'GET' && p === '/api/prefs') {
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { /* 无文件用默认 */ }
    send(res, 200, JSON.stringify(publicPrefs(prefs)), { 'Content-Type': 'application/json; charset=utf-8' });
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
      // 热榜来源配置也放在 prefs 里（多端共享），Cookie 只留在服务端
      if (prefs.hotlist && typeof prefs.hotlist === 'object') {
        const hs = (prefs.hotlist.sources && typeof prefs.hotlist.sources === 'object') ? prefs.hotlist.sources : {};
        const cur = hotlistConfig();
        const merged = {};
        for (const s of HOT_SOURCES) {
          const c = hs[s.id] || {};
          const cur0 = cur.sources[s.id];
          merged[s.id] = {
            enabled: typeof c.enabled === 'boolean' ? c.enabled : cur0.enabled,
            // 同理：patch 里没带的字段保持原值。以前这里 `Number(undefined) || 0`
            // 会把「新加的来源」或「前端没回传的字段」直接清零 —— limit 变 0 篇、
            // 自动拉取被关掉，都是这么来的。
            limit: c.limit == null ? cur0.limit : Math.max(1, Math.min(MAX_HOT_LIMIT, Number(c.limit) || cur0.limit)),
            intervalSec: c.intervalSec == null ? cur0.intervalSec
              : Math.max(0, Math.min(86400 * 7, Number(c.intervalSec) || 0)),
            // ⚠️ Cookie 只认 PUT /api/sources/:id 写进来的值。
            // 前端 /api/prefs 里带的是**页面加载时的旧快照**，要是照单全收，
            // 用户刚存好的 Cookie 会被下一次「保存偏好」覆盖成空 —— 踩过一次。
            cookie: cur0.cookie
          };
        }
        clean.hotlist = { sources: merged };
        saveHotlistConfig({ sources: merged });
      } else {
        const old = loadPrefsRaw();
        if (old.hotlist) clean.hotlist = old.hotlist;
      }
      try { fs.writeFileSync(PREFS_FILE, JSON.stringify(clean, null, 2)); } catch { /* 只读环境忽略 */ }
      syncServerCache = null;
      send(res, 200, JSON.stringify(Object.assign({}, publicPrefs(clean), { syncServer: ensureSyncServer() })), { 'Content-Type': 'application/json; charset=utf-8' });
      restartSyncTimer();
      // 广播给其他端：主题/语言/字体等外观设置实时互相同步（不重载页面，只应用）
      // 注意走 publicPrefs：SSE 是明文的，别把热榜 Cookie 顺带发出去
      broadcastPrefs(publicPrefs(clean));
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
        extension: {
          lastSeen: extState.lastSeen,
          version: extState.version,
          online: extensionOnline(),
          connected: extSockets > 0,
          bundledVersion: bundledExtVersion,
          // 浏览器里跑的扩展比安装包里的旧 → 需要去扩展页点「重新加载」
          outdated: !!(extState.version && bundledExtVersion && extState.version !== bundledExtVersion)
        },
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
  //
  // 走流式：以前是在内存里拼完整份 zip 再发，库上到 GB 级直接把进程撑死
  // （Node 单个 Buffer 上限 2GB，还没到上限就先 OOM 了）。
  if (req.method === 'GET' && p === '/api/export.zip') {
    const list = loadIndex();
    const entries = [{ name: 'index.json', data: Buffer.from(JSON.stringify(list, null, 2), 'utf8') }];
    let skipped = 0;
    for (const meta of list) {
      const fp = path.join(DATA_DIR, meta.file || (meta.id + '.html'));
      let st;
      try { st = fs.statSync(fp); } catch { skipped++; continue; }   // 索引里有、盘上没了
      if (!st.isFile()) { skipped++; continue; }
      entries.push({ name: 'pages/' + meta.id + '.html', path: fp });
    }
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      // 不设 Content-Length（边算边发），用 chunked：浏览器照样能存下来
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('网页收藏备份-' + stamp + '.zip')}`,
      'Cache-Control': 'no-store'
    });
    zipStoreStream(res, entries)
      .then(bytes => {
        res.end();   // 流式写完后必须收尾，否则客户端会一直等（chunked 没有结束标记）
        log('exported backup zip, pages =', entries.length - 1,
          skipped ? ('(skipped ' + skipped + ' missing)') : '', bytes + ' bytes');
      })
      .catch(e => {
        // 已经开始发了，改不了状态码，只能掐掉连接让客户端知道备份不完整
        log('export zip FAILED:', e && e.message ? e.message : e);
        res.destroy();
      });
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
  // 手机端收藏：只给一个链接，由服务端去抓。
  // 手机上没有浏览器扩展那套「抓整页 DOM」的能力（Safari/微信都不给），所以这条路由是
  // 手机端唯一可行的入口：微信里复制链接 → App 里粘贴 → 服务端抓 → 立刻出现在所有端。
  if (req.method === 'POST' && p === '/api/pages/from-url') {
    readBody(req, 1024 * 1024, (err, buf) => {
      const bad = (code, msg) => send(res, code, JSON.stringify({ error: msg }), { 'Content-Type': 'application/json; charset=utf-8' });
      if (err) return bad(413, '请求体太大');
      let payload;
      try { payload = JSON.parse(buf.toString('utf8')); }
      catch { return bad(400, '参数格式不对'); }
      const raw = String((payload && payload.url) || '').trim();
      if (!/^https?:\/\//i.test(raw)) return bad(400, '请填 http:// 或 https:// 开头的网址');

      fetchHtml(raw, 0).then(({ buffer, contentType, finalUrl }) => {
        const looksHtml = /html|xml/i.test(contentType) ||
          /^\s*(<!doctype|<html)/i.test(buffer.slice(0, 512).toString('utf8'));
        if (!looksHtml) return bad(415, '这个链接不是网页（可能是 PDF、图片或文件下载）');
        let html = decodePage(buffer, contentType);
        if (!html || html.length < 200) return bad(502, '抓到的页面内容为空');

        // 先判标题，顺手用"有没有标题"判断抓回来的是不是拦截页：
        // 微信风控时会返回「环境异常，完成验证后即可继续访问」，正文空、标题也是垃圾词。
        // 这种页面存进去，用户点开只能看到一张验证图，还以为是 App 坏了——宁可当场报错。
        const minedTitle = pageTitle(html, finalUrl);
        const inputTitle = String((payload && payload.title) || '').trim();
        const manualOk = usableTitle(inputTitle, finalUrl);
        if (!minedTitle && !manualOk && looksLikeGatePage(html)) {
          return bad(502, '对方网站要求人工验证，抓到的是一张验证页。稍后再试，或者换用浏览器扩展收藏');
        }

        // 注入 <base>：原始 HTML 里的相对路径（图片/样式）要靠它解析回原站，
        // 否则阅读页里全是裂图。绝对地址的图片后面还会被 /p/:id 改写成 /api/img 代理。
        if (!/<base[\s>]/i.test(html)) {
          const baseTag = '<base href="' + finalUrl.replace(/"/g, '&quot;') + '">';
          if (/<head[^>]*>/i.test(html)) html = html.replace(/<head([^>]*)>/i, (mm, a) => '<head' + a + '>' + baseTag);
          else html = baseTag + html;
        }
        // 同一篇文章存过一次就别再存一份：链接可能带了 utm_source 之类的追踪参数，
        // 或者末尾多个斜杠、多了 www —— 归一化之后是同一篇。
        const dup = findPageByUrl(finalUrl);
        if (dup) {
          return send(res, 200, JSON.stringify({
            id: dup.id, title: dup.title, url: dup.url, savedAt: dup.savedAt,
            size: dup.size, duplicate: true
          }), { 'Content-Type': 'application/json; charset=utf-8' });
        }
        const meta = persistPage({
          html,
          // 标题：用户手填的优先，其次从页面里挖（og:title → <title> → 微信 h1 → 任意 h1）。
          // 实在挖不到才退回网址——显示网址至少点进去能看出来源，比"未命名"强。
          title: manualOk ? inputTitle.slice(0, 300) : (minedTitle || finalUrl),
          url: finalUrl,
          platform: String((payload && payload.platform) || 'mobile'),
          format: 'html',
          engine: 'from-url'
        }, { touchExtension: false });
        send(res, 200, JSON.stringify({
          id: meta.id, title: meta.title, url: meta.url, savedAt: meta.savedAt, size: meta.size
        }), { 'Content-Type': 'application/json; charset=utf-8' });
      }).catch((e) => bad(502, friendlyFetchError(e)));
    });
    return;
  }

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

      const meta = persistPage(payload, { touchExtension: true });
      send(res, 200, JSON.stringify({ id: meta.id, savedAt: meta.savedAt }), { 'Content-Type': 'application/json; charset=utf-8' });
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
    // 用异步读文件：以前这里是 readFileSync 循环，库一大（热榜天天进来）一次搜索
    // 就把事件循环堵住好几秒——期间所有端都卡着，连 SSE 心跳都发不出去。
    (async () => {
      const list = loadIndex().sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      const results = [];
      const strip = (s) => s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      for (const meta of list.slice(0, 500)) {
        let snippet = '';
        let hit = (meta.title || '').toLowerCase().includes(q) || (meta.url || '').toLowerCase().includes(q);
        if (!hit && meta.size < 30 * 1024 * 1024) {
          try {
            const raw = strip(await fs.promises.readFile(path.join(DATA_DIR, meta.file), 'utf8'));
            const i = raw.toLowerCase().indexOf(q);
            if (i >= 0) { hit = true; snippet = raw.slice(Math.max(0, i - 40), i + 80).trim(); }
          } catch { /* 文件损坏/已删则跳过 */ }
        }
        if (hit) results.push({ id: meta.id, title: meta.title, savedAt: meta.savedAt, platform: meta.platform, snippet });
        if (results.length >= 50) break;
      }
      send(res, 200, JSON.stringify(results), { 'Content-Type': 'application/json; charset=utf-8' });
    })().catch((e) => {
      send(res, 500, JSON.stringify({ error: String((e && e.message) || e) }), { 'Content-Type': 'application/json; charset=utf-8' });
    });
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
    // 先瘦身再代理，省掉为脚本里的网址做无用替换
    html = slimPageForReading(html);
    if (/<img[^>]+src="https?:|url\(\s*['"]?https?:/i.test(html)) {
      const proxyBase = '/api/img?r=' + encodeURIComponent(meta.url || '') + '&u=';
      html = html
        .replace(/(<img[^>]+src\s*=\s*["'])(https?:\/\/[^"']+)(["'])/gi, (mm, a, u, b) => a + proxyBase + encodeURIComponent(u) + b)
        .replace(/(url\(\s*["']?)(https?:\/\/[^)"']+)(["']?\s*\))/gi, (mm, a, u, b) => a + proxyBase + encodeURIComponent(u) + b);
    }
    html = injectPageCsp(html);
    send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    return;
  }

  send(res, 404, 'not found');
});

// ---- 扩展长连接（WebSocket）----
// 扩展连上/断开都立刻更新状态并推给界面；扩展断线后自己会指数退避重连，
// 所以「客户端重启后扩展连不上」的问题就消失了：客户端一上线，扩展几秒内自己接回来。
const extWs = attachWebSocket(server, {
  path: '/ws/ext',
  onOpen(client) {
    extSockets++;
    if (!extState.wsSeen) { extState.wsSeen = true; }
    touchExtension(client.version);
    broadcastExt();
  },
  onMessage(client, text) {
    touchExtension(client.version);
  },
  onClose() {
    extSockets = Math.max(0, extSockets - 1);
    broadcastExt();
  }
});

// ---------- 启动时修复「标题是个网址」的历史条目 ----------
// 1.5.3 及更早抓微信文章拿不到标题，只能把网址当标题存。用户升级/重装后
// 数据目录还在，老条目依旧挂着一长串网址，看起来像"修复没生效"。
// 每次启动做一遍保守修复：只有现有标题明显是垃圾（usableTitle 不过关），
// 且能从存档 HTML 里挖出更好的，才改写 index.json；存档文件本身不动。
function repairTitles() {
  let list;
  try { list = loadIndex(); } catch { return; }
  if (!Array.isArray(list)) return;
  let fixed = 0, noFile = 0;
  for (const m of list) {
    if (!m || !m.id) continue;
    const cur = String(m.title || '').trim();
    if (usableTitle(cur, m.url) && cur !== 'Untitled') continue;
    let html = null;
    try { html = fs.readFileSync(path.join(DATA_DIR, m.file || (m.id + '.html')), 'utf8'); }
    catch { noFile++; continue; }
    const mined = pageTitle(html, m.url);
    if (mined && mined !== cur) { m.title = mined.slice(0, 300); fixed++; }
  }
  if (!fixed) return;
  try {
    const tmp = INDEX_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, INDEX_FILE);
    log(`标题修复：${fixed} 条"网址标题"已从存档补回` +
        (noFile ? `（另有 ${noFile} 条存档文件缺失，修不了）` : ''));
  } catch (e) {
    log('标题修复写入失败：', (e && e.message) || e);
  }
}

server.listen(PORT, () => {
  console.log(`网页收藏 sync server running at http://localhost:${PORT}`);
  repairTitles();       // 补回历史条目的真标题（幂等，没得修就静默）
  ensureSyncServer();   // 确保本机作为同步源的令牌已生成
  restartSyncTimer();   // 按保存的同步配置恢复轮询
  restartHotlistTimer(); // 按保存的热榜配置恢复定时拉取
});
