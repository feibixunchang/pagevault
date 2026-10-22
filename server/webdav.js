'use strict';

// 极简 WebDAV 客户端（零依赖）：PROPFIND / GET / PUT / DELETE / MKCOL。
// 用途：把「网页收藏」的库同步到用户自己的 WebDAV 账号（坚果云 / Nextcloud / 群晖 /
// 自建 Apache 等）——同一账号登录多端即可互相同步，不依赖我们部署任何服务器。

const http = require('http');
const https = require('https');
const { URL } = require('url');
const dnsx = require('./dnsx');

const TIMEOUT = 45000;

class WebDAVError extends Error {
  constructor(status, method, path, detail) {
    let msg = `WebDAV ${method} ${path} -> HTTP ${status}`;
    if (detail) msg += '（' + detail + '）';
    super(msg);
    this.status = status;
    this.detail = detail || '';
  }
}

// 把服务器错误响应体压成人话（很多 WebDAV 服务器返回 XML/纯文本说明，排障就靠它）
function errorDetail(r) {
  if (!r || !r.body || !r.body.length) return '';
  let txt = r.body.toString('utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (txt.length > 160) txt = txt.slice(0, 160) + '…';
  return txt;
}

// 把底层网络错误翻成用户能看懂、能自己动手排查的提示。
// 经验：绝大多数"同步连不上"都是 DNS（域名写错/到期/本机 DNS 失效）或地址写错，
// 而原始信息只有一句 getaddrinfo ENOTFOUND，对普通用户毫无指导意义。
function netError(e, host) {
  const msg = (e && e.message) ? e.message : String(e);
  if (/ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_FAIL|getaddrinfo/i.test(msg)) {
    return new Error('域名解析失败：无法解析 ' + host +
      '。请确认服务器地址没写错、域名没过期；若其他网站也打不开，是本机网络/DNS 问题（可换 DNS 或用 IP 地址）。');
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return new Error('连接被拒绝：' + host + ' 上没有可用的 WebDAV 服务（检查地址与端口，或服务是否启动）。');
  }
  if (/ETIMEDOUT|timeout|请求超时/i.test(msg)) {
    return new Error('连接超时：' + host + ' 长时间无响应（网络不通或服务器离线）。');
  }
  if (/CERT|self.signed|SSL|TLS|ERR_TLS/i.test(msg)) {
    return new Error('TLS/证书错误：' + msg.slice(0, 140) + '（自签名证书需改用 https 可信任的地址）。');
  }
  return new Error('网络错误：' + msg);
}

class WebDAV {
  // base 例：https://dav.jianguoyun.com/dav/pagevault
  constructor(base) {
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https 地址');
    this.client = u.protocol === 'https:' ? https : http;
    this.origin = u.origin;
    this.host = u.host;
    this.hostname = u.hostname;
    this.basePath = u.pathname.replace(/\/+$/, '');
  }

  auth(user, pass) {
    this.authHeader = 'Basic ' + Buffer.from(String(user) + ':' + String(pass), 'utf8').toString('base64');
  }

  // relPath: '' = basePath 自身；'pages/a.html' = 相对 basePath 的路径
  req(method, relPath, opts) {
    const clean = String(relPath || '').replace(/^\/+/, '');
    // 路径穿越防护：远端 PROPFIND 返回的文件名会流到这里，不能信任
    if (clean.split('/').some(seg => seg === '..' || seg === '.')) {
      return Promise.reject(new Error('非法路径：' + clean));
    }
    return this._request(method, this.basePath + (clean ? '/' + clean : ''), opts);
  }

  // 发一个完整 URL 路径的请求（urlPath 必须以 / 开头或为空串）。
  // _mkcolChain 需要逐级创建 basePath 的前缀目录，那些路径不在 basePath 之下，
  // 不能走 req() 的拼接，必须用 _request 直接发。
  //
  // 解析与连接分离：先用 dnsx 拿全部候选地址（系统 DNS 失败会自动走 DoH，
  // 且 A/AAAA 都查），再逐个地址尝试连接。这样两种常见故障都能自愈：
  //   - 本机 DNS 被 VPN/加速器弄挂 → DoH 兜底
  //   - 域名只有 IPv6 记录 / IPv6 不通 → IPv4 优先，失败再试 IPv6（或反之）
  async _request(method, urlPath, opts) {
    opts = opts || {};
    const headers = {
      Authorization: this.authHeader || '',
      Depth: opts.depth || '0'
    };
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
    Object.assign(headers, opts.headers || {});

    const { addrs, source } = await dnsx.resolveHost(this.hostname);
    if (!addrs.length) {
      throw netError(new Error('getaddrinfo ENOTFOUND ' + this.hostname), this.host);
    }
    this.lastDnsSource = source;

    let lastErr = null;
    for (const a of addrs) {
      try {
        return await this._requestOnce(method, urlPath, opts, headers, a);
      } catch (e) {
        lastErr = e;
        // 只对"连不上这个地址"重试；HTTP 协议层错误抛出去，不换地址瞎试
        if (!/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|EADDRNOTAVAIL|请求超时|socket hang up|ECONNRESET/i.test(e && e.message || '')) {
          throw e;
        }
      }
    }
    // 全部地址都失败：IPv6-only 域名却在这台机器上连不通，是最常见的一类
    const onlyV6 = addrs.every(a => a.family === 6);
    const e = netError(lastErr, this.host);
    if (onlyV6) {
      e.message += '（该域名只有 IPv6 地址，当前网络可能不支持 IPv6；建议在域名里补一条 A 记录）';
    }
    throw e;
  }

  _requestOnce(method, urlPath, opts, headers, addr) {
    const self = this;
    return new Promise((resolve, reject) => {
      const reqOpts = {
        method,
        headers,
        lookup: dnsx.pinnedLookup(addr.address, addr.family)
      };
      const r = self.client.request(self.origin + (urlPath || ''), reqOpts, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        }));
      });
      r.on('error', e => reject(new Error((e && e.message) ? e.message : String(e))));
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

  // 确保远端目录存在。relPath 相对 basePath；'' = 只确保 basePath 自身存在
  // （basePath 可能有多级，如 /dav/pagevault，必须逐级 MKCOL，否则 PUT 子路径会 404/409）
  async ensureDir(relPath) {
    const full = this.basePath.split('/').filter(Boolean)
      .concat(String(relPath || '').split('/').filter(Boolean));
    await this._mkcolChain(full);
  }

  // 逐级创建 full 路径数组的每一级（full 是完整 URL 路径分段，不含 basePath 之外的前缀）；
  // 409/404（父目录不存在）时先建父级再重试本级
  async _mkcolChain(full) {
    for (let i = 0; i < full.length; i++) {
      const cur = '/' + full.slice(0, i + 1).join('/'); // 完整路径，如 /likeweb/pages
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await this._request('MKCOL', cur);
        if ((r.status >= 200 && r.status < 300) || r.status === 405) break; // 建好 / 已存在
        // 个别服务器（及某些代理层）用 409 + "already exists" 表达"已存在"，按已存在处理
        if (r.status === 409 && /EEXIST|already exists|已存在/i.test(errorDetail(r))) break;
        if ((r.status === 409 || r.status === 404) && i > 0) {
          await this._mkcolChain(full.slice(0, i)); // 先把父级建起来
          continue;                                 // 再重试本级
        }
        throw new WebDAVError(r.status, 'MKCOL', cur, errorDetail(r));
      }
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
    if (r.status !== 207 && (r.status < 200 || r.status >= 300)) throw new WebDAVError(r.status, 'PROPFIND', relPath || '/', errorDetail(r));
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
    if (r.status < 200 || r.status >= 300) throw new WebDAVError(r.status, 'GET', relPath, errorDetail(r));
    return r.body;
  }

  async put(relPath, body) {
    const send = () => this.req('PUT', relPath, {
      contentType: 'application/octet-stream',
      headers: { 'Content-Length': String(body.length) },
      body
    });
    let r = await send();
    if (r.status >= 200 && r.status < 300) return true;
    // 父目录不存在（严格服务器 409，宽松服务器 404）：逐级建好再重试一次
    if (r.status === 409 || r.status === 404) {
      const parent = String(relPath).split('/').slice(0, -1).join('/');
      if (parent) {
        try { await this.ensureDir(parent); } catch { /* 建失败也重试一次 PUT，让真实错误暴露出来 */ }
        r = await send();
        if (r.status >= 200 && r.status < 300) return true;
      }
    }
    throw new WebDAVError(r.status, 'PUT', relPath, errorDetail(r));
  }

  async del(relPath) {
    const r = await this.req('DELETE', relPath);
    if (r.status >= 200 && r.status < 300 || r.status === 404) return true;
    throw new WebDAVError(r.status, 'DELETE', relPath, errorDetail(r));
  }
}

module.exports = { WebDAV, WebDAVError };
