'use strict';

// 同步目标适配层。
//
// 一个"同步目标"可以是：
//   - webdav : 用户自己的网盘（坚果云 / Nextcloud / 群晖…）
//   - peer   : 另一台跑着「网页收藏」的机器（家里 NAS、办公室电脑…）
//
// 之所以做成适配层，是因为"多端同步"的本质只是三件事：
//   把远端索引读下来 / 把本地缺的页面拉下来 / 把远端缺的页面推上去。
//   至于远端是 WebDAV 目录还是 PageVault 服务，差异全部收敛到下面两个类。
//
// 统一接口（SyncEngine 只认这些）：
//   ensure()            准备远端（建目录等）
//   getIndex()          远端索引（meta 数组）
//   putIndex(list)      覆盖远端索引
//   getDeletions()      远端删除记录 [{id, deletedAt}]
//   putDeletions(list)  覆盖/合并远端删除记录
//   listIds()           远端已有页面 id 集合（孤儿自愈 + 跳过重复推送）
//   getPage(id)         html 字符串 | null
//   putPage(id, html)   写入
//   delPage(id)         删除
//   putMeta(meta)       只同步元数据（星标等）；无此概念的实现可为空操作
//   test()              { ok, message, ... }

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { WebDAV, netError } = require('./webdav');
const dnsx = require('./dnsx');

const TIMEOUT = 45000;

// ---------------------------------------------------------------- 通用 HTTP
// 和 webdav.js 一样走 dnsx（系统 DNS 挂了自动 DoH），并支持多地址重试。
// 对端通常是局域网 IP，这一步其实很快，但保留兜底能覆盖「域名 + VPN DNS 坏掉」的情况。
function httpRequest(urlStr, opts) {
  opts = opts || {};
  let u;
  try { u = new URL(urlStr); } catch { return Promise.reject(new Error('地址格式不对：' + urlStr)); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return Promise.reject(new Error('仅支持 http/https 地址'));
  }
  const client = u.protocol === 'https:' ? https : http;

  return (async () => {
    const { addrs } = await dnsx.resolveHost(u.hostname);
    if (!addrs.length) throw netError(new Error('getaddrinfo ENOTFOUND ' + u.hostname), u.host);
    let lastErr = null;
    for (const a of addrs) {
      try {
        return await once(a);
      } catch (e) {
        lastErr = e;
        if (!/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|EADDRNOTAVAIL|请求超时|socket hang up|ECONNRESET|setServername/i.test(e && e.message || '')) throw e;
      }
    }
    throw netError(lastErr, u.host);
  })();

  function once(addr) {
    return new Promise((resolve, reject) => {
      const headers = Object.assign({}, opts.headers || {});
      if (opts.body) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
      const r = client.request(u.origin + u.pathname + u.search, {
        method: opts.method || 'GET',
        headers,
        agent: false, // 同 webdav.js：逐地址重试时不要复用可能已销毁的连接
        lookup: dnsx.pinnedLookup(addr.address, addr.family)
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        }));
      });
      r.on('error', e => reject(new Error((e && e.message) ? e.message : String(e))));
      r.setTimeout(opts.timeout || TIMEOUT, () => r.destroy(new Error('请求超时（' + Math.round((opts.timeout || TIMEOUT) / 1000) + 's）')));
      if (opts.body) r.write(opts.body);
      r.end();
    });
  }
}

// ---------------------------------------------------------------- WebDAV 目标
class WebdavProvider {
  constructor(t) {
    this.type = 'webdav';
    this.name = t.name || 'WebDAV';
    const base = String(t.url || '').replace(/\/+$/, '');
    const dir = String(t.dir || 'pagevault').replace(/^\/+|\/+$/g, '');
    this.dav = new WebDAV(base + '/' + dir);
    this.dav.auth(t.user, t.pass);
  }

  async ensure() { await this.dav.ensureDir(''); }

  async getIndex() {
    const raw = await this.dav.get('index.json');
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw.toString('utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch { throw new Error('远端 index.json 解析失败（文件可能损坏）'); }
  }
  async putIndex(list) {
    await this.dav.put('index.json', Buffer.from(JSON.stringify(list, null, 2), 'utf8'));
  }

  async getDeletions() {
    const raw = await this.dav.get('deletions.json');
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw.toString('utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  async putDeletions(list) {
    await this.dav.put('deletions.json', Buffer.from(JSON.stringify(list, null, 2), 'utf8'));
  }

  async listIds() {
    const entries = await this.dav.list('pages');
    const ids = new Set();
    for (const e of entries) {
      if (e.isDir) continue;
      if (e.name.endsWith('.html')) ids.add(e.name.slice(0, -5));
    }
    return ids;
  }

  async getPage(id) {
    const buf = await this.dav.get('pages/' + id + '.html');
    return buf ? buf.toString('utf8') : null;
  }
  async putPage(id, html) {
    await this.dav.put('pages/' + id + '.html', Buffer.from(html, 'utf8'));
  }
  async delPage(id) { await this.dav.del('pages/' + id + '.html'); }

  // WebDAV 的星标随 index.json 全量推送，无需单独接口
  async putMeta() { /* no-op */ }

  async test() { return this.dav.test(); }
}

// ---------------------------------------------------------------- PageVault 对端目标
// 对端提供的最小 API（见 server.js 的 /api/sync/*）：manifest / page / meta / deletions / probe。
class PeerProvider {
  constructor(t) {
    this.type = 'peer';
    this.base = String(t.url || '').replace(/\/+$/, '');
    this.token = String(t.token || '');
    this.name = t.name || this.base;
    this._manifest = null;
  }

  _headers(extra) {
    const h = Object.assign({ Accept: 'application/json', 'User-Agent': 'PageVault-Sync/1' }, extra || {});
    if (this.token) h.Authorization = 'Bearer ' + this.token;
    return h;
  }

  async _call(method, path, body, raw) {
    const res = await httpRequest(this.base + path, {
      method,
      headers: this._headers(body ? { 'Content-Type': 'application/json' } : null),
      body: body ? JSON.stringify(body) : null,
      timeout: raw ? 90000 : TIMEOUT
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('对端拒绝访问：同步令牌不对（在对方机器的「本机作为同步源」里复制令牌）');
    }
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      let msg = '';
      try { msg = JSON.parse(res.body.toString('utf8')).error || ''; } catch { /* 非 JSON */ }
      throw new Error('对端 HTTP ' + res.status + (msg ? '：' + msg : ''));
    }
    return res;
  }

  async _json(method, path, body) {
    const res = await this._call(method, path, body);
    if (!res) return null;
    try { return JSON.parse(res.body.toString('utf8')); } catch { throw new Error('对端返回的不是 JSON'); }
  }

  async ensure() { /* 对端无需准备 */ }

  async getIndex() {
    const m = await this._json('GET', '/api/sync/manifest');
    // 404 = 对方没有对端接口（多半是 1.1.0 以前的版本）。
    // 这里必须报错，不能当成"远端是空的"——否则会把本地全量推过去。
    if (!m) throw new Error('对方没有对端同步接口（版本可能低于 1.1.0），请先升级那台机器');
    this._manifest = m;
    return Array.isArray(m.pages) ? m.pages : [];
  }
  async putIndex() { /* 对端自己维护索引，页面写入时会更新 */ }

  async getDeletions() {
    if (!this._manifest) await this.getIndex();
    return Array.isArray(this._manifest.deletions) ? this._manifest.deletions : [];
  }
  async putDeletions(list) {
    // 只把本地新增的 tombstone 推过去，远端已有的合并在服务端完成
    await this._call('POST', '/api/sync/deletions', list);
  }

  async listIds() {
    if (!this._manifest) await this.getIndex();
    return new Set((this._manifest.pages || []).map(p => p.id));
  }

  async getPage(id) {
    const res = await this._call('GET', '/api/sync/page/' + encodeURIComponent(id));
    return res ? res.body.toString('utf8') : null;
  }
  async putPage(id, html, meta) {
    const headers = { 'Content-Type': 'text/html; charset=utf-8' };
    if (meta) headers['X-PV-Meta'] = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');
    const res = await httpRequest(this.base + '/api/sync/page/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: this._headers(headers),
      body: html,
      timeout: 120000
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('对端拒绝写入：同步令牌不对');
    }
    if (res.status === 413) throw new Error('对端拒收：单页太大');
    if (res.status < 200 || res.status >= 300) throw new Error('对端写入失败 HTTP ' + res.status);
  }
  async delPage(id) {
    await this._call('DELETE', '/api/sync/page/' + encodeURIComponent(id));
  }
  async putMeta(meta) {
    if (!meta || !meta.id) return;
    await this._call('PUT', '/api/sync/meta/' + encodeURIComponent(meta.id), {
      starred: !!meta.starred,
      starredAt: meta.starredAt || '',
      title: meta.title || '',
      url: meta.url || ''
    });
  }

  async test() {
    // probe 要鉴权，能顺便验证令牌；令牌错会抛 401
    const r = await this._json('GET', '/api/sync/probe');
    if (!r) return { ok: false, status: 404, message: '对方没有对端同步接口（版本可能低于 1.1.0），请先升级那台机器' };
    if (!r.ok) return { ok: false, status: 200, message: '对端返回异常' };
    return {
      ok: true,
      status: 200,
      message: '连接成功',
      info: { version: r.version, platform: r.platform, count: r.count, name: r.name }
    };
  }
}

function createProvider(target) {
  if (!target) throw new Error('缺少目标配置');
  if (target.type === 'peer') return new PeerProvider(target);
  if (!target.url) throw new Error('缺少服务器地址');
  return new WebdavProvider(target);
}

module.exports = { createProvider, WebdavProvider, PeerProvider, httpRequest };
