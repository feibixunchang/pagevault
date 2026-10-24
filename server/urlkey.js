'use strict';

/**
 * URL 归一化：给「同一篇文章」一个稳定的比对键。
 *
 * 为什么需要它：
 * 热榜源（少数派 / IT之家 / 爱范儿…）本身也是 RSS，和用户自己导入的 OPML 订阅
 * 指向同一批文章。同一篇文章在两个源里的 URL 却常常不完全一样：
 *   - 带不带追踪参数（?utm_source=rss / ?from=… / ?spm=…）
 *   - 结尾带不带斜杠
 *   - 大小写 / www 前缀
 *   - fragment（#comments 之类）
 * 按原始 URL 字符串比对 → 同一篇文章会被当成两篇各存一次，库里出现重复。
 *
 * 规则（故意保守，宁可少合并也不要误合并）：
 *   1. 去掉 fragment
 *   2. 去掉常见追踪参数
 *   3. 去掉末尾斜杠
 *   4. host 转小写、去掉开头的 www.
 *   5. 路径大小写保持原样（有些站点路径大小写敏感）
 */

const TRACKING_PARAMS = [
  // 通用追踪
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_name', 'utm_reader', 'utm_social', 'utm_brand',
  'gclid', 'fbclid', 'msclkid', 'dclid', 'yclid', 'igshid', 'mc_cid', 'mc_eid',
  'spm', 'scm', 'from', 'from_source', 'source', 'ref', 'referer', 'referrer',
  'share_token', 'share_source', 'hmsr', 'hmpl', 'hmcu', 'hmkw', 'hmci',
  '__twitter_impression', 'wt_mc', 'cmpid', 'campaign_id', 'at_medium',
  's_cid', 'sr_share', '_hsenc', '_hsmi', 'vero_id', 'trk', 'trkCampaign',
  'WT.mc_id', 'ck_subscriber_id'
];

/** 去掉末尾斜杠（只处理 path 结尾，不动根路径） */
function stripTrailingSlash(path) {
  if (!path || path === '/') return path || '/';
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * 计算一个 URL 的归一化比对键。
 * @param {string} raw
 * @returns {string} 归一化后的键；输入不合法时返回原串（trim 后）
 */
function urlKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    // 不是绝对 URL（相对路径之类）：只能按字符串处理
    return s.replace(/#.*$/, '');
  }
  // 1) host 归一
  let host = u.host.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);

  // 2) query：去掉追踪参数
  const params = u.searchParams;
  const keep = [];
  for (const [k, v] of params.entries()) {
    const lk = k.toLowerCase();
    if (TRACKING_PARAMS.includes(lk)) continue;
    keep.push(k + '=' + v);
  }
  keep.sort();
  const query = keep.length ? '?' + keep.join('&') : '';

  // 3) path：去末尾斜杠（根路径保持 '/'）
  let path = u.pathname || '/';
  path = stripTrailingSlash(path);

  // 4) 端口：默认端口去掉
  const port = (u.port && (u.port === '80' || u.port === '443')) ? '' : (u.port ? ':' + u.port : '');

  return u.protocol.toLowerCase() + '//' + host + port + path + query;
}

/** 两个 URL 是否指向同一篇文章 */
function sameUrl(a, b) {
  const ka = urlKey(a);
  const kb = urlKey(b);
  return !!ka && ka === kb;
}

/** 从一组 URL 里建去重集合（已归一化） */
function keySet(urls) {
  const s = new Set();
  for (const u of urls || []) {
    const k = urlKey(u);
    if (k) s.add(k);
  }
  return s;
}

module.exports = { urlKey, sameUrl, keySet, TRACKING_PARAMS };
