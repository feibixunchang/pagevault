'use strict';

// PageVault sync server — Node zero-dependency.
// Stores full captured pages as self-contained HTML files + a metadata index.
// This same server becomes the Docker "end" later; the data format stays identical.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8731;
const ROOT = __dirname;
const DATA_ROOT = process.env.PAGEVAULT_DATA || path.join(ROOT, 'data');
const DATA_DIR = path.join(DATA_ROOT, 'pages');
const INDEX_FILE = path.join(DATA_ROOT, 'index.json');
const PREFS_FILE = path.join(DATA_ROOT, 'prefs.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 80 * 1024 * 1024; // 80MB cap per page

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(INDEX_FILE)) fs.writeFileSync(INDEX_FILE, '[]');

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
      try { fs.writeFileSync(PREFS_FILE, JSON.stringify(clean, null, 2)); } catch { /* 只读环境忽略 */ }
      send(res, 200, JSON.stringify(clean), { 'Content-Type': 'application/json; charset=utf-8' });
    });
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
      fs.writeFileSync(path.join(DATA_DIR, meta.file), html, 'utf8');
      const list = loadIndex();
      list.push(meta);
      saveIndex(list);
      send(res, 200, JSON.stringify({ id, savedAt: meta.savedAt }), { 'Content-Type': 'application/json; charset=utf-8' });
      broadcastSaved(meta);
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
    saveIndex(list);
    broadcastMeta({ type: 'starred', id, starred: !!meta.starred });
    send(res, 200, JSON.stringify({ ok: true, starred: !!meta.starred }), { 'Content-Type': 'application/json; charset=utf-8' });
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
    send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json; charset=utf-8' });
    broadcastDeleted(id);
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
});
