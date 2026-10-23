'use strict';

/**
 * 极简 HTML 处理：把一个网页的正文挑出来，存成干净的"文章页"。
 *
 * 为什么要自己写：服务端要保持零依赖（Docker 镜像里没有 npm install），
 * 而项目里那份 Mozilla Readability 是浏览器版（依赖 window/document），
 * 在 Node 里跑不起来。所以这里写一个够用的版本：
 *
 *   1) 解析成一棵很粗的树（只关心标签、属性、文本）
 *   2) 扔掉脚本、样式、导航、页脚这些明显不是正文的节点
 *   3) 给每个块级元素打分（文字多、链接少的得分高），挑最高分的那个当正文
 *   4) 输出一个干净的 HTML 文档
 *
 * 挑不出正文时（正文太短）返回 null，调用方会退回"原页面去掉噪音"的版本，
 * 保证不会比原来更差。
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr'
]);

// 这些标签里的东西一律不是正文
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'object', 'embed',
  'form', 'input', 'button', 'select', 'textarea', 'nav', 'aside', 'footer', 'header'
]);

// class/id 里出现这些词的，多半是导航、推荐、评论、广告
const NOISE_WORDS = [
  'comment', 'reply', 'sidebar', 'side-bar', 'recommend', 'related', 'hot-list',
  'hotlist', 'nav-', 'navbar', 'menu', 'footer', 'header', 'banner', 'advert',
  'advertis', 'ad-', '-ad', 'ads-', 'share', 'copyright', 'breadcrumb',
  'pagination', 'subscribe', 'newsletter', 'toolbar', 'widget', 'popup',
  'modal', 'float-', 'sticky', 'qrcode', 'reward'
];

/** 把 HTML 解析成粗糙的树 */
function parse(html) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  // 去掉注释和 CDATA，免得里面出现假标签
  const src = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');

  const tokenRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)\/?>/g;
  let last = 0;
  let m;
  while ((m = tokenRe.exec(src))) {
    const text = src.slice(last, m.index);
    if (text) addText(stack[stack.length - 1], text);
    last = tokenRe.lastIndex;

    const isClose = m[0][1] === '/';
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2] || '');

    if (isClose) {
      // 找到最近的同名开标签并闭合；找不到就忽略（容错要紧，页面千奇百怪）
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    if (VOID_TAGS.has(tag)) {
      const el = { tag, attrs, children: [], text: '', selfClosed: true };
      stack[stack.length - 1].children.push(el);
      continue;
    }
    const el = { tag, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(el);
    stack.push(el);
  }
  const tail = src.slice(last);
  if (tail) addText(stack[stack.length - 1], tail);
  return root;
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(s))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] || '')));
  }
  return attrs;
}

function addText(parent, raw) {
  const t = decodeEntities(raw.replace(/\s+/g, ' '));
  if (!t.trim()) return;
  parent.children.push({ tag: '#text', attrs: {}, children: [], text: t });
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** 递归拿纯文本 */
function textOf(el) {
  if (el.tag === '#text') return el.text;
  let s = '';
  for (const c of el.children) s += (c.tag === '#text' ? c.text : textOf(c));
  return s;
}

/** 链接里的文字（导航/推荐列表的特征） */
function linkTextOf(el) {
  if (el.tag === 'a') return textOf(el);
  let s = '';
  for (const c of el.children) s += (c.tag === '#text' ? c.text : linkTextOf(c));
  return s;
}

function isNoise(el) {
  if (DROP_TAGS.has(el.tag)) return true;
  const key = ((el.attrs.class || '') + ' ' + (el.attrs.id || '')).toLowerCase();
  if (!key.trim()) return false;
  return NOISE_WORDS.some(w => key.includes(w));
}

/** 把噪音节点从树里摘掉 */
function stripNoise(el) {
  if (!el.children) return;
  el.children = el.children.filter(c => {
    if (c.tag === '#text') return true;
    return !isNoise(c);
  });
  for (const c of el.children) stripNoise(c);
}

/** 给一个块打分：文字越多越好，链接文字占比越高越像导航 */
function score(el) {
  const t = textOf(el).replace(/\s+/g, ' ').trim();
  if (t.length < 120) return 0;
  const links = linkTextOf(el).replace(/\s+/g, ' ').trim();
  const linkRatio = links.length / Math.max(1, t.length);
  return t.length * (1 - Math.min(0.9, linkRatio));
}

/** 找出正文块：得分最高的元素；如果某个子元素分数接近父元素，就继续往下钻 */
function findContent(root) {
  let best = null;
  let bestScore = 0;
  const walk = (el) => {
    if (el.tag === '#text') return;
    const s = score(el);
    if (s > bestScore) { bestScore = s; best = el; }
    for (const c of el.children) if (c.tag !== '#text') walk(c);
  };
  walk(root);
  if (!best) return null;

  // 往下钻：如果子块分数几乎等于父块，说明正文就在子块里
  let cur = best;
  for (let i = 0; i < 6; i++) {
    let next = null;
    for (const c of cur.children) {
      if (c.tag === '#text') continue;
      if (score(c) >= bestScore * 0.88) { next = c; break; }
    }
    if (!next) break;
    cur = next;
  }
  return { el: cur, score: bestScore };
}

/** 把树还原成 HTML */
function serialize(el) {
  if (el.tag === '#text') return escapeText(el.text);
  const attrs = el.attrs || {};
  let a = '';
  for (const k of Object.keys(attrs)) {
    if (k === 'class' && !attrs[k]) continue;
    a += ' ' + k + '="' + escapeText(String(attrs[k])).replace(/"/g, '&quot;') + '"';
  }
  const inner = el.children.map(serialize).join('');
  if (VOID_TAGS.has(el.tag)) return '<' + el.tag + a + '>';
  return '<' + el.tag + a + '>' + inner + '</' + el.tag + '>';
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 只留 body，去掉 head 里的脚本样式 */
function bodyOnly(html) {
  const m = String(html).match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : String(html);
}

/**
 * 从整页 HTML 里抽出正文，生成一份干净的"文章页"。
 * @returns {{html:string, textLength:number, title:string}|null} 挑不出正文时返回 null
 */
function extractArticle(html, opts) {
  const o = opts || {};
  const title = String(o.title || '').trim();
  const baseUrl = o.baseUrl || '';

  const tree = parse(bodyOnly(html));
  stripNoise(tree);

  const found = findContent(tree);
  if (!found) return null;

  // 门槛看**文字长度**，不要看分数：正文里链接多（比如新闻里的外链）会拉低分数，
  // 早先拿分数当门槛，结果 IT之家这种正文直接被判成"抽不出来"。
  const text = textOf(found.el).replace(/\s+/g, ' ').trim();
  if (text.length < 200) return null;

  // 把相对地址补成绝对地址，否则图片会裂
  let inner = serialize(found.el);
  inner = absolutize(inner, baseUrl);

  const doc = '<!DOCTYPE html>\n<html><head><meta charset="utf-8">'
    + (title ? '<title>' + escapeText(title) + '</title>' : '')
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + (baseUrl ? '<base href="' + escapeText(baseUrl).replace(/"/g, '&quot;') + '">' : '')
    + '<style>body{margin:0;background:#fff;}'
    + '.pv-article{max-width:760px;margin:0 auto;padding:28px 20px;}'
    + '.pv-article img,.pv-article video{max-width:100%;height:auto;border-radius:6px;}'
    + '.pv-article h1{font-size:1.5em;line-height:1.4;margin:0 0 .6em;}'
    + '.pv-article p{margin:0 0 1.1em;line-height:1.85;}'
    + '.pv-article pre{background:#f4f5f7;padding:12px;border-radius:8px;overflow:auto;}'
    + '.pv-article a{color:#185fa5;word-break:break-all;}'
    + '</style></head><body><div class="pv-article">'
    + (title ? '<h1>' + escapeText(title) + '</h1>' : '')
    + inner
    + '</div></body></html>';

  return { html: doc, textLength: text.length, title };
}

/** 去掉噪音但保留整页结构（抽取失败时的退路） */
function stripNoiseOnly(html, opts) {
  const o = opts || {};
  const baseUrl = o.baseUrl || '';
  const tree = parse(bodyOnly(html));
  stripNoise(tree);
  let inner = serialize(tree).replace(/<[^>]*>#root<\/[^>]*>/, '');
  inner = absolutize(inner, baseUrl);
  const title = String(o.title || '').trim();
  return '<!DOCTYPE html>\n<html><head><meta charset="utf-8">'
    + (title ? '<title>' + escapeText(title) + '</title>' : '')
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + (baseUrl ? '<base href="' + escapeText(baseUrl).replace(/"/g, '&quot;') + '">' : '')
    + '<style>body{margin:0;}</style></head><body>' + inner + '</body></html>';
}

/** 把 src/href 里的相对地址补全 */
function absolutize(html, baseUrl) {
  if (!baseUrl) return html;
  return html.replace(/\b(src|href|poster|data-src)="([^"]+)"/gi, (mm, attr, val) => {
    if (!val || /^(https?:|data:|blob:|\/\/|#|mailto:)/i.test(val)) return mm;
    try {
      const u = new URL(val, baseUrl);
      return attr + '="' + u.toString() + '"';
    } catch { return mm; }
  });
}

module.exports = { parse, extractArticle, stripNoiseOnly, textOf, serialize, score, findContent, stripNoise, linkTextOf, isNoise };
