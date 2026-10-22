'use strict';

// 极简 WebDAV 客户端（零依赖）：PROPFIND / GET / PUT / DELETE / MKCOL。
// 用途：把「网页收藏」的库同步到用户自己的 WebDAV 账号（坚果云 / Nextcloud / 群晖 /
// 自建 Apache 等）——同一账号登录多端即可互相同步，不依赖我们部署任何服务器。

const http = require('http');
const https = require('https');
const { URL } = require('url');

const TIMEOUT = 45000;

class WebDAVError extends Error {
  constructor(status, method, path) {
    super(`WebDAV ${method} ${path} -> HTTP ${status}`);
    this.status = status;
  }
}

class WebDAV {
  // base 例：https://dav.jianguoyun.com/dav/pagevault
  constructor(base) {
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https 地址');
    this.client = u.protocol === 'https:' ? https : http;
    this.origin = u.origin;
    this.basePath = u.pathname.replace(/\/+$/, '');
  }

  auth(user, pass) {
    this.authHeader = 'Basic ' + Buffer.from(String(user) + ':' + String(pass), 'utf8').toString('base64');
  }

  // relPath: '' = 根目录；'pages/a.html' = 相对路径
  req(method, relPath, opts) {
    opts = opts || {};
    const self = this;
    const clean = String(relPath || '').replace(/^\/+/, '');
    const urlPath = self.basePath + (clean ? '/' + clean : '');
    const headers = {
      Authorization: self.authHeader || '',
      Depth: opts.depth || '0'
    };
    if (opts.contentType) headers['Content-Type'] = opts.contentType; // undefined 会让 Node 抛错
    Object.assign(headers, opts.headers || {});
    return new Promise((resolve, reject) => {
      const r = self.client.request(self.origin + urlPath, { method, headers }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        }));
      });
      r.on('error', e => reject(new Error('网络错误：' + (e && e.message ? e.message : e))));
      r.setTimeout(TIMEOUT, () => r.destroy(new Error('请求超时（' + TIMEOUT / 1000 + 's）')));
      if (opts.body) r.write(opts.body);
      r.end();
    });
  }

  // 连接测试：PROPFIND 根目录。返回 { ok, status, message }
  async test() {
    const r = await this.req('PROPFIND', '', {
      depth: '0',
      contentType: 'application/xml',
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'
    });
    if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, message: '认证失败：请检查账号和密码（部分服务需要专用密码/授权码）' };
    if (r.status === 404) return { ok: false, status: r.status, message: '目录不存在：请先创建远端目录，或检查同步目录名' };
    if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, message: '连接成功' };
    return { ok: false, status: r.status, message: '服务器返回 HTTP ' + r.status };
  }

  // 确保远端目录存在（MKCOL，409 时逐级创建）
  async ensureDir(relPath) {
    const parts = String(relPath || '').split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      const r = await this.req('MKCOL', cur);
      if (r.status >= 200 && r.status < 300) continue;   // 创建成功
      if (r.status === 405) continue;                     // 已存在（MKCOL 对已有目录返回 405）
      if (r.status === 409) { await this.ensureDir(cur.split('/').slice(0, -1).join('/')); continue; }
      if (r.status >= 400) throw new WebDAVError(r.status, 'MKCOL', cur);
    }
  }

  // 列目录：PROPFIND depth=1，返回 [{ name, href, isDir }]
  async list(relPath) {
    const r = await this.req('PROPFIND', relPath, {
      depth: '1',
      contentType: 'application/xml',
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>'
    });
    if (r.status === 404) return [];
    if (r.status !== 207 && (r.status < 200 || r.status >= 300)) throw new WebDAVError(r.status, 'PROPFIND', relPath || '/');
    const xml = r.body.toString('utf8');
    const out = [];
    // 按 <response> 块切分，取每块的 href 与 resourcetype
    const blocks = xml.split(/<[^>]*response[ >]/i).slice(1);
    for (const b of blocks) {
      const hm = b.match(/<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href>/i);
      if (!hm) continue;
      let href = hm[1].trim();
      try { href = decodeURIComponent(href); } catch { /* 保留原样 */ }
      const isDir = /<[^>]*collection[\/ >]/i.test(b);
      const name = decodeURIComponent(href.replace(/\/+$/, '').split('/').pop() || '');
      if (!name || name === this.basePath.split('/').pop()) continue; // 跳过目录自身
      out.push({ name, href, isDir });
    }
    return out;
  }

  async get(relPath) {
    const r = await this.req('GET', relPath);
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw new WebDAVError(r.status, 'GET', relPath);
    return r.body;
  }

  async put(relPath, body) {
    const r = await this.req('PUT', relPath, {
      contentType: 'application/octet-stream',
      headers: { 'Content-Length': String(body.length) },
      body
    });
    if (r.status >= 200 && r.status < 300) return true;
    // 父目录不存在：建一层再重试一次
    if (r.status === 409 || r.status === 404) {
      const parent = String(relPath).split('/').slice(0, -1).join('/');
      if (parent) {
        await this.ensureDir(parent);
        const r2 = await this.req('PUT', relPath, { contentType: 'application/octet-stream', body });
        if (r2.status >= 200 && r2.status < 300) return true;
        throw new WebDAVError(r2.status, 'PUT', relPath);
      }
    }
    throw new WebDAVError(r.status, 'PUT', relPath);
  }

  async del(relPath) {
    const r = await this.req('DELETE', relPath);
    if (r.status >= 200 && r.status < 300 || r.status === 404) return true;
    throw new WebDAVError(r.status, 'DELETE', relPath);
  }
}

module.exports = { WebDAV, WebDAVError };
