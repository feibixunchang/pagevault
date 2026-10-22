'use strict';

// PageVault 后台服务工作器（MV3）。
// 职责：用扩展的 host_permissions 跨域抓取页面里的远程图片，转成 data URL 回传 popup 内联。
// 为什么需要它：SingleFile 在页面上下文里跑，受同源策略限制，抓不了跨域图片（CORS），
// 会把图片留成远程地址——离线打开就是裂图。扩展上下文带 host 权限，fetch 不受 CORS 限制。

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
