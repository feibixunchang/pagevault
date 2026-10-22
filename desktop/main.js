'use strict';

// PageVault desktop (macOS) launcher.
// Bundles the sync server (server/server.js) as an Electron child node process and
// opens a native window rendering the reader UI. The browser extension talks to the
// same localhost:8731 endpoint, so all six ends share one protocol.

const { app, BrowserWindow } = require('electron');
const { fork } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const PORT = 8731;
let serverProc = null;

// 显式钉死数据目录：不随 app 显示名（网页收藏）变化，保证升级/改名不丢库。
// （package.json 的 name 决定默认 userData；改名会换目录，这里覆盖掉。）
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'pagevault-desktop'));
} catch (e) { /* 老版本 Electron 不支持时用默认值 */ }

function serverScriptPath() {
  const packed = path.join(process.resourcesPath, 'server', 'server.js');
  const dev = path.join(__dirname, '..', 'server', 'server.js');
  return fs.existsSync(packed) ? packed : dev;
}

function waitForPort(port, cb, tries) {
  tries = tries || 60;
  const sock = net.connect(port, '127.0.0.1');
  sock.on('connect', () => { sock.destroy(); cb(true); });
  sock.on('error', () => {
    sock.destroy();
    if (tries <= 0) return cb(false);
    setTimeout(() => waitForPort(port, cb, tries - 1), 100);
  });
}

function startServer(cb) {
  const script = serverScriptPath();
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    PAGEVAULT_DATA: path.join(app.getPath('userData'))
  });
  serverProc = fork(script, [], { env, silent: false });
  serverProc.on('exit', (code) => { if (code) console.log('[pagevault] server exited', code); });
  waitForPort(PORT, cb);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 820,
    minHeight: 600,
    title: '网页收藏 · 我的网页库',
    backgroundColor: '#f7f8fa',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.on('closed', () => {});
}

function stopServer() {
  if (serverProc) { try { serverProc.kill(); } catch (e) {} serverProc = null; }
}

app.whenReady().then(() => {
  startServer((ok) => {
    if (!ok) {
      console.error('[pagevault] server failed to start');
      app.quit();
      return;
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
});

app.on('window-all-closed', () => {
  // On macOS keep app (and server) alive in dock so the extension can keep saving.
  if (process.platform !== 'darwin') {
    stopServer();
    app.quit();
  }
});

app.on('before-quit', stopServer);
