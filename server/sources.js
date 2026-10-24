'use strict';

/**
 * 热榜来源注册表。
 *
 * 每个来源负责一件事：把「榜单」变成一组文章链接 { title, url, summary }。
 * 拉下来的链接会交给服务端的抓取管线（fetchHtml → 抽正文 → 存盘），
 * 跟手机上「粘贴链接保存」走的是同一条路。
 *
 * 收录标准：**榜单条目本身就得是文章**。
 * 像百度热搜、今日头条那种「热词榜」（点进去是搜索结果页）不收，
 * 因为存下来的是搜索页不是原文。
 */

const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------- 解析小工具 ----------

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function stripTags(s) {
  // 先把 CDATA 取出内容，再剥标签 —— 顺序反了的话
  // <title><![CDATA[梵高名画…]]></title> 会被整段当成标签删掉，标题就空了
  const raw = String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decode(raw.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 从一段 HTML 里抠出 <tag>…</tag> 的内容 */
function pick(html, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = html.match(re);
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** RSS/Atom 通用解析 */
function parseFeed(xml, baseUrl) {
  const out = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    let link = pick(b, 'link');
    // Atom 的 link 是属性
    if (!link) {
      const m = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = m ? m[1] : '';
    }
    const title = stripTags(pick(b, 'title'));
    // ⚠️ 两处细节：
    //  1) 标签名可能带冒号（content:encoded），取不到就退回 description；
    //  2) 有些源（如 IT之家）把正文 HTML **转义**后放进 description
    //     （&lt;p&gt;…），不解实体的话存下来会变成一堆字面量 "<p>"。
    const rawDesc = pick(b, 'content:encoded') || pick(b, 'description') ||
      pick(b, 'summary') || pick(b, 'content');
    if (!link || !title) continue;
    let url = link.trim();
    if (baseUrl) { try { url = new URL(url, baseUrl).toString(); } catch { /* 保留原样 */ } }
    const html = decode(String(rawDesc || '')).trim();   // 先解实体 → 真正的 HTML
    const plain = stripTags(html);
    out.push({
      title,
      url,
      html,
      summary: plain.slice(0, 300),
      contentLength: plain.length
    });
  }
  return out;
}

/**
 * 解析 OPML（RSS 阅读器导出的订阅清单）。
 * 返回 [{title, url}]，url 取 outline 的 xmlUrl 属性。
 */
function parseOpml(xml) {
  const out = [];
  const re = /<outline\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const tag = m[0];
    const urlM = tag.match(/xmlUrl\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!urlM) continue;
    const url = decode((urlM[1] || urlM[2] || '').trim());
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const tM = tag.match(/text\s*=\s*(?:"([^"]*)"|'([^']*)')/i) ||
      tag.match(/title\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const title = stripTags((tM && (tM[1] || tM[2])) || url);
    out.push({ title, url });
  }
  return out;
}

/** JSON 里取字符串字段（兼容多种命名） */
function pickStr(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

// ---------- 来源定义 ----------

const SOURCES = [
  {
    id: 'zhihu',
    name: '知乎热榜',
    emoji: '🔶',
    desc: '知乎站内最热的问题与回答（需要登录 Cookie）',
    type: 'json',
    url: 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.zhihu.com/hot',
      'x-api-version': '3.0.91',
      'x-requested-with': 'fetch'
    },
    // 知乎的接口必须带登录态 cookie，否则 401
    needsCookie: true,
    cookieHint: '浏览器登录知乎后按 F12 → Network → 任意请求 → Request Headers，把整行 cookie 复制过来（只要含 z_c0=… 那段就够）。Cookie 过期了这里也要重新填。',
    // 抽不到正文就不存：宁可少存一篇，也别存一堆空页面
    requireContent: true,
    // 知乎问题页的正文容器：问题描述在 .QuestionRichText，
    // 回答正文在 .RichText（class 里带 CopyrightRichText-…），
    // 外层是 .RichContent-inner。注意 .Post-RichText 是旧版结构，留着兜底。
    selectors: ['.RichText', '.RichContent-inner', '.QuestionRichText', '.Post-RichText', 'article'],

    parse(text) {
      const data = JSON.parse(text);
      const list = (data && data.data) || [];
      return list.map((it) => {
        const card = it.target || it.card || {};
        // ⚠️ 知乎 2025 年前后把标题挪了位置：现在是 target.title_area.text，
        // 老代码只认 target_title_area → 每条标题都空 → 整张列表被过滤光
        // → 拉取结果显示"没有新文章"。两套字段都认，谁有算谁的。
        const t = card.title_area || card.target_title_area || card.coffee_card || {};
        const excerpt = (card.excerpt_area && (card.excerpt_area.text || card.excerpt_area.long_text)) || '';
        const link = (t.link && t.link.url) || (card.link && card.link.url) || '';
        return {
          title: stripTags(t.text || (it.detail_text || '')) || it.detail_text || '',
          url: link,
          summary: stripTags(excerpt).slice(0, 300),
          hot: it.detail_text || ''
        };
      }).filter(x => x.title && x.url);
    }
  },
  {
    id: 'v2ex',
    name: 'V2EX 热榜',
    emoji: '🔥',
    desc: '程序员社区的热门主题',
    type: 'json',
    url: 'https://www.v2ex.com/api/topics/hot.json',
    selectors: ['.topic_content', '.ps_container'],
    // 论坛帖子里楼主可能一句话都不写（只发了个标题），那种存下来没意义
    requireContent: true,

    parse(text) {
      const list = JSON.parse(text) || [];
      // 注意：标题和链接在**顶层**，node 只是所属分类（问与答 / 程序员…）
      return list.map((it) => ({
        title: String(it.title || '').trim(),
        url: String(it.url || (it.id ? 'https://www.v2ex.com/t/' + it.id : '')).trim(),
        summary: stripTags(it.content_rendered || it.content || '').slice(0, 300),
        hot: String(it.replies || 0) + ' 回复'
      })).filter(x => x.title && x.url);
    }
  },
  {
    id: 'juejin',
    name: '掘金热榜',
    emoji: '💎',
    desc: '掘金热门文章',
    type: 'json',
    url: 'https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot',
    headers: { 'Accept': 'application/json', 'Referer': 'https://juejin.cn/' },
    selectors: ['.markdown-body', '.article-content', 'article'],

    parse(text) {
      const data = JSON.parse(text) || {};
      const list = data.data || [];
      return list.map((it) => {
        const c = it.content || it;
        const info = c.content_info || {};
        const counter = it.content_counter || {};
        return {
          title: String(info.title || c.title || '').trim(),
          url: 'https://juejin.cn/post/' + (c.content_id || ''),
          summary: String(info.brief_content || c.brief || '').trim().slice(0, 300),
          hot: (counter.view_count || counter.collect_count || 0) + ' 阅读'
        };
      }).filter(x => x.title && x.url);
    }
  },
  {
    id: 'sspai',
    name: '少数派',
    emoji: '🧩',
    desc: '效率与数字生活好文',
    type: 'rss',
    url: 'https://sspai.com/feed',
    selectors: ['.article-content', '.content', 'article'],
    parse: (text, baseUrl) => parseFeed(text, baseUrl)
  },
  {
    id: 'ithome',
    name: 'IT之家',
    emoji: '💻',
    desc: '科技新闻与评测',
    type: 'rss',
    url: 'https://www.ithome.com/rss/',
    selectors: ['#paragraph', '.post_content'],
    parse: (text, baseUrl) => parseFeed(text, baseUrl)
  },
  {
    id: 'ruanyifeng',
    name: '阮一峰博客',
    emoji: '📖',
    desc: '科技周刊与长文',
    type: 'rss',
    // 官网的 atom.xml 会被 Cloudflare 挡（403），走 feedburner 镜像稳
    url: 'https://feeds.feedburner.com/ruanyifeng',
    selectors: ['#main-content', '.entry-content', 'article'],
    parse: (text, baseUrl) => parseFeed(text, baseUrl)
  },
  {
    id: 'solidot',
    name: 'Solidot',
    emoji: '🐧',
    desc: '奇客的资讯，重要的东西',
    type: 'rss',
    url: 'https://www.solidot.org/index.rss',
    selectors: ['.about_at', '.contentbox', 'article'],
    parse: (text, baseUrl) => parseFeed(text, baseUrl)
  },
  {
    id: 'ifanr',
    name: '爱范儿',
    emoji: '📱',
    desc: '科技生活方式',
    type: 'rss',
    url: 'https://www.ifanr.com/feed',
    selectors: ['.article-content', '.article-body', 'article'],
    parse: (text, baseUrl) => parseFeed(text, baseUrl)
  },
  {
    id: 'geekpark',
    name: '极客公园',
    emoji: '🚄',
    desc: '科技与商业观察',
    type: 'rss',
    url: 'https://www.geekpark.net/rss',
    selectors: ['.detail-content', '.article_content', 'article'],
    parse: (text, baseUrl) => parseFeed(text, baseUrl)
  },
  {
    id: 'hn',
    name: 'Hacker News',
    emoji: '🟧',
    desc: '英文技术圈热帖（首页链接指向原文站点）',
    type: 'json',
    url: 'https://hacker-news.firebaseio.com/v0/topstories.json',
    async: true,
    // HN 的 topstories 只给 id，要再逐个取 item —— parse 是异步的（见下）
    selectors: ['.article', '#main-content', 'article'],

    async parse(text, ctx) {
      const ids = JSON.parse(text) || [];
      const out = [];
      for (const id of ids.slice(0, 30)) {
        try {
          const it = await ctx.fetchJSON('https://hacker-news.firebaseio.com/v0/item/' + id + '.json');
          if (!it || !it.url || !it.title) continue;
          out.push({
            title: it.title,
            url: it.url,
            summary: '',
            hot: (it.score || 0) + ' 分'
          });
        } catch { /* 单条失败不影响整体 */ }
        if (out.length >= 20) break;
      }
      return out;
    }
  }
];

const BY_ID = new Map(SOURCES.map(s => [s.id, s]));

module.exports = {
  SOURCES,
  UA_DESKTOP,
  parseFeed,
  parseOpml,
  getSource: (id) => BY_ID.get(id) || null,
  /**
   * 把某个来源的原始响应解析成条目数组。
   *
   * ⚠️ 一定返回 Promise：Hacker News 那种「先拿 id 列表、再逐条取详情」的来源，
   * parse 是 async 的。以前这里直接 `Array.isArray(out)` 判断，拿到的是 Promise
   * → 永远判定"不是数组" → 返回空列表，HN 这个来源等于从来没工作过。
   */
  parseList(source, text, ctx) {
    let out;
    try {
      out = source.parse(text, ctx || {});
    } catch (e) {
      return Promise.reject(new Error('解析失败：' + (e && e.message ? e.message : e)));
    }
    return Promise.resolve(out)
      .then(v => (Array.isArray(v) ? v : []))
      .catch(e => { throw new Error('解析失败：' + (e && e.message ? e.message : e)); });
  }
};
