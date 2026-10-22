'use strict';

// 域名解析兜底（双栈 + DoH）
//
// 背景：真实故障里最常见的是这两种情况，而 Node 默认的 dns.lookup 都无能为力：
//   1) 本机系统 DNS 被 VPN/加速器接管后失效（例如 Tailscale MagicDNS 100.100.100.100 不通）
//      → 任何域名都 ENOTFOUND，但机器其实能正常上网（浏览器走 DoH 所以看起来没事）
//   2) 目标域名只有 AAAA（IPv6）记录，没有 A 记录
//      → 只支持 IPv4 的网络直接连不上，而错误信息只说"解析失败"
//
// 策略：优先系统解析器（最快、走缓存）；失败时用阿里/腾讯 DoH 兜底（直连 IP，不依赖系统 DNS），
// 同时查 A 与 AAAA，返回全部候选地址（IPv4 优先，IPv6 次之），由调用方逐个尝试连接。

const dns = require('dns');
const https = require('https');

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map(); // host -> { at, addrs: [{address, family}] }

const DOH_SERVERS = [
  { ip: '223.5.5.5', sni: 'dns.alidns.com', path: '/resolve' },   // 阿里公共 DNS
  { ip: '1.12.12.12', sni: 'doh.pub', path: '/dns-query' }        // 腾讯 DNSPod（备用）
];

function cacheGet(host) {
  const c = cache.get(host);
  if (c && Date.now() - c.at < CACHE_TTL) return c.addrs;
  return null;
}
function cacheSet(host, addrs) {
  cache.set(host, { at: Date.now(), addrs });
}

// 系统解析器：一次性拿全 A/AAAA（all:true）
function systemResolve(host) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish([]), 3000);
    try {
      dns.lookup(host, { all: true }, (err, list) => {
        clearTimeout(timer);
        if (err || !list || !list.length) return finish([]);
        finish(list.map(x => ({ address: x.address, family: x.family })));
      });
    } catch { clearTimeout(timer); finish([]); }
  });
}

// DoH（JSON）：直连 DNS 服务器 IP，用 SNI 校验域名证书，完全绕开本机 DNS
function dohQuery(server, host, type) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const urlPath = server.path + '?name=' + encodeURIComponent(host) + '&type=' + type;
    let req;
    try {
      req = https.request({
        host: server.ip,
        port: 443,
        path: urlPath,
        method: 'GET',
        servername: server.sni,
        headers: { Host: server.sni, Accept: 'application/dns-json' },
        timeout: 4000
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            const out = [];
            for (const a of (j.Answer || [])) {
              if (a.type === 1 || a.type === 28) out.push(a.data.replace(/^"|"$/g, ''));
            }
            finish(out);
          } catch { finish([]); }
        });
      });
    } catch { return finish([]); }
    req.on('timeout', () => { req.destroy(); finish([]); });
    req.on('error', () => finish([]));
    req.end();
  });
}

async function dohResolve(host) {
  for (const server of DOH_SERVERS) {
    const [v4, v6] = await Promise.all([
      dohQuery(server, host, 'A'),
      dohQuery(server, host, 'AAAA')
    ]);
    const addrs = [];
    for (const ip of v4) addrs.push({ address: ip, family: 4 });
    for (const ip of v6) addrs.push({ address: ip, family: 6 });
    if (addrs.length) return addrs;
  }
  return [];
}

// 对外：返回候选地址列表（IPv4 优先）。source 用于日志说明命中哪条路径
async function resolveHost(host) {
  const cached = cacheGet(host);
  if (cached) return { addrs: cached, source: 'cache' };

  let addrs = await systemResolve(host);
  let source = 'system';
  if (!addrs.length) {
    addrs = await dohResolve(host);
    source = 'doh';
  }
  if (!addrs.length) return { addrs: [], source: 'none' };

  // 去重 + IPv4 优先（IPv6 兜底：只有 AAAA 时才用它）
  const seen = new Set();
  const uniq = [];
  for (const a of addrs) {
    const k = a.family + ':' + a.address;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(a);
  }
  uniq.sort((x, y) => x.family - y.family);

  cacheSet(host, uniq);
  return { addrs: uniq, source };
}

// 给 http(s).request 用的 lookup：固定连某个已解析地址
function pinnedLookup(address, family) {
  return function (hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = (options && typeof options === 'object') ? options : {};
    if (opts.all) return cb(null, [{ address, family }]);
    cb(null, address, family);
  };
}

module.exports = { resolveHost, pinnedLookup, dohResolve, systemResolve };
