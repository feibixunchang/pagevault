'use strict';
// 单独验证：拉榜 → 解析 → 抓正文 → 抽正文
const http = require('http');
const https = require('https');
const { SOURCES, UA_DESKTOP } = require('./sources.js');
const { extractArticle, stripNoiseOnly } = require('./htmlish.js');

function fetchRaw(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, {
      headers: Object.assign({
        'User-Agent': UA_DESKTOP,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity'
      }, headers || {}),
      timeout: 20000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchRaw(new URL(res.headers.location, u).toString(), headers).then(resolve, reject);
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), finalUrl: u.toString() }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const ctx = {
  fetchJSON: async (url) => (await fetchRaw(url)).text ? JSON.parse((await fetchRaw(url)).text) : null
};

(async () => {
  const only = process.argv[2];
  const list = only ? SOURCES.filter(s => s.id === only) : SOURCES;
  for (const s of list) {
    process.stdout.write(`\n=== ${s.emoji} ${s.name} ===\n`);
    try {
      const r = await fetchRaw(s.url, s.headers);
      let items;
      if (s.async) items = await s.parse(r.text, ctx);
      else items = require('./sources.js').parseList(s, r.text, ctx);
      console.log(`  榜单条目: ${items.length}`);
      for (const it of items.slice(0, 3)) {
        console.log(`   · ${it.title.slice(0, 42)}  ${it.url.slice(0, 68)}`);
      }
      // 抓第一篇试试正文抽取
      if (items.length && !only) {
        const target = items[0];
        try {
          const page = await fetchRaw(target.url, { Referer: new URL(target.url).origin });
          const art = extractArticle(page.text, { title: target.title, baseUrl: page.finalUrl });
          const t = art ? art.textLength : 0;
          console.log(`  抓正文: ${art ? '✓ ' + t + ' 字' : '✗ 抽不出（会退回整页去噪版）'}`);
          if (art) {
            const body = art.html.match(/<body[^>]*>([\s\S]*)/i)[1];
            const txt = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            console.log('  正文开头:', txt.slice(0, 120));
          }
        } catch (e) {
          console.log('  抓正文失败:', e.message);
        }
      }
    } catch (e) {
      console.log('  ✗ 失败:', e.message);
    }
  }
})();
