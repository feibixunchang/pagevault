'use strict';

// PageVault 扩展 popup —— 基于 SingleFile 高保真捕获当前整页，上报到同步服务端。

const DEFAULT_SERVER = 'http://localhost:8731';

async function getServer() {
  const s = await chrome.storage.local.get('serverUrl');
  return s.serverUrl || DEFAULT_SERVER;
}
async function setServer(v) {
  await chrome.storage.local.set({ serverUrl: v });
}

document.addEventListener('DOMContentLoaded', async () => {
  const input = document.getElementById('server');
  const statusEl = document.getElementById('status');
  input.value = await getServer();

  document.getElementById('save').addEventListener('click', async () => {
    await setServer(input.value.trim());
    statusEl.textContent = '已保存服务地址';
  });
  document.getElementById('capture').addEventListener('click', () => doCapture(statusEl));
});

async function doCapture(statusEl) {
  statusEl.textContent = '捕获中…';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { statusEl.textContent = '没有活动标签页'; return; }

  let captured;
  try {
    captured = await captureWithSingleFile(tab.id, statusEl);
  } catch (e) {
    statusEl.textContent = '捕获失败：' + (e && e.message ? e.message : e);
    return;
  }
  if (!captured || !captured.html) {
    statusEl.textContent = '捕获失败：页面无内容';
    return;
  }

  const server = (await getServer()).replace(/\/$/, '');
  const platform = detectPlatform();
  const payload = {
    html: captured.html,
    title: captured.title,
    url: captured.url,
    platform,
    format: 'html',
    engine: 'singlefile'
  };
  try {
    await postWithRetry(server + '/api/pages', payload, statusEl);
    statusEl.textContent = '已保存 ✓（SingleFile 高保真）';
  } catch (e) {
    const msg = (e && e.message) || String(e);
    statusEl.textContent = /failed to fetch|networkerror|load failed|ECONNREFUSED|aborted/i.test(msg)
      ? '保存失败：连不上服务端，请先打开 PageVault.app'
      : '保存到服务端失败：' + msg;
  }
}

// 1) 用 executeScript 的 files 方式把 SingleFile 库注入页面 MAIN world
//    （不走 <script> 标签，不受页面 CSP 限制，也不用 chrome.runtime.getURL）
// 2) 调用 singlefile.getPageData() 取得自包含 HTML
// 3) 所有内部错误都带回 popup，不再吞错
async function captureWithSingleFile(tabId, statusEl) {
  // 先自动滚动整页，触发懒加载图片（有上限防无限流页面卡死）
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: scrollThroughPage });
  } catch { /* 个别页面不让滚就算了 */ }

  // 先探测库里是否已加载（避免重复注入 940KB）
  const probe = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => !!(window.singlefile && window.singlefile.getPageData)
  });
  if (!probe[0].result) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['lib/single-file.js']
    });
  }

  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: runGetPageData
  });
  const data = res[0].result;
  if (!data) throw new Error('SingleFile 未返回任何结果');
  if (data.error) throw new Error('SingleFile 内部错误：' + data.error);
  if (!data.html) throw new Error('SingleFile 返回了空内容');

  // SingleFile 在页面上下文里受 CORS 限制抓不了跨域图，这里把残留的远程图片
  // 交给 background（有 host 权限）抓取并转成 data URL 内联，避免裂图。
  const remoteUrls = extractRemoteUrls(data.html);
  if (remoteUrls.length) {
    statusEl.textContent = '内联远程图片（' + remoteUrls.length + '）…';
    try {
      const { map } = await chrome.runtime.sendMessage({
        type: 'inline-images',
        urls: remoteUrls,
        referer: data.url
      });
      if (map && Object.keys(map).length) {
        let html = data.html;
        for (const [u, d] of Object.entries(map)) {
          if (html.includes(u)) html = html.split(u).join(d);
        }
        data.html = html;
      }
    } catch { /* 后台不可用不阻塞保存 */ }
  }
  return data;
}

// 从 HTML 里提取所有远程图片地址（img src 与 CSS url()），去重、限数量
function extractRemoteUrls(html) {
  const found = new Set();
  const patterns = [
    /<img[^>]+src\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
    /url\(\s*["']?(https?:\/\/[^)"']+)["']?\s*\)/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html))) {
      if (!/\.(svg|css|js)(\?|#|$)/i.test(m[1])) found.add(m[1]);
      if (found.size >= 80) break;
    }
  }
  return [...found];
}

// 从上往下分步滚动，触发懒加载；最多 30 步，滚回顶部再返回
async function scrollThroughPage() {
  await new Promise((resolve) => {
    let y = 0;
    let lastHeight = 0;
    let stable = 0;
    const step = () => {
      y += Math.round(window.innerHeight * 0.8);
      window.scrollTo(0, y);
      const h = document.body ? document.body.scrollHeight : 0;
      stable = (h === lastHeight) ? stable + 1 : 0;
      lastHeight = h;
      if (y < h && stable < 5 && lastHeight < 200000) setTimeout(step, 130);
      else { window.scrollTo(0, 0); resolve(); }
    };
    step();
  });
}

async function runGetPageData() {
  try {
    if (!window.singlefile || !window.singlefile.getPageData) {
      return { error: 'singlefile 对象不存在（库注入后未成功执行，页面可能有 CSP/沙箱限制）' };
    }
    const data = await window.singlefile.getPageData({
      removeHiddenElements: false,
      compressHTML: false,
      loadDeferredImages: true,
      insertSingleFileComment: true,
      blockScripts: true, // 关键：去脚本，避免 SPA（微博等）打开时 JS 重跑把页面清空成空白
      removeUnusedStyles: true, // 顺手裁剪未用到的样式，压一压体积
    });
    return {
      html: data && data.content,
      title: (data && data.title) || document.title,
      url: location.href
    };
  } catch (e) {
    return { error: (e && e.message) ? e.message : String(e) };
  }
}

// 上传到服务端：失败自动重试一次（应对 app 刚重启、端口短暂的空窗）
async function postWithRetry(url, payload, statusEl) {
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  try {
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  } catch (e) {
    statusEl.textContent = '保存中（重试一次）…';
    await new Promise(r => setTimeout(r, 1200));
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  }
}

function detectPlatform() {
  const ua = navigator.userAgent;
  let os = 'Unknown';
  if (/Mac/i.test(ua)) os = 'macOS';
  else if (/Win/i.test(ua)) os = 'Windows';
  else if (/Linux/i.test(ua)) os = 'Linux';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Android/i.test(ua)) os = 'Android';

  let br = 'Browser';
  if (/Edg/i.test(ua)) br = 'Edge';
  else if (/Firefox/i.test(ua)) br = 'Firefox';
  else if (/Chrome/i.test(ua)) br = 'Chrome';
  else if (/Safari/i.test(ua)) br = 'Safari';

  return br + '/' + os;
}
