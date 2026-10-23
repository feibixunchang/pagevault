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
    let summary = stripTags(pick(b, 'description') || pick(b, 'summary') || pick(b, 'content'));
    if (!link || !title) continue;
    let url = link.trim();
    if (baseUrl) { try { url = new URL(url, baseUrl).toString(); } catch { /* 保留原样 */ } }
    out.push({ title, url, summary: summary.slice(0, 300) });
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
    cookieHint: '浏览器登录知乎后，F12 → Network → 任意请求 → Request Headers 里找 cookie，整行复制（只要 z_c0=… 那段也行）',
    // 抽不到正文就不存：宁可少存一篇，也别存一堆空页面
    requireContent: true,    selectors: ['.Post-RichText', '.RichContent-inner', 'article'],

    parse(text) {
      const data = JSON.parse(text);
      const list = (data && data.data) || [];
      return list.map((it) => {
        const card = it.target || it.card || {};
        const t = card.target_title_area || card.coffee_card || {};
        const excerpt = (card.excerpt_area && (card.excerpt_area.text || card.excerpt_area.long_text)) || '';
        return {
          title: stripTags(t.text || (it.detail_text || '')) || it.detail_text || '',
          url: t.link && t.link.url ? t.link.url : (card.link && card.link.url) || '',
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
    url: 'https://www.v2ex.com/api/topics/hot.json',    selectors: ['.topic_content', '.ps_container'],
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
    headers: { 'Accept': 'application/json', 'Referer': 'https://juejin.cn/' },    selectors: ['.markdown-body', '.article-content', 'article'],

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
    // HN 的 topstories 只给 id，要再逐个取 item；这里在服务端展开    selectors: ['.article-content', '.content', 'article'],
    selectors: ['#paragraph', '.post_content'],
    selectors: ['#main-content', '.entry-content', 'article'],
    selectors: ['.about_at', '.contentbox', 'article'],
    selectors: ['.article-content', '.article-body', 'article'],
    selectors: ['.detail-content', '.article_content', 'article'],
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
  getSource: (id) => BY_ID.get(id) || null,
  /** 把某个来源的原始响应解析成条目数组 */
  parseList(source, text, ctx) {
    try {
      const out = source.parse(text, ctx || {});
      return Array.isArray(out) ? out : [];
    } catch (e) {
      throw new Error('解析失败：' + (e && e.message ? e.message : e));
    }
  }
};
