'use strict';

// PageVault 后台服务工作器（MV3）。
// 职责：
// 1) 用扩展的 host_permissions 跨域抓取页面里的远程图片，转成 data URL 回传 popup 内联。
//    为什么需要它：SingleFile 在页面上下文里跑，受同源策略限制，抓不了跨域图片（CORS），
//    会把图片留成远程地址——离线打开就是裂图。扩展上下文带 host 权限，fetch 不受 CORS 限制。
// 2) 与服务端保持连接：
//    - WebSocket 长连接（/ws/ext）是主通道：断了立刻感知，指数退避自动重连。
//      客户端重启后扩展几秒内自己接回来，不需要手动去点浏览器。
//      服务端每 20 秒 ping 一次，Chrome 收到消息会重置 service worker 的空闲计时器，
//      浏览器开着时扩展就一直活着。
//    - HTTP 心跳（/api/ping）是兜底：老服务端不支持 WebSocket 时仍然能报"已连接"。

const HEARTBEAT_ALARM = 'pv-heartbeat';
const EXT_VERSION = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
let lastPingAt = 0;

function serverBase() {
  // 与 popup 保持同一默认值；用户在 popup 里改过地址时以 storage 为准
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get('serverUrl', (s) => resolve((s && s.serverUrl) || 'http://localhost:8731'));
    } catch { resolve('http://localhost:8731'); }
  });
}

async function ping(force) {
  // 节流：10 秒内不重复发（标签页频繁切换时避免刷爆）
  const now = Date.now();
  if (!force && now - lastPingAt < 10000) return;
  lastPingAt = now;
  const base = await serverBase();
  try {
    await fetch(base.replace(/\/$/, '') + '/api/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: EXT_VERSION })
    });
  } catch {
    lastPingAt = 0; // 服务端没开：下个事件/alarm 立即重试，不用等节流窗口
  }
}

// ---------- WebSocket 长连接 ----------
let ws = null;
let wsRetry = 0;
let wsTimer = null;
let wsKeepTimer = null;

function wsUrl(base) {
  const u = new URL(base.replace(/\/$/, ''));
  u.protocol = (u.protocol === 'https:' ? 'wss:' : 'ws:');
  u.pathname = '/ws/ext';
  u.search = '';
  return u.toString();
}

function sendWS(obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch { /* ignore */ }
}

function scheduleReconnect() {
  if (wsTimer) return;
  wsRetry = Math.min(wsRetry + 1, 6);
  // 1s → 2s → 4s → 5s → 5s…：客户端刚重启时几秒内接回，长时间离线也不会刷屏
  const delay = Math.min(1000 * Math.pow(2, wsRetry - 1), 5000);
  wsTimer = setTimeout(() => { wsTimer = null; connectWS(); }, delay);
}

async function connectWS() {
  const base = await serverBase();
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  let sock;
  try {
    sock = new WebSocket(wsUrl(base));
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    wsRetry = 0;
    sendWS({ type: 'hello', v: EXT_VERSION });
    ping(true);           // 顺手补一次 HTTP 心跳，老服务端也能看到
    // 主动保活：每 20 秒发一条，服务端据此刷新"最后在线时间"；
    // 同时让 Chrome 不会因为 service worker 空闲太久把扩展挂掉。
    try {
      clearInterval(wsKeepTimer);
      wsKeepTimer = setInterval(() => { sendWS({ type: 'ping', v: EXT_VERSION }); }, 20000);
    } catch { /* ignore */ }
  };
  sock.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data);
      if (d && d.type === 'ping') sendWS({ type: 'pong' });
    } catch { /* 忽略非 JSON 帧 */ }
  };
  sock.onclose = () => { if (ws === sock) ws = null; scheduleReconnect(); };
  // 连接失败时 error 与 close 不一定成对出现（尤其是 socket 还在 CONNECTING 阶段就被拒），
  // 所以这里也直接排一次重连，不把恢复希望全押在 close 上。
  sock.onerror = () => { scheduleReconnect(); };
}

// 安装/浏览器启动时立刻连一次
chrome.runtime.onInstalled.addListener(() => { ping(true); connectWS(); });
chrome.runtime.onStartup.addListener(() => { ping(true); connectWS(); });
// 保活：MV3 service worker 会被休眠，alarm 能唤醒它。
// 30 秒一次（Chrome 120+ 支持，旧版自动按 1 分钟），桌面端重启后最多半分钟自动重连。
try { chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 }); }
catch { chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 }); }
chrome.alarms.onAlarm.addListener((a) => {
  if (a && a.name === HEARTBEAT_ALARM) { ping(true); connectWS(); }
});

// 快速补连：浏览器有任何活动（切标签、开新页、页面加载完）都顺手 ping 一次
try {
  if (chrome.tabs && chrome.tabs.onActivated) chrome.tabs.onActivated.addListener(() => { ping(false); connectWS(); });
  if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((id, info) => { if (info && info.status === 'complete') { ping(false); connectWS(); } });
  }
  if (chrome.windows && chrome.windows.onFocusChanged) chrome.windows.onFocusChanged.addListener(() => { ping(false); connectWS(); });
} catch { /* 权限不足时忽略，alarm 仍会兜底 */ }

// SW 刚被唤醒时如果还没连上，立刻补一次
if (!ws) connectWS();

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// 图片内联的预算。以前是「最多 80 张、一张一张串行抓」，长文（动辄一两百张图）
// 超出的部分就留着远程地址 —— 断网打开就是一片裂图。现在放宽到 150 张、6 路并发，
// 并且按总字节数兜底，避免把内存吃满。
const MAX_IMAGES = 150;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_ONE_BYTES = 3 * 1024 * 1024;
const CONCURRENCY = 6;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'inline-images') return undefined;
  (async () => {
    const map = {};
    const urls = (msg.urls || []).slice(0, MAX_IMAGES);
    let bytes = 0;
    let next = 0;

    // 单个失败不影响其他；一旦触到字节预算，剩下的直接放弃（保留远程地址）
    const worker = async () => {
      while (next < urls.length) {
        if (bytes >= MAX_TOTAL_BYTES) return;
        const u = urls[next++];
        try {
          const resp = await fetch(u, {
            referrer: msg.referer || undefined, // 带来源页地址，过防盗链
            credentials: 'include',             // 带 cookie，抓登录态图片
            redirect: 'follow'
          });
          if (!resp.ok) continue;
          const blob = await resp.blob();
          if (!blob.type.startsWith('image/')) continue;
          if (blob.size > MAX_ONE_BYTES) continue;
          if (bytes + blob.size > MAX_TOTAL_BYTES) return;
          map[u] = await blobToDataURL(blob);
          bytes += blob.size;
        } catch { /* 单张失败跳过 */ }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    sendResponse({ map, asked: urls.length, bytes });
  })();
  return true; // 异步 sendResponse
});
