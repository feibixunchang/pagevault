'use strict';

/**
 * 热榜引擎：定时（或手动）去各家的榜单页拉一批文章，存进本地库。
 *
 * 流程：拉榜单 → 解析出文章链接 → 逐条抓原文 → 抽正文 → 存盘。
 * 抽正文用的是 htmlish.js（自己写的极简抽取，服务端要保持零依赖）；
 * 抽不出来就退回「整页去掉脚本/导航/页脚」的版本，保证不会比原网页更差。
 *
 * 已经存过的链接会跳过（按 URL 比对），所以定时拉取不会重复灌库。
 */

const http = require('http');
const https = require('https');
const { SOURCES, getSource, parseList, UA_DESKTOP } = require('./sources.js');

// 备选 UA：有些站点的 WAF 会把「完整 Chrome UA 但没有 client hints」的请求判成机器人
// （阮一峰就是：长 UA 403，短 UA 200）。403 时换一个 UA 再试一次。
const UA_ALT = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const { extractArticle, stripNoiseOnly } = require('./htmlish.js');

const TICK_MS = 60 * 1000;

/** 抓一个 URL 的原始文本（跟随重定向、不压缩） */
function fetchText(url, headers, timeoutMs, ua, hops) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('网址格式不对')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('只支持 http/https'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, {
      headers: Object.assign({
        'User-Agent': ua || UA_DESKTOP,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity'
      }, headers || {}),
      timeout: timeoutMs || 25000
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        // 跳转次数上限：站点配错/互相跳时不会无限递归把进程挂死
        if ((hops || 0) >= 6) return reject(new Error('重定向次数太多'));
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch { return reject(new Error('重定向地址不对')); }
        // 带上 ua 和 hops：之前漏了，换过 UA 的请求一跳转就退回默认 UA
        return fetchText(next, headers, timeoutMs, ua, (hops || 0) + 1).then(resolve, reject);
      }
      if (code >= 400) {
        res.resume();
        // 403 多半是 UA 被判成机器人，换一个 UA 再试一次
        if (code === 403 && (!ua || ua !== UA_ALT)) {
          return fetchText(url, headers, timeoutMs, UA_ALT, hops).then(resolve, reject);
        }
        return reject(new Error('对方返回 HTTP ' + code));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 12 * 1024 * 1024) { req.destroy(); reject(new Error('页面太大')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        text: Buffer.concat(chunks).toString('utf8'),
        finalUrl: u.toString(),
        contentType: String(res.headers['content-type'] || '')
      }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => reject(e));
  });
}

class HotListEngine {
  constructor(hooks) {
    this.hooks = hooks || {};
    this.timer = null;
    this.states = new Map();   // sourceId -> { running, nextDue, lastPull, lastResult }
    this._cfg = null;
  }

  state(id) {
    if (!this.states.has(id)) {
      this.states.set(id, { running: false, nextDue: 0, lastPull: 0, lastResult: null });
    }
    return this.states.get(id);
  }

  /** 拉一个来源的榜单（只解析，不存） */
  async fetchList(source, cfg) {
    const headers = Object.assign({}, source.headers || {});
    const cookie = cfg && cfg.cookie ? String(cfg.cookie).trim() : '';
    if (source.needsCookie) {
      if (!cookie) throw new Error(source.cookieHint || '这个来源需要 Cookie');
      headers.Cookie = cookie;
    }
    let r;
    try {
      r = await fetchText(source.url, headers);
    } catch (e) {
      // 登录态来源最常见的问题是 Cookie 过期/粘错了，要说人话
      const msg = (e && e.message) || String(e);
      if (source.needsCookie && /HTTP 401|403/.test(msg)) {
        throw new Error('Cookie 无效或已过期（' + msg + '），请重新复制一份');
      }
      throw e;
    }
    const ctx = {
      fetchJSON: async (url) => {
        const j = await fetchText(url, headers);
        try { return JSON.parse(j.text); } catch { return null; }
      }
    };
    // parseList 一定是 Promise（有些来源要异步展开每一条）
    return parseList(source, r.text, ctx);
  }

  /**
   * 拉一个来源并存盘。
   * @param {string} sourceId
   * @param {object} opts { limit, cookie, force }
   */
  async pull(sourceId, opts) {
    const o = opts || {};
    const source = getSource(sourceId);
    if (!source) throw new Error('没有这个热榜来源');
    const st = this.state(sourceId);
    if (st.running) throw new Error('正在拉取中，稍等一下');
    st.running = true;
    const started = Date.now();
    const result = { sourceId, name: source.name, items: [], saved: [], skipped: [], errors: [], startedAt: started };
    try {
      const cfg = { cookie: o.cookie !== undefined ? o.cookie : this._cfgOf(sourceId).cookie };
      // 本次拉取实际用的 Cookie：请求里带的优先，否则用配置里存的。
      // ⚠️ 必须往下传给 _saveOne —— 抓原文也要它，知乎对未登录请求一律 403。
      const useCookie = String((cfg.cookie || '')).trim();
      const items = await this.fetchList(source, cfg);
      result.items = items.slice(0, 50);
      const limit = Math.max(1, Math.min(20, Number(o.limit) || this._cfgOf(sourceId).limit || 5));
      const known = this.hooks.listUrls ? this.hooks.listUrls() : new Set();

      // 只处理前 limit 条「还没存过」的（已存过的直接算跳过）
      const todo = [];
      for (const item of result.items) {
        if (todo.length >= limit) break;
        if (!item.url) continue;
        if (known.has(item.url)) { result.skipped.push({ title: item.title, url: item.url, why: '已收藏' }); continue; }
        todo.push(item);
      }

      // 并发抓（串行的话 5 篇要一分多钟，太慢了）
      const CONCURRENCY = 4;
      let cursor = 0;
      const worker = async () => {
        while (cursor < todo.length) {
          const item = todo[cursor++];
          try {
            const saved = await this._saveOne(source, item, useCookie);
            if (saved) result.saved.push(saved);
            else result.skipped.push({ title: item.title, url: item.url, why: '抓取失败' });
          } catch (e) {
            if (e && e.skip) {
              result.skipped.push({ title: item.title, url: item.url, why: '没有正文' });
            } else {
              result.errors.push({ title: item.title, url: item.url, error: (e && e.message) || String(e) });
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
      result.ok = true;
    } catch (e) {
      result.ok = false;
      result.errors.push({ error: (e && e.message) || String(e) });
    } finally {
      st.running = false;
      st.lastPull = Date.now();
      st.lastResult = {
        ok: result.ok !== false,
        saved: result.saved.length,
        skipped: result.skipped.length,
        errors: result.errors.length,
        at: st.lastPull
      };
      result.finishedAt = Date.now();
      result.durationMs = result.finishedAt - started;
    }
    return result;
  }

  async _saveOne(source, item, cookie) {
    const hooks = this.hooks;
    // 登录态来源（知乎）看正文也要 Cookie：榜单是带着 Cookie 拉成功的，
    // 抓原文却裸奔 → 每篇 403 挑战页 → "没有新文章"，用户一头雾水。
    // 只在原文和榜单同域时才带，避免 Cookie 跟着重定向泄漏给别的站。
    const headers = { Referer: safeOrigin(item.url) };
    const ck = String(cookie || (this._cfgOf(source.id) || {}).cookie || '').trim();
    if (source.needsCookie && ck) {
      try {
        if (new URL(item.url).origin === new URL(source.url).origin) headers.Cookie = ck;
      } catch { /* 网址不合法就不带 */ }
    }
    let page;
    try {
      page = await fetchText(item.url, headers, 15000);
    } catch (e) {
      throw new Error('抓原文失败：' + ((e && e.message) || e));
    }
    // 榜单条目自带标题（来自官方接口）就用它的；没有才现从原文里挖。
    // 传 url 进去是为了让 titles.js 能排掉"标题其实是个网址"这种假标题。
    const title = String(item.title || '').trim() ||
      (hooks.pageTitle ? hooks.pageTitle(page.text, page.finalUrl) : item.url);
    let html = null;
    let extracted = false;
    try {
      const art = extractArticle(page.text, { title, baseUrl: page.finalUrl, selectors: source.selectors });
      if (art) { html = art.html; extracted = true; }
    } catch { /* 抽不出来就退回整页去噪版 */ }
    if (!html) {
      // 有些来源（论坛帖、知乎回答）抽不到正文就等于没内容，
      // 存下来是个空页面，不如跳过 —— 但要告诉调用方"这篇不要"
      if (source.requireContent) {
        const e = new Error('抽不到正文（页面本身可能就没有正文）');
        e.skip = true;
        throw e;
      }
      html = stripNoiseOnly(page.text, { title, baseUrl: page.finalUrl });
    }

    const meta = hooks.persistPage({
      html,
      title,
      url: page.finalUrl || item.url,
      platform: source.id,
      format: 'html',
      engine: 'hotlist:' + source.id
    }, { touchExtension: false });
    return { id: meta.id, title: meta.title, url: meta.url, extracted, summary: item.summary || '' };
  }

  // ---------- 配置 ----------

  _cfgOf(sourceId) {
    const all = (this._cfg && this._cfg.sources) || {};
    const c = all[sourceId] || {};
    return {
      enabled: c.enabled !== false,
      limit: Number(c.limit) || 5,
      intervalSec: Number(c.intervalSec) || 0,
      cookie: c.cookie || ''
    };
  }

  setConfig(cfg) {
    this._cfg = cfg || { sources: {} };
    // 给每个开了自动拉取的来源排好下次时间。
    // 以前 nextDue 初始是 0，_tick 一上来就"到期"——于是客户端/NAS 每重启一次，
    // 所有来源会被立刻全量拉一遍。现在按"上次拉取 + 间隔"算，重启不会额外拉。
    const now = Date.now();
    for (const id of Object.keys(this._cfg.sources || {})) {
      const c = this._cfg.sources[id] || {};
      const iv = Number(c.intervalSec) || 0;
      if (iv <= 0) continue;
      const st = this.state(id);
      if (st.nextDue) continue;   // 已经在排期里就别重置，否则每次存偏好都会往后推
      st.nextDue = st.lastPull ? st.lastPull + iv * 1000 : now + iv * 1000;
      if (st.nextDue < now) st.nextDue = now + 1000;  // 停机期间错过了，一分钟内补一次
    }
    const anyTimed = Object.keys(this._cfg.sources || {}).some(id => {
      const c = this._cfg.sources[id];
      return c && c.enabled !== false && Number(c.intervalSec) > 0;
    });
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (anyTimed) {
      this.timer = setInterval(() => this._tick(), TICK_MS);
      if (this.hooks.log) this.hooks.log('hotlist scheduler started');
    }
  }

  _tick() {
    const now = Date.now();
    const sources = (this._cfg && this._cfg.sources) || {};
    for (const id of Object.keys(sources)) {
      const c = sources[id] || {};
      if (c.enabled === false) continue;
      const iv = Number(c.intervalSec) || 0;
      if (iv <= 0) continue;
      const st = this.state(id);
      if (st.running) continue;
      if (now < st.nextDue) continue;
      st.nextDue = now + Math.max(300, iv) * 1000;
      this.pull(id, { limit: c.limit, cookie: c.cookie }).then(r => {
        if (this.hooks.onPulled) this.hooks.onPulled(r);
      }).catch(() => { /* pull 内部已经记录错误 */ });
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 给前端看的状态 */
  status() {
    return SOURCES.map(s => {
      const c = this._cfgOf(s.id);
      const st = this.state(s.id);
      return {
        id: s.id,
        name: s.name,
        emoji: s.emoji,
        desc: s.desc,
        needsCookie: !!s.needsCookie,
        cookieHint: s.cookieHint || '',
        hasCookie: !!c.cookie,
        enabled: c.enabled,
        limit: c.limit,
        intervalSec: c.intervalSec,
        running: st.running,
        lastPull: st.lastPull,
        lastResult: st.lastResult
      };
    });
  }
}

function safeOrigin(url) {
  try { return new URL(url).origin + '/'; } catch { return ''; }
}

module.exports = { HotListEngine, fetchText, SOURCES };
