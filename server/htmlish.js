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

/**
 * 判断一个 class/id 是不是噪音。
 *
 * ⚠️ 必须按**词边界**匹配，不能用子串包含：
 * 知乎答案正文的 class 是 "RichText ztext CopyrightRichText-richText"，
 * 按子串匹配 "copyright" 会把**整段答案正文**当成版权声明删掉，
 * 结果就是知乎每篇都"抽不到正文"（存下来是空页）。
 * 词边界：token 恰好等于该词，或该词前后是 - / _ 分隔。
 * "CopyrightRichText" 不匹配，"copyright" / "copyright-note" 匹配。
 */
function noiseHit(key) {
  const tokens = String(key == null ? '' : key)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  for (const tok of tokens) {
    for (const w of NOISE_WORDS) {
      const wl = w.toLowerCase();
      if (wl.charAt(0) === '-') { if (tok.endsWith(wl)) return true; continue; }
      if (wl.charAt(wl.length - 1) === '-') { if (tok.startsWith(wl)) return true; continue; }
      const esc = wl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(^|[-_])' + esc + '($|[-_])').test(tok)) return true;
    }
  }
  return false;
}

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
  for (const c of el.children) {
    // ⚠️ 只往下钻元素，**不要**把文本节点算进来。
    // 这里曾经写成 `c.tag === '#text' ? c.text : linkTextOf(c)`，
    // 于是每个元素的"链接文字"都等于它自己的全文 → linkRatio 恒为 1.0
    // → score() 对所有元素返回 0 → 通用正文抽取（不带站点选择器的那条路）
    // 全线失效。热榜之所以还能用，是因为十个来源都配了 selectors 走另一条分支；
    // 而「只显示正文」对微信文章直接是空白页，根源就在这一行。
    if (c.tag !== '#text') s += linkTextOf(c);
  }
  return s;
}

function isNoise(el) {
  if (DROP_TAGS.has(el.tag)) return true;
  const key = ((el.attrs.class || '') + ' ' + (el.attrs.id || '')).toLowerCase();
  if (!key.trim()) return false;
  return noiseHit(key);
}

/** 把噪音节点从树里摘掉 */
function stripNoise(el) {
  if (!el.children) return;
  el.children = el.children.filter(c => {
    if (c.tag === '#text') return true;
    if (!isNoise(c)) return true;
    // ⚠️ 名字像噪音，不等于里面没有正文：蓝点网（WordPress 主题 mnews-pro）
    // 把整篇文章放在 class="sidebar-module" 的 section 里，"sidebar" 命中噪音词后
    // 整棵子树被删 → 文章没了，只剩 914 字节的空壳。
    // 只要噪音节点里包着一个有实质文字的 <article>，就保留它，只继续清理子节点。
    // 导航/侧栏/评论块里不可能有 400 字以上的 <article>，不会把真噪音放回来。
    return hasRealArticle(c);
  });
  for (const c of el.children) stripNoise(c);
}

/** 元素自身或后代里有没有"像真正的文章"的 <article>（文字够长） */
function hasRealArticle(el) {
  if (el.tag === 'article') {
    return textOf(el).replace(/\s+/g, ' ').trim().length >= 400;
  }
  for (const c of el.children || []) {
    if (c.tag !== '#text' && hasRealArticle(c)) return true;
  }
  return false;
}

// class/id 里带这些词的，多半是正文容器
const CONTENT_WORDS = /(content|article|post|entry|markdown|topic|main|body|articlebody|story)/i;
// 带这些词的，是评论/回复/导航/元信息
const NOISE_CLASS_WORDS = /(comment|reply|replies|sidebar|footer|header|nav|share|meta|toolbar|pager|pagination|tag|tags|count|views|avatar|related|recommend|sponsor|promo|ad-|ads-|banner)/i;

/** 元素自己的 class+id */
function attrKey(el) {
  return ((el.attrs && el.attrs.class) || '').toLowerCase() + ' ' + ((el.attrs && el.attrs.id) || '').toLowerCase();
}

/** 给一个块打分：文字越多越好，链接文字占比越高越像导航 */
function score(el) {
  const t = textOf(el).replace(/\s+/g, ' ').trim();
  if (t.length < 25) return 0;
  const links = linkTextOf(el).replace(/\s+/g, ' ').trim();
  const linkRatio = links.length / Math.max(1, t.length);
  if (linkRatio > 0.5) return 0;   // 一半以上是链接 → 导航/列表，不是正文
  let s = t.length * (1 - linkRatio);
  const key = attrKey(el);
  if (NOISE_CLASS_WORDS.test(key)) s *= 0.2;
  else if (CONTENT_WORDS.test(key)) s *= 1.3;
  return s;
}

/** 链接占比（用来判断是不是导航/列表） */
function linkDensity(el) {
  const t = textOf(el).replace(/\s+/g, ' ').trim();
  if (!t.length) return 1;
  return linkTextOf(el).replace(/\s+/g, ' ').trim().length / t.length;
}

/** 简单选择器：tag / .class / #id / tag.class —— 返回**所有**匹配节点 */
function findAllBySelector(root, sel) {
  sel = String(sel || '').trim();
  if (!sel) return [];
  const m = sel.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
  if (!m) return [];
  const tag = (m[1] || '').toLowerCase();
  const rest = m[2] || '';
  const classes = (rest.match(/\.([\w-]+)/g) || []).map(x => x.slice(1).toLowerCase());
  const ids = (rest.match(/#([\w-]+)/g) || []).map(x => x.slice(1).toLowerCase());
  const out = [];
  const walk = (el) => {
    if (el.tag !== '#text') {
      const cls = String((el.attrs && el.attrs.class) || '').toLowerCase();
      const id = String((el.attrs && el.attrs.id) || '').toLowerCase();
      const okTag = !tag || el.tag === tag;
      const okCls = classes.every(c => cls.split(/\s+/).includes(c));
      const okId = ids.every(i => id === i);
      if (okTag && okCls && okId) out.push(el);
    }
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

function findBySelector(root, sel) {
  return findAllBySelector(root, sel)[0] || null;
}

/** 往上找：最近的、内容感很强的祖先（找不到就返回 parent） */
function contentAncestor(root, el) {
  const chain = [];
  const build = (node, path) => {
    for (const c of node.children) {
      if (c === el) { chain.push(path.concat([c])); return true; }
      if (build(c, path.concat([c]))) return true;
    }
    return false;
  };
  build(root, []);
  if (!chain.length) return null;
  const path = chain[0];
  // 从 el 往上找（跳过 el 自己）
  for (let i = path.length - 2; i >= 0; i--) {
    const node = path[i];
    if (node.tag === 'body' || node.tag === '#root') break;
    if (CONTENT_WORDS.test(attrKey(node))) return node;
  }
  return path.length >= 2 ? path[path.length - 2] : el;
}

/** 收集容器里的「块」：最外层优先，收下一个就不再往下钻 */
function collectBlocks(el, out) {
  for (const c of el.children) {
    if (c.tag === '#text') continue;
    if (isNoise(c)) continue;
    const t = textOf(c).replace(/\s+/g, ' ').trim();
    if (t.length >= 25) {
      if (linkDensity(c) <= 0.5) { out.push(c); continue; }
    }
    collectBlocks(c, out);
  }
}

/**
 * 找出正文块。
 * 关键点：按**段落**打分，而不是按"整页文字最多的容器"——
 * 论坛页（V2EX）一页有 200 多条回复，整页文字最多的当然是回复区，
 * 早先就是栽在这儿，抓回来的全是「某某 13 小时前」这种回帖列表。
 */
function findContent(root, selectors) {
  // A) 站点指定的正文容器优先（最准）
  if (selectors && selectors.length) {
    for (const sel of selectors) {
      // ⚠️ 同一个选择器可能要试**多个**匹配节点：知乎页面上第一个
      // .RichText 可能是很短的提问描述，真正有字的是下面那个回答。
      // 只取第一个匹配 → 短的那个不合格就直接判"抽不到正文"。
      for (const el of findAllBySelector(root, sel)) {
        const t = textOf(el).replace(/\s+/g, ' ').trim();
        if (t.length >= 120) return { el, score: t.length, mode: 'selector:' + sel };
      }
    }
  }

  // B) 段落级打分
  const nodes = [];
  const walk = (el) => {
    if (el.tag === '#text') return;
    const s = score(el);
    if (s > 0) nodes.push({ el, score: s, text: textOf(el).replace(/\s+/g, ' ').trim() });
    for (const c of el.children) walk(c);
  };
  walk(root);
  if (!nodes.length) return null;
  nodes.sort((a, b) => b.score - a.score);
  const top = nodes[0];

  // 容器：top 所在的「内容感强的祖先」，没有就用它的父节点
  const container = contentAncestor(root, top.el) || top.el;
  const picked = [];
  collectBlocks(container, picked);
  if (!picked.length) picked.push(top.el);

  const text = picked.map(p => textOf(p)).join(' ').replace(/\s+/g, ' ').trim();
  return {
    el: { tag: 'div', attrs: {}, children: picked, text: '' },
    score: top.score,
    text,
    mode: 'auto'
  };
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
 * 常见站点的正文容器。调用方没传 selectors 时用这份（传了就以传入的为准）。
 *
 * 为什么需要这张表：通用打分对结构极端的页面会跑偏，而这几家都有明确的正文容器，
 * 直接命中更准也更快。表里只放"容器稳定、且能覆盖大多数文章页"的站点，
 * 不放那些容器经常改版、反而会失手的站。
 */
const SITE_SELECTORS = [
  { host: /(^|\.)mp\.weixin\.qq\.com$/, sels: ['#js_content', '.rich_media_content'] },
  // 知乎：答案正文在 .RichText（class 含 CopyrightRichText-…），
  // 问题描述在 .QuestionRichText，外层 .RichContent-inner
  { host: /(^|\.)zhihu\.com$/, sels: ['.RichText', '.RichContent-inner', '.QuestionRichText', '.Post-RichText', 'article'] },
  { host: /(^|\.)juejin\.cn$/, sels: ['.markdown-body', '.article-content'] },
  { host: /(^|\.)sspai\.com$/, sels: ['.article-content', '.content'] },
  { host: /(^|\.)ithome\.com$/, sels: ['#paragraph', '.post_content'] },
  { host: /(^|\.)v2ex\.com$/, sels: ['.topic_content', '.cell'] },
  { host: /(^|\.)chinanews\.com(\.cn)?$/, sels: ['.left_zw', '#content', '.content_desc'] },
  { host: /(^|\.)people\.com\.cn$/, sels: ['#rwb_zw', '.rm_txt_con', '#text'] },
  { host: /(^|\.)csdn\.net$/, sels: ['#content_views', 'article'] },
  { host: /(^|\.)cnblogs\.com$/, sels: ['#cnblogs_post_body', '.postBody'] },
  { host: /(^|\.)jianshu\.com$/, sels: ['article'] },
  { host: /(^|\.)36kr\.com$/, sels: ['.articleDetailContent', 'article'] },
  { host: /(^|\.)huxiu\.com$/, sels: ['.article-content-wrap', '.article-content'] },
  { host: /(^|\.)infoq\.cn$/, sels: ['.article-preview', 'article'] },
  { host: /(^|\.)solidot\.org$/, sels: ['.about_at', '.contentbox'] },
  { host: /(^|\.)ifanr\.com$/, sels: ['.article-content', '.article-body'] },
  { host: /(^|\.)geekpark\.net$/, sels: ['.detail-content', '.article_content'] },
  // 蓝点网：WordPress 主题 mnews-pro，文章在 <article class="entry"> 里，
  // 但外层容器叫 sidebar-module（会被噪音规则误删，见 stripNoise 里的保护）
  { host: /(^|\.)landian\.news$/, sels: ['.entry', 'article.entry', 'article'] },
  { host: /(^|\.)ruanyifeng\.com$/, sels: ['#main-content', '.entry-content', 'article'] },
  { host: /(^|\.)news\.ycombinator\.com$/, sels: ['.toptext', '.commtext'] }
];

function defaultSelectorsFor(url) {
  if (!url) return null;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  for (const s of SITE_SELECTORS) if (s.host.test(host)) return s.sels;
  return null;
}

/**
 * 剥掉「内容就是正文、但用 CSS 先藏起来防闪烁」的内联样式。
 *
 * 微信最典型：#js_content 上挂着 visibility:hidden; opacity:0，
 * 靠它自己的 JS 在排版完成后改回来。我们存的是静态快照，
 * 不剥掉的话「只显示正文」出来的是一整页空白——文字都在，就是看不见。
 * 只处理这两种属性；display:none 保留（那通常是菜单/弹窗，去掉反而漏出垃圾）。
 */
function stripHidingStyles(el) {
  const st = el.attrs && el.attrs.style;
  if (typeof st === 'string' && /visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)/i.test(st)) {
    const next = st
      .replace(/visibility\s*:\s*hidden\s*;?/gi, '')
      .replace(/opacity\s*:\s*0(?:\.0+)?\s*;?/gi, '')
      .trim();
    if (next) el.attrs.style = next;
    else delete el.attrs.style;
  }
  if (el.children) for (const c of el.children) stripHidingStyles(c);
}

const stripTags = (s) => String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

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

  // 站点表兜底：调用方没指定就用内置表里的（微信这类容器明确的站，命中率比打分高得多）
  const selectors = (o.selectors && o.selectors.length) ? o.selectors : defaultSelectorsFor(baseUrl);
  const found = findContent(tree, selectors);
  if (!found) return null;

  // 门槛看**文字长度**，不要看分数：正文里链接多（比如新闻里的外链）会拉低分数，
  // 早先拿分数当门槛，结果 IT之家这种正文直接被判成"抽不出来"。
  const text = (found.text || textOf(found.el)).replace(/\s+/g, ' ').trim();
  if (text.length < 200) return null;

  stripHidingStyles(found.el);

  // 把相对地址补成绝对地址，否则图片会裂
  let inner = serialize(found.el);
  inner = absolutize(inner, baseUrl);

  // 正文里已经有一个和标题相同的 h1 就别再加了（微信、知乎都这样，否则阅读页标题出现两遍）
  const dupH1 = /<h1[^>]*>([\s\S]{0,400}?)<\/h1>/i.exec(inner);
  const sameHead = !!(dupH1 && stripTags(dupH1[1]) === title);

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
    + (title && !sameHead ? '<h1>' + escapeText(title) + '</h1>' : '')
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

/** 把 src/href 里的相对地址补全，顺手把懒加载的真实图片地址换上去 */
function absolutize(html, baseUrl) {
  // 懒加载：<img src="占位图" data-original="真地址">
  html = html.replace(/\b(src|data-src|data-original)\s*=\s*"([^"]*)"(\s+data-original\s*=\s*"[^"]*")?/gi,
    (mm, attr, val, extra) => {
      const real = extra && extra.match(/data-original\s*=\s*"([^"]*)"/);
      if (real && real[1]) return 'src="' + real[1] + '"';
      return mm;
    });
  if (!baseUrl) return html;
  return html.replace(/\b(src|href|poster|data-src)="([^"]+)"/gi, (mm, attr, val) => {
    if (!val || /^(https?:|data:|blob:|\/\/|#|mailto:)/i.test(val)) return mm;
    try {
      const u = new URL(val, baseUrl);
      return attr + '="' + u.toString() + '"';
    } catch { return mm; }
  });
}

module.exports = { parse, extractArticle, stripNoiseOnly, textOf, serialize, score, findContent, stripNoise, linkTextOf, isNoise, findBySelector, linkDensity };
