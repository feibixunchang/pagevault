'use strict';

// PageVault desktop (macOS) launcher.
// Bundles the sync server (server/server.js) as an Electron child node process and
// opens a native window rendering the reader UI. The browser extension talks to the
// same localhost:8731 endpoint, so all six ends share one protocol.

const { app, BrowserWindow, nativeTheme, Menu, shell } = require('electron');
const { fork } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

// 扩展目录：随安装包分发（Mac: Contents/Resources/extension，Win: 解压目录/extension）
function extensionDir() {
  const packed = path.join(process.resourcesPath, 'extension');
  const dev = path.join(__dirname, '..', '..', 'extension');
  for (const d of [packed, dev]) {
    try { if (fs.existsSync(path.join(d, 'manifest.json'))) return d; } catch { /* 试下一个 */ }
  }
  return null;
}

// 打开扩展管理页 + 在访达/资源管理器里定位扩展文件夹（加载已解压的扩展程序时选它）
function installExtension() {
  const dir = extensionDir();
  log('install-extension clicked, dir =', dir || '(not found)');
  try { shell.openExternal('chrome://extensions/'); } catch (e) { log('openExternal chrome:// failed:', e && e.message); }
  if (dir) shell.showItemInFolder(dir);
}

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
  const appName = zh ? '网页收藏' : 'Web Vault';
  const L = zh ? {
    app: appName, about: '关于' + appName, quit: '退出' + appName,
    file: '文件', close: '关闭窗口',
    edit: '编辑', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
    view: '显示', reload: '重新加载', forceReload: '强制重新加载', devtools: '开发者工具',
    resetZoom: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullscreen: '全屏',
    window: '窗口', minimize: '最小化', zoomWin: '缩放', front: '全部置于顶层',
    help: '帮助', installExt: '安装浏览器扩展…',
    // macOS 系统菜单项：role 的默认标签是英文，中文系统下显式覆盖
    services: '服务', hide: '隐藏' + appName, hideOthers: '隐藏其他', unhide: '全部显示'
  } : {
    app: appName, about: 'About ' + appName, quit: 'Quit ' + appName,
    file: 'File', close: 'Close Window',
    edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    view: 'View', reload: 'Reload', forceReload: 'Force Reload', devtools: 'Developer Tools',
    resetZoom: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Toggle Fullscreen',
    window: 'Window', minimize: 'Minimize', zoomWin: 'Zoom', front: 'Bring All to Front',
    help: 'Help', installExt: 'Install Browser Extension…',
    services: 'Services', hide: 'Hide ' + appName, hideOthers: 'Hide Others', unhide: 'Show All'
  };
  const template = [
    { label: L.app, submenu: [ { label: L.about, role: 'about' }, { type: 'separator' }, { label: L.services, role: 'services' }, { type: 'separator' }, { label: L.hide, role: 'hide' }, { label: L.hideOthers, role: 'hideOthers' }, { label: L.unhide, role: 'unhide' }, { type: 'separator' }, { label: L.quit, role: 'quit' } ] },
    { label: L.file, submenu: [ { label: L.close, role: 'close' } ] },
    { label: L.edit, submenu: [ { label: L.undo, role: 'undo' }, { label: L.redo, role: 'redo' }, { type: 'separator' }, { label: L.cut, role: 'cut' }, { label: L.copy, role: 'copy' }, { label: L.paste, role: 'paste' }, { label: L.selectAll, role: 'selectAll' } ] },
    { label: L.view, submenu: [ { label: L.reload, role: 'reload' }, { label: L.forceReload, role: 'forceReload' }, { label: L.devtools, role: 'toggleDevTools' }, { type: 'separator' }, { label: L.resetZoom, role: 'resetZoom' }, { label: L.zoomIn, role: 'zoomIn' }, { label: L.zoomOut, role: 'zoomOut' }, { type: 'separator' }, { label: L.fullscreen, role: 'togglefullscreen' } ] },
    { label: L.window, submenu: [ { label: L.minimize, role: 'minimize' }, { label: L.zoomWin, role: 'zoom' }, { type: 'separator' }, { label: L.front, role: 'front' } ] },
    { label: L.help, submenu: [ { label: L.installExt, click: installExtension } ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const PORT = 8731;
let serverProc = null;
let mainWin = null;
let quitting = false;
let serverRestarts = 0;

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

// 文件日志：Windows 上双击出问题时，去 %APPDATA%\pagevault-desktop\desktop.log 看
const LOG_FILE = path.join(app.getPath('userData'), 'desktop.log');
function log() {
  const line = new Date().toISOString() + ' ' + Array.from(arguments).join(' ') + '\n';
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* 日志写不出去不影响主流程 */ }
}

function startServer(cb) {
  // 端口已被占用（比如另一个实例/Mac 端）→ 直接复用，不重复 fork
  const probe = net.connect(PORT, '127.0.0.1');
  probe.on('connect', () => { probe.destroy(); log('port ' + PORT + ' already in use, reusing existing server'); cb(true); });
  probe.on('error', () => {
    probe.destroy();
    const script = serverScriptPath();
    log('forking server:', script, 'node:', process.versions.node, 'platform:', process.platform);
    const env = Object.assign({}, process.env, {
      PORT: String(PORT),
      PAGEVAULT_DATA: path.join(app.getPath('userData'))
    });
    try {
      serverProc = fork(script, [], { env, silent: false });
      serverProc.on('exit', (code) => {
        log('server process exited, code =', code);
        serverProc = null;
        if (quitting) return;
        // 服务意外挂掉：窗口先切错误页，再自动重启（有上限，防崩溃循环）；
        // 重启成功则窗口自动回到阅读器
        if (!mainWin || mainWin.isDestroyed()) return;
        mainWin.loadURL(localPage('error'));
        if (serverRestarts >= 3) { log('server crashed too many times, giving up'); return; }
        serverRestarts++;
        setTimeout(() => {
          if (quitting || !mainWin || mainWin.isDestroyed()) return;
          log('restarting server after unexpected exit, attempt', serverRestarts);
          startServer((ok) => {
            if (mainWin && !mainWin.isDestroyed()) {
              mainWin.loadURL(ok ? `http://127.0.0.1:${PORT}/` : localPage('error'));
            }
          });
        }, 2000);
      });
      serverProc.on('error', (e) => { log('server spawn error:', e && e.message); cb(false); });
    } catch (e) {
      log('fork threw:', e && e.message);
      cb(false);
      return;
    }
    waitForPort(PORT, cb);
  });
}

// ---------- 内置页面：连接中 / 启动失败 ----------
// Windows 双击出问题时用户能直接看到提示（而不是闪退或白屏）；日志路径一并显示。
function localPage(kind) {
  const c = themeColors();
  const zh = (app.getLocale() || '').toLowerCase().startsWith('zh');
  const title = kind === 'connecting'
    ? (zh ? '正在启动本地服务…' : 'Starting the local service…')
    : (zh ? '本地服务启动失败' : 'Local service failed to start');
  const body = kind === 'connecting'
    ? (zh ? '首次启动需要几秒钟，请稍候。' : 'First launch takes a few seconds, please wait.')
    : (zh ? '可以试试：① 暂时关闭杀毒软件/安全卫士再打开；② 右键 网页收藏.exe → 属性 → 勾选「解除锁定」→ 确定，再双击。'
          : 'Try: ① temporarily disable your antivirus and launch again; ② right-click the exe → Properties → check "Unblock" → OK, then double-click again.');
  const hint = kind === 'connecting' ? ''
    : (zh ? '诊断日志：' : 'Diagnostic log: ') + LOG_FILE;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:${c.bg};color:${c.text};
      font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
    .card{background:${c.panel};border:1px solid ${c.border};border-radius:14px;padding:34px 40px;max-width:540px;text-align:center;
      box-shadow:0 10px 34px rgba(0,0,0,.14)}
    h1{font-size:17px;margin:0 0 12px}
    p{font-size:13px;line-height:1.75;color:${c.muted};margin:0 0 10px}
    p.log{font-size:11px;word-break:break-all}
    .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:${c.accent};margin-right:8px;animation:p 1s infinite alternate}
    @keyframes p{from{opacity:.25}to{opacity:1}}
  </style></head><body><div class="card">
    <h1>${kind === 'connecting' ? '<span class="dot"></span>' : '&#9888; '}${title}</h1>
    <p>${body}</p>${hint ? '<p class="log">' + hint + '</p>' : ''}
  </div></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// 跟随系统深浅色：窗口背景色 + 标题栏（Windows 11 titleBarOverlay）与阅读器主页面同色
// 注意：macOS 上若启动环境丢了 AppleInterfaceStyle（如从终端/strip 环境启动），
// nativeTheme 会把深色系统误判成浅色 → 标题栏浅、内容深。用 defaults 读全局设置兜底一次。
let nativeThemeReliable = false; // 收到过 'updated' 事件后完全信任 nativeTheme
function systemIsDarkFallback() {
  if (process.platform !== 'darwin') return false;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('defaults', ['read', '-g', 'AppleInterfaceStyle'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /dark/i.test(out);
  } catch { return false; }
}
function themeColors() {
  let dark = nativeTheme.shouldUseDarkColors;
  if (!dark && !nativeThemeReliable && systemIsDarkFallback()) {
    dark = true;
    log('nativeTheme says light but system is dark (env lost AppleInterfaceStyle), using dark');
  }
  return dark
    ? { bg: '#131518', panel: '#1c1f26', text: '#e8eaed', muted: '#9aa3af', accent: '#6cb2f2', border: '#2e3340' }
    : { bg: '#f7f8fa', panel: '#ffffff', text: '#1f2933', muted: '#6b7280', accent: '#185fa5', border: '#e3e6ea' };
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

function createWindow(url) {
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
  // 运行时图标（Windows 任务栏等；macOS 用 bundle 里的 icns，自动忽略）
  for (const ic of [path.join(process.resourcesPath, 'AppIcon.ico'), path.join(__dirname, '..', 'AppIcon.ico')]) {
    try { if (fs.existsSync(ic)) { opts.icon = ic; break; } } catch { /* 忽略 */ }
  }
  if (process.platform === 'win32') {
    opts.titleBarOverlay = { color: c.panel, symbolColor: c.text, height: 36 };
  }
  const win = new BrowserWindow(opts);
  win.loadURL(url || `http://127.0.0.1:${PORT}/`);
  // 页面里点 chrome://extensions、http(s) 等链接 → 转交系统浏览器打开，不在 app 内开新窗
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    try {
      if (/^(chrome|edge|brave|vivaldi|opera|about|https?):/i.test(u)) shell.openExternal(u);
    } catch (e) { log('openExternal failed:', e && e.message); }
    return { action: 'deny' };
  });
  win.on('closed', () => {});
  return win;
}

function stopServer() {
  quitting = true;
  if (serverProc) { try { serverProc.kill(); } catch (e) {} serverProc = null; }
}

// 单实例：Windows 上重复双击时聚焦已有窗口，不再起第二份（也避免两个实例抢端口）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second-instance: focusing existing window');
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
  });

  app.whenReady().then(() => {
    log('==== app ready ==== electron ' + process.versions.electron + ' platform ' + process.platform + ' locale ' + app.getLocale());
    buildMenu();
    // 先出窗口（显示"正在连接"），再去起服务：失败也看得到界面，不再是双击无反应
    mainWin = createWindow(localPage('connecting'));
    startServer((ok) => {
      log('startServer -> ' + (ok ? 'ok' : 'FAILED'));
      if (!mainWin || mainWin.isDestroyed()) return;
      mainWin.loadURL(ok ? `http://127.0.0.1:${PORT}/` : localPage('error'));
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWin = createWindow();
    });
    // 系统深浅色切换时，实时更新所有窗口的标题栏/背景
    nativeTheme.on('updated', () => {
      nativeThemeReliable = true; // 此后 nativeTheme 已与系统同步，不再用 defaults 兜底
      for (const w of BrowserWindow.getAllWindows()) applyThemeToWindow(w);
    });
  });
}

app.on('window-all-closed', () => {
  // On macOS keep app (and server) alive in dock so the extension can keep saving.
  if (process.platform !== 'darwin') {
    stopServer();
    app.quit();
  }
});

app.on('before-quit', stopServer);
