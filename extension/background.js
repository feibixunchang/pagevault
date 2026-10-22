'use strict';

// PageVault 后台服务工作器（MV3）。
// 职责：
// 1) 用扩展的 host_permissions 跨域抓取页面里的远程图片，转成 data URL 回传 popup 内联。
//    为什么需要它：SingleFile 在页面上下文里跑，受同源策略限制，抓不了跨域图片（CORS），
//    会把图片留成远程地址——离线打开就是裂图。扩展上下文带 host 权限，fetch 不受 CORS 限制。
// 2) 心跳：每分钟 ping 一次同步服务端，让阅读器状态栏显示"扩展已连接"。

const HEARTBEAT_ALARM = 'pv-heartbeat';

function serverBase() {
  // 与 popup 保持同一默认值；用户在 popup 里改过地址时以 storage 为准
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get('serverUrl', (s) => resolve((s && s.serverUrl) || 'http://localhost:8731'));
    } catch { resolve('http://localhost:8731'); }
  });
}

async function ping() {
  const base = await serverBase();
  try {
    await fetch(base.replace(/\/$/, '') + '/api/ping', { method: 'POST' });
  } catch { /* 服务端没开就静默，下次 alarm 再试 */ }
}

// 安装/浏览器启动时立刻 ping 一次，状态栏马上显示已连接
chrome.runtime.onInstalled.addListener(() => { ping(); });
chrome.runtime.onStartup.addListener(() => { ping(); });
// 每分钟保活（MV3 service worker 会被休眠，alarm 能唤醒它）
chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === HEARTBEAT_ALARM) ping(); });

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'inline-images') return undefined;
  (async () => {
    const map = {};
    const urls = (msg.urls || []).slice(0, 80); // 单次上限，防止超大页卡死
    for (const u of urls) {
      try {
        const resp = await fetch(u, {
          referrer: msg.referer || undefined, // 带来源页地址，过防盗链
          credentials: 'include',             // 带 cookie，抓登录态图片
          redirect: 'follow'
        });
        if (!resp.ok) continue;
        const blob = await resp.blob();
        if (!blob.type.startsWith('image/')) continue;
        if (blob.size > 4 * 1024 * 1024) continue; // 单张超 4MB 跳过
        map[u] = await blobToDataURL(blob);
      } catch { /* 单张失败不影响其他 */ }
    }
    sendResponse({ map });
  })();
  return true; // 异步 sendResponse
});
