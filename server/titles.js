'use strict';

// 从抓到的 HTML 里提取标题。
//
// 为什么不能只看 <title>：
//   微信公众号文章的 <title></title> 是**字面空的**（标题靠页面脚本往 h1 里填），
//   真标题只出现在 <meta property="og:title"> 和 <h1 class="rich_media_title"> 里。
//   只认 <title> 的实现拿到空串 → 列表里只剩一长串 https://mp.weixin.qq.com/s/xxxx，
//   用户得一条条手动改标题。同类站点不少（部分博客、SPA、掘金镜像），所以按可信度多源兜底。

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  middot: '·', mdash: '—', ndash: '–', hellip: '…',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
  times: '×', copy: '©', reg: '®', trade: '™'
};

/** 解 HTML 实体（&#x4e2d; / &#20013; / &amp; 都要认，中文标题里很常见） */
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; }
    })
    .replace(/&#(\d+);/g, (m, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return m; }
    })
    .replace(/&([a-z][a-z0-9]*);/gi, (m, n) => {
      const v = NAMED_ENTITIES[n.toLowerCase()];
      return v === undefined ? m : v;
    });
}

/** 去标签、解实体、压空白 */
function plainText(s) {
  return decodeEntities(String(s == null ? '' : s))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 反爬拦截页 / 错误页的标题。这些词当标题毫无意义，宁可继续找下一个候选。
const TITLE_JUNK = new RegExp('^(' + [
  '微信公众平台', '微信公众号', '微信',
  '环境异常', '完成验证后即可继续访问', '请完成验证', '安全验证', '人机验证',
  '页面不存在', '页面未找到', '找不到页面', '页面已删除', '内容不存在', '该内容已被发布者删除',
  '此内容因违规无法查看', '该公众号已迁移', '参数错误', '访问过于频繁',
  '加载中', '正在加载', '请稍候', '无标题', '未命名', '未命名文档', '标题',
  'untitled', 'no title', 'new page', 'loading',
  'error', 'not found', 'forbidden', 'access denied', 'blocked', 'unauthorized',
  'bad gateway', 'service unavailable', 'internal server error',
  '404', '403', '500', '502', '503',
  'just a moment\\.?', 'attention required!?.*', 'one more step', 'checking your browser.*',
  'security check', 'ddos protection.*'
].join('|') + ')$', 'i');

/**
 * 候选标题能不能用。
 * finalUrl 用来排除「标题就是网址/域名」这种情况——那等于没标题。
 */
function usableTitle(t, finalUrl) {
  const s = String(t == null ? '' : t).trim();
  if (s.length < 2 || s.length > 300) return false;
  if (TITLE_JUNK.test(s)) return false;
  if (/^(https?:\/\/|www\.)/i.test(s)) return false;
  if (/^[\w.-]+\.(com|cn|net|org|io|me|co|xyz|top|info|app|dev|cc|tv)$/i.test(s)) return false;
  // 纯符号 / 纯数字（页码之类）不要
  if (!/[0-9a-z\u3400-\u9fff]/i.test(s)) return false;
  if (/^\d+$/.test(s)) return false;
  // 传进来的是网址本身，也算没标题
  if (finalUrl) {
    const norm = (x) => String(x || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    if (norm(s) === norm(finalUrl)) return false;
  }
  return true;
}

/**
 * 提取标题，取不到返回空串（调用方自己决定退回什么）。
 * 顺序：og/twitter title → <title> → 微信专用容器 → 第一个 h1
 *
 * @param {string} html
 * @param {string} [finalUrl] 用于排除「标题=网址」的假标题
 * @returns {string}
 */
function pageTitle(html, finalUrl) {
  const s = String(html == null ? '' : html);
  if (!s) return '';
  // meta / title 一定在文档靠前的位置，限制扫描范围，别为 3MB 的页面白跑全文正则
  const head = s.slice(0, 200 * 1024);
  const cands = [];

  // 1) og:title / twitter:title / weibo:article:title
  //    两种写法都认：<meta property="og:title" content="…"> 和 content 在前
  const TITLE_KEYS = /(og:title|twitter:title|weibo:article:title|itemprop\s*=\s*["']name["'])/i;
  const metaRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(head))) {
    const tag = m[0];
    if (!TITLE_KEYS.test(tag)) continue;
    const c = tag.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (c) cands.push(plainText(c[1] || c[2] || ''));
  }

  // 2) <title>
  const tm = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) cands.push(plainText(tm[1]));

  // 3) 微信的正文标题容器（<title> 为空，只能从这几处拿）
  const WX = [
    /id\s*=\s*["']activity-name["'][^>]*>([\s\S]{0,500}?)<\/(?:h1|div|span)>/i,
    /<h1[^>]*class\s*=\s*["'][^"']*rich_media_title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
    /<span[^>]*class\s*=\s*["'][^"']*js_title_inner[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
  ];
  for (const re of WX) {
    const mm = s.match(re);
    if (mm) cands.push(plainText(mm[1]));
  }

  // 4) 第一个 h1（博客、文档站普遍如此）
  const h1 = s.match(/<h1[^>]*>([\s\S]{0,600}?)<\/h1>/i);
  if (h1) cands.push(plainText(h1[1]));

  for (const c of cands) {
    const t = String(c || '').trim();
    if (usableTitle(t, finalUrl)) return t.slice(0, 300);
  }
  return '';
}

/**
 * 抓回来的是不是拦截页 / 空壳页（正文几乎没字）。
 * 只用来**在明显异常时给出人话提示**，不参与正常判定。
 */
function looksLikeGatePage(html) {
  const s = String(html == null ? '' : html);
  if (/id\s*=\s*["']js_verify["']/i.test(s)) return true;
  if (/cf-browser-verification|challenge-platform|cf_chl_opt/i.test(s)) return true;
  const body = plainText(s);
  if (body.length >= 300) return false;
  return /环境异常|完成验证|请开启JavaScript|请启用JavaScript|verify you are human|enable javascript/i.test(body);
}

module.exports = { pageTitle, usableTitle, plainText, decodeEntities, looksLikeGatePage, TITLE_JUNK };
