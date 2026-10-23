'use strict';

// 扩展与服务端之间的 WebSocket 通道（零依赖实现，只用 Node 内置模块）。
//
// 为什么要有它：原来扩展与服务端之间只有「30 秒一次 HTTP 心跳」。
// MV3 的 service worker 会被浏览器休眠，后台浏览器的 alarm 还可能被延迟到几分钟，
// 于是「客户端重启后扩展迟迟连不上」「浏览器一关状态就迟迟不变」。
// 换成 WebSocket 长连接后：
//   1) 连接断开立刻感知 → 指数退避重连（1s→15s），客户端一重启扩展就自动接回来；
//   2) 服务端能实时知道扩展在不在（不再靠 2 分钟心跳窗口猜）；
//   3) 服务端每 20 秒发一次 ping，Chrome 收到消息会重置 SW 的空闲计时器，
//      浏览器开着时扩展就一直是活的。

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BIN = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

// 解一帧：返回 null 表示数据还不够，等下次
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > 0x3fffffn) return null;      // 4MB 上限，防止恶意帧
    len = Number(big);
    offset = 10;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = Buffer.from(buf.slice(offset, offset + len));
  if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
  return { fin, opcode, payload, size: offset + len };
}

// 服务端 → 客户端（不加掩码）
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

/**
 * 把 WebSocket 通道挂到 http server 上。
 * @param {http.Server} server
 * @param {object} opts
 *   path      路径（默认 /ws/ext）
 *   onOpen(client)
 *   onMessage(client, text)
 *   onClose(client)
 *   heartbeatMs  服务端 ping 间隔（默认 20s）
 */
function attachWebSocket(server, opts) {
  const o = opts || {};
  const wsPath = o.path || '/ws/ext';
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { pathname = req.url || ''; }
    if (pathname !== wsPath) { try { socket.destroy(); } catch { /* ignore */ } return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { try { socket.destroy(); } catch { /* ignore */ } return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
      );
    } catch { return; }
    socket.setNoDelay(true);
    socket.setTimeout(0);

    const client = { socket, alive: true, version: '' };
    clients.add(client);

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = decodeFrame(buf);
        if (!frame) break;
        buf = buf.slice(frame.size);
        if (frame.opcode === OP_CLOSE) { closeClient(client); return; }
        if (frame.opcode === OP_PING) { try { socket.write(encodeFrame(OP_PONG, frame.payload)); } catch { /* ignore */ } continue; }
        if (frame.opcode === OP_PONG) { client.alive = true; continue; }
        if (frame.opcode === OP_TEXT || frame.opcode === OP_BIN) {
          const text = frame.payload.toString('utf8');
          try {
            const j = JSON.parse(text);
            if (j && typeof j.v === 'string') client.version = j.v.slice(0, 20);
          } catch { /* 不是 JSON 也照样通知一次，版本号留空 */ }
          if (o.onMessage) { try { o.onMessage(client, text); } catch { /* ignore */ } }
        }
      }
    };

    function closeClient(c) {
      if (!clients.has(c)) return;
      clients.delete(c);
      try { c.socket.destroy(); } catch { /* ignore */ }
      if (o.onClose) { try { o.onClose(c); } catch { /* ignore */ } }
    }

    socket.on('data', onData);
    socket.on('error', () => closeClient(client));
    socket.on('close', () => closeClient(client));
    socket.on('end', () => closeClient(client));

    if (o.onOpen) { try { o.onOpen(client); } catch { /* ignore */ } }
    if (head && head.length) onData(head);
  });

  // 服务端主动 ping：既是保活，也是让 SW 保持活跃
  const hb = setInterval(() => {
    for (const c of [...clients]) {
      if (!c.alive) { try { c.socket.destroy(); } catch { /* ignore */ } clients.delete(c); if (o.onClose) { try { o.onClose(c); } catch { /* ignore */ } } continue; }
      c.alive = false;
      try { c.socket.write(encodeFrame(OP_PING, Buffer.alloc(0))); } catch { /* ignore */ }
    }
  }, o.heartbeatMs || 20000);
  hb.unref && hb.unref();

  return {
    clients,
    size: () => clients.size,
    close() { clearInterval(hb); for (const c of [...clients]) { try { c.socket.destroy(); } catch { /* ignore */ } } clients.clear(); }
  };
}

module.exports = { attachWebSocket, encodeFrame, decodeFrame };
