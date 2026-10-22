'use strict';

// PageVault desktop (macOS) launcher.
// Bundles the sync server (server/server.js) as an Electron child node process and
// opens a native window rendering the reader UI. The browser extension talks to the
// same localhost:8731 endpoint, so all six ends share one protocol.

const { app, BrowserWindow, nativeTheme, Menu } = require('electron');
const { fork } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

// 本地化应用菜单（跟随系统语言；设置里选的语言下次启动生效——启动时读 prefs.json）
function buildMenu() {
  let langPref = 'system';
  try {
    const prefsPath = path.join(app.getPath('userData'), 'prefs.json');
    if (fs.existsSync(prefsPath)) {
      const p = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      if (p && p.lang) langPref = p.lang;
    }
  } catch { /* 读不到用系统语言 */ }
  const zh = langPref === 'zh' || (langPref === 'system' && app.getLocale().toLowerCase().startsWith('zh'));
  const L = zh ? {
    app: '网页收藏', about: '关于网页收藏', quit: '退出网页收藏',
    file: '文件', close: '关闭窗口',
    edit: '编辑', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
    view: '显示', reload: '重新加载', forceReload: '强制重新加载', devtools: '开发者工具',
    resetZoom: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullscreen: '全屏',
    window: '窗口', minimize: '最小化', zoomWin: '缩放', front: '全部置于顶层',
    help: '帮助'
  } : {
    app: 'Web Vault', about: 'About Web Vault', quit: 'Quit Web Vault',
    file: 'File', close: 'Close Window',
    edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    view: 'View', reload: 'Reload', forceReload: 'Force Reload', devtools: 'Developer Tools',
    resetZoom: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Toggle Fullscreen',
    window: 'Window', minimize: 'Minimize', zoomWin: 'Zoom', front: 'Bring All to Front',
    help: 'Help'
  };
  const template = [
    { label: L.app, submenu: [ { label: L.about, role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: L.quit, role: 'quit' } ] },
    { label: L.file, submenu: [ { label: L.close, role: 'close' } ] },
    { label: L.edit, submenu: [ { label: L.undo, role: 'undo' }, { label: L.redo, role: 'redo' }, { type: 'separator' }, { label: L.cut, role: 'cut' }, { label: L.copy, role: 'copy' }, { label: L.paste, role: 'paste' }, { label: L.selectAll, role: 'selectAll' } ] },
    { label: L.view, submenu: [ { label: L.reload, role: 'reload' }, { label: L.forceReload, role: 'forceReload' }, { label: L.devtools, role: 'toggleDevTools' }, { type: 'separator' }, { label: L.resetZoom, role: 'resetZoom' }, { label: L.zoomIn, role: 'zoomIn' }, { label: L.zoomOut, role: 'zoomOut' }, { type: 'separator' }, { label: L.fullscreen, role: 'togglefullscreen' } ] },
    { label: L.window, submenu: [ { label: L.minimize, role: 'minimize' }, { label: L.zoomWin, role: 'zoom' }, { type: 'separator' }, { label: L.front, role: 'front' } ] },
    { label: L.help, submenu: [] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

// 跟随系统深浅色：窗口背景色 + 标题栏（Windows 11 titleBarOverlay）与阅读器主页面同色
function themeColors() {
  return nativeTheme.shouldUseDarkColors
    ? { bg: '#131518', panel: '#1c1f26', text: '#e8eaed' }
    : { bg: '#f7f8fa', panel: '#ffffff', text: '#1f2933' };
}

function applyThemeToWindow(win) {
  if (!win || win.isDestroyed()) return;
  const c = themeColors();
  win.setBackgroundColor(c.bg);
  // Windows 11：标题栏覆盖层颜色跟随（Win10 自动忽略此字段）
  if (process.platform === 'win32') {
    try {
      win.setTitleBarOverlay({ color: c.panel, symbolColor: c.text, height: 36 });
    } catch { /* 老版本 Electron 不支持就忽略 */ }
  }
}

function createWindow() {
  const c = themeColors();
  const opts = {
    width: 1280,
    height: 800,
    minWidth: 820,
    minHeight: 600,
    title: '网页收藏 · 我的网页库',
    backgroundColor: c.bg,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  };
  if (process.platform === 'win32') {
    opts.titleBarOverlay = { color: c.panel, symbolColor: c.text, height: 36 };
  }
  const win = new BrowserWindow(opts);
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.on('closed', () => {});
  return win;
}

function stopServer() {
  if (serverProc) { try { serverProc.kill(); } catch (e) {} serverProc = null; }
}

app.whenReady().then(() => {
  buildMenu();
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
    // 系统深浅色切换时，实时更新所有窗口的标题栏/背景
    nativeTheme.on('updated', () => {
      for (const w of BrowserWindow.getAllWindows()) applyThemeToWindow(w);
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
