'use strict';

// PageVault desktop (macOS) launcher.
// Bundles the sync server (server/server.js) as an Electron child node process and
// opens a native window rendering the reader UI. The browser extension talks to the
// same localhost:8731 endpoint, so all six ends share one protocol.

const { app, BrowserWindow, nativeTheme, Menu, shell, ipcMain, dialog } = require('electron');
const { fork } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');

const { Updater, assetNames, isNewer } = require('./updater.js');

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
  const { zh } = uiLang();
  const appName = zh ? '网页收藏' : 'Web Vault';
  const L = zh ? {
    app: appName, about: '关于' + appName, quit: '退出' + appName,
    file: '文件', close: '关闭窗口',
    edit: '编辑', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
    view: '显示', reload: '重新加载', forceReload: '强制重新加载', devtools: '开发者工具',
    resetZoom: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullscreen: '全屏',
    window: '窗口', minimize: '最小化', zoomWin: '缩放', front: '全部置于顶层',
    help: '帮助', installExt: '安装浏览器扩展…',
    openWeb: '在浏览器打开网页版',
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
    openWeb: 'Open Web UI in Browser',
    services: 'Services', hide: 'Hide ' + appName, hideOthers: 'Hide Others', unhide: 'Show All'
  };
  const template = [
    { label: L.app, submenu: [ { label: L.about, role: 'about' }, { type: 'separator' }, { label: L.services, role: 'services' }, { type: 'separator' }, { label: L.hide, role: 'hide' }, { label: L.hideOthers, role: 'hideOthers' }, { label: L.unhide, role: 'unhide' }, { type: 'separator' }, { label: L.quit, role: 'quit' } ] },
    { label: L.file, submenu: [ { label: L.close, role: 'close' } ] },
    { label: L.edit, submenu: [ { label: L.undo, role: 'undo' }, { label: L.redo, role: 'redo' }, { type: 'separator' }, { label: L.cut, role: 'cut' }, { label: L.copy, role: 'copy' }, { label: L.paste, role: 'paste' }, { label: L.selectAll, role: 'selectAll' } ] },
    { label: L.view, submenu: [ { label: L.reload, role: 'reload' }, { label: L.forceReload, role: 'forceReload' }, { label: L.devtools, role: 'toggleDevTools' }, { type: 'separator' }, { label: L.resetZoom, role: 'resetZoom' }, { label: L.zoomIn, role: 'zoomIn' }, { label: L.zoomOut, role: 'zoomOut' }, { type: 'separator' }, { label: L.fullscreen, role: 'togglefullscreen' } ] },
    { label: L.window, submenu: [ { label: L.minimize, role: 'minimize' }, { label: L.zoomWin, role: 'zoom' }, { type: 'separator' }, { label: L.front, role: 'front' } ] },
    { label: L.help, submenu: [
      { label: L.installExt, click: installExtension },
      { label: L.openWeb, click: () => { try { shell.openExternal(`http://127.0.0.1:${PORT}/`); } catch (e) { log('openExternal failed:', e && e.message); } } },
      { type: 'separator' },
      { label: zh ? '检查更新…' : 'Check for Updates…', click: checkForUpdatesFromMenu }
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const PORT = 8731;
let serverProc = null;
let mainWin = null;
let quitting = false;
let serverRestarts = 0;

// ---------- 自动更新 ----------
// 版本探测走多来源并发（github 302 / api.github.com / 镜像代理），下载多渠道测速选最快。
const updater = new Updater({ currentVersion: app.getVersion() });
const promptedVersions = new Set();   // 同一个版本只弹一次原生提示，别反复骚扰
let lastCheckAt = 0;                   // 最后一次**成功**检查的时间
let lastFailAt = 0;                    // 最后一次失败的时间（决定要不要早点重试）
let retryTimer = null;

updater.onEvent((st) => {
  log('updater event:', st.status, st.remoteVersion || '', st.error || '');
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('updater:event', st);
  // 以前只把"有新版本"塞进页面里的小入口，很容易被忽略——改成系统弹窗，
  // 一眼就能看见，点「立即更新」直接进入测速下载流程。
  if (st.status === 'available' && st.remoteVersion) promptUpdate(st.remoteVersion);
});

function uiLang() {
  let langPref = 'system';
  try {
    const prefsPath = path.join(app.getPath('userData'), 'prefs.json');
    if (fs.existsSync(prefsPath)) {
      const p = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      if (p && p.lang) langPref = p.lang;
    }
  } catch { /* 读不到就用系统语言 */ }
  const zh = langPref === 'zh' || (langPref === 'system' && app.getLocale().toLowerCase().startsWith('zh'));
  return { langPref, zh };
}

function promptUpdate(tag) {
  if (promptedVersions.has(tag)) return;
  promptedVersions.add(tag);
  const { zh } = uiLang();
  const remote = String(tag).replace(/^v/, '');
  const local = app.getVersion();
  dialog.showMessageBox(mainWin && !mainWin.isDestroyed() ? mainWin : null, {
    type: 'info',
    buttons: zh ? ['立即更新', '稍后'] : ['Update Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: zh ? '发现新版本' : 'Update available',
    message: zh ? `网页收藏 ${local} → ${remote}` : `WebVault ${local} → ${remote}`,
    detail: zh
      ? '更新会先测速挑最快的下载渠道，下载完成后自动替换并重启，收藏数据不受影响。'
      : 'It will test download mirrors, pick the fastest, then replace and relaunch. Your saved pages are kept.'
  }).then(({ response }) => {
    if (response !== 0) return;
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      mainWin.webContents.send('updater:open-panel', tag);
    }
  }).catch(() => { /* 用户关掉弹窗就当他选了稍后 */ });
}

function readPref(key, dflt) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'prefs.json'), 'utf8'));
    return p && p[key] !== undefined ? p[key] : dflt;
  } catch { return dflt; }
}

function setupUpdaterIPC() {
  ipcMain.handle('updater:check', async () => {
    const tag = await updater.checkLatest();
    const local = app.getVersion();
    // 注意：checkLatest 无论"有新版"还是"已是最新"都会返回 tag，
    // 以前这里写 hasUpdate: !!tag 导致每次手动检查都当成有新版本。
    return {
      tag,
      hasUpdate: !!tag && isNewer(tag, local),
      currentVersion: local,
      error: tag ? '' : (updater.state.error || '')
    };
  });

  ipcMain.handle('updater:channels', async (_e, tag) => {
    const list = await updater.speedTest(tag, assetNames(process.platform, tag));
    return list.map(c => ({ id: c.id, name: c.name, url: c.url, bps: Math.round(c.bps / 1024), ms: c.ms }));
  });

  ipcMain.handle('updater:download', async (_e, url) => {
    // 扩展名跟着资产走：Linux 是 .tar.gz，换错后缀 tar 解不开
    const ext = /\.tar\.gz($|\?)/.test(url) ? '.tar.gz' : '.zip';
    const dest = path.join(os.tmpdir(), 'pagevault-update-' + Date.now() + ext);
    // 尽力而为的 sha256 校验：拿到 GitHub 官方摘要就比对，拿不到则跳过（不阻断更新）
    const tag = updater.state.remoteVersion || '';
    const asset = updater.state.asset || '';
    let expectedSha256 = '';
    try { if (tag && asset) expectedSha256 = await updater.fetchAssetDigest(tag, asset); } catch { /* 取不到就不校验 */ }
    await updater.download(url, dest, {
      expectedSha256,
      onProgress: (p) => updater.emit({ status: 'downloading', progress: p < 0 ? 0 : p })
    });
    return dest;
  });
  ipcMain.handle('updater:cancel', async () => { updater.cancelDownload(); return { ok: true }; });

  ipcMain.handle('updater:install', async (_e, zipPath) => {
    // 就地升级：装到"当前正在运行的这份"所在位置。
    // 原来 Windows 端写死 %LOCALAPPDATA%\Programs\WebVault，从别处解压运行的会把新版装到
    // 另一个目录、再启动一个新副本，旧的一直留着——用户就感觉"更新没生效"。
    const opts = {};
    if (process.platform === 'win32') {
      opts.targetDir = path.dirname(process.execPath);
    } else if (process.platform === 'darwin') {
      const m = process.execPath.match(/^(.*?\.app)\/Contents\/MacOS\//);
      opts.targetApp = m ? m[1] : path.join(os.homedir(), 'Applications', '网页收藏.app');
    }
    const r = await updater.install(zipPath, opts);
    // 装好了就把下载目录里的更新包删掉（100~200MB，留着只会一直占 tmp）
    setTimeout(() => { try { fs.unlinkSync(zipPath); } catch { /* 已被 mac 安装流程删掉/无权限就跳过 */ } }, 500);
    // 覆盖安装后必须真的退出：macOS 的 open 会激活"已在运行的旧进程"，
    // 不退出的话点完更新界面没变化，用户会以为没装上。
    setTimeout(() => { quitting = true; app.quit(); }, 1200);
    return r;
  });

  ipcMain.handle('updater:version', () => app.getVersion());

  // 在系统默认浏览器里打开网页版（桌面窗口里就是这套页面，浏览器打开方便
  // 复制粘贴、多标签，也顺手验证了局域网内其他设备能访问）
  ipcMain.handle('web:open', async (_e, u) => {
    let url = String(u || '').trim();
    // 只允许打开本机服务，防渲染层被注入后借这个口子开任意网址
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(url)) url = `http://127.0.0.1:${PORT}/`;
    await shell.openExternal(url);
    return url;
  });

  // 启动后自动检查：失败会重试（开机后网络常常还没起来），之后每 6 小时再查一次
  const auto = readPref('autoUpdate', true);
  log('autoUpdate pref =', auto);
  if (auto) {
    setTimeout(() => { checkWithRetry(); }, 4000);
    const timer = setInterval(() => { checkWithRetry(); }, 6 * 3600 * 1000);
    if (timer.unref) timer.unref();
  }
}

/// 带回退重试的检查：GitHub 首次请求经常因为刚开机没网 / 代理没起来失败，
/// 而原来失败是**完全静默**的——用户只看到"没有提示"，以为功能不存在。
let updateChecking = false;   // 6h 定时器 / 窗口 focus / 30min 重试可能叠着触发，同一时间只跑一轮
async function checkWithRetry() {
  if (updateChecking) return null;
  updateChecking = true;
  try {
    const delays = [0, 8000, 30000];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
      const tag = await updater.checkLatest();
      if (tag) {
        lastCheckAt = Date.now();
        return tag;                        // 成功（含"已是最新"）就不再重试
      }
    }
    lastFailAt = Date.now();
    log('update check failed after retries:', updater.state.error || '');
    // 失败后 30 分钟再试一次：原来要等 6 小时的定时器，刚开机没网/代理没起来的人
    // 基本就错过整个版本了（Windows 端"有新版本却不提示"多半就是这一条）。
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (readPref('autoUpdate', true) === false) return;
        checkWithRetry();
      }, 30 * 60 * 1000);
      if (retryTimer.unref) retryTimer.unref();
    }
    return null;
  } finally {
    updateChecking = false;
  }
}

// 菜单「检查更新…」：主进程自己查、自己弹结果。
// 不能只往渲染进程发事件——页面还没加载完 / preload 挂了（v1.2.0~v1.4.0 就是这种情况）
// 时，发过去就是石沉大海，用户点完菜单什么反应都没有。
async function checkForUpdatesFromMenu() {
  const { zh } = uiLang();
  const parent = mainWin && !mainWin.isDestroyed() ? mainWin : null;
  const local = app.getVersion();
  const tag = await updater.checkLatest();
  if (!tag) {
    dialog.showMessageBox(parent, {
      type: 'error',
      buttons: [zh ? '知道了' : 'OK'],
      noLink: true,
      title: zh ? '检查更新失败' : 'Update check failed',
      message: zh ? '连不上 GitHub，暂时无法检查新版本' : 'Could not reach GitHub',
      detail: ((updater.state.error || '') + (zh
        ? '\n\n更新检查会走 GitHub 官方和多个镜像，全都失败通常是网络/代理问题。稍后会自动重试。'
        : '\n\nThe check tries GitHub and several mirrors. All failing usually means a network/proxy issue. It will retry later.'))
    }).catch(() => {});
    return;
  }
  if (!isNewer(tag, local)) {
    dialog.showMessageBox(parent, {
      type: 'info',
      buttons: [zh ? '好的' : 'OK'],
      noLink: true,
      title: zh ? '已是最新版本' : 'Up to date',
      message: zh ? `当前 ${local}，已是最新版本` : `You are on ${local}, the latest version`
    }).catch(() => {});
    return;
  }
  promptedVersions.delete(tag);   // 手动检查必须弹，不受"只提示一次"限制
  promptUpdate(tag);
}

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

// 端口被占用时，要确认对方真的是"本程序的另一个实例"（比如上次没退干净的窗口），
// 而不是随便哪个占着 8731 的程序 —— 后者会让窗口加载出一个陌生页面，
// 用户看到的是"打开就变了个网站"，比报错还难查。
function probePageVault(cb) {
  let done = false;
  const finish = (ok) => { if (!done) { done = true; cb(ok); } };
  try {
    const req = require('http').get(
      { host: '127.0.0.1', port: PORT, path: '/api/status', timeout: 1500 },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; if (buf.length > 16384) { res.destroy(); finish(false); } });
        res.on('end', () => {
          try { finish(!!JSON.parse(buf).ok); } catch { finish(false); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
  } catch { finish(false); }
}

function startServer(cb) {
  // 端口已被占用（比如另一个实例/Mac 端）→ 直接复用，不重复 fork
  const probe = net.connect(PORT, '127.0.0.1');
  probe.on('connect', () => {
    probe.destroy();
    probePageVault((isPv) => {
      if (isPv) {
        log('port ' + PORT + ' already serving PageVault, reusing existing server');
        serverRestarts = 0;   // 端口有服务=状态健康，复位崩溃计数，别让它长期停在"放弃重启"
        cb(true);
      } else {
        log('port ' + PORT + ' is occupied by another program');
        cb(false, 'port-busy');
      }
    });
  });
  probe.on('error', () => {
    probe.destroy();
    const script = serverScriptPath();
    log('forking server:', script, 'node:', process.versions.node, 'platform:', process.platform);
    const env = Object.assign({}, process.env, {
      PORT: String(PORT),
      PAGEVAULT_DATA: path.join(app.getPath('userData')),
      // 让服务端知道自己是"桌面壳里跑着"，状态栏才会显示「桌面版 v1.0.0」
      // 而不是「网页版」（Docker 端由镜像里的 PAGEVAULT_PLATFORM=docker 覆盖）
      PAGEVAULT_PLATFORM: 'desktop'
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
function localPage(kind, reason) {
  const c = themeColors();
  const zh = (app.getLocale() || '').toLowerCase().startsWith('zh');
  const title = kind === 'connecting'
    ? (zh ? '正在启动本地服务…' : 'Starting the local service…')
    : (zh ? '本地服务启动失败' : 'Local service failed to start');
  const body = kind === 'connecting'
    ? (zh ? '首次启动需要几秒钟，请稍候。' : 'First launch takes a few seconds, please wait.')
    : reason === 'port-busy'
      ? (zh ? '端口 8731 被别的程序占用了，网页收藏起不来。关掉占用它的程序（常见的是别的开发服务器，或上次没退干净的旧副本），再打开一次。'
            : 'Port 8731 is taken by another program, so PageVault cannot start. Quit whatever is using it (often an old copy that did not exit cleanly, or another dev server) and open the app again.')
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
    title: '网页收藏 · 我的网页库 v' + app.getVersion(),
    backgroundColor: c.bg,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
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
  // 窗口关掉后别留着一个已销毁的引用：macOS 上所有窗口关了 app 还活着，
  // 之后 activate 会重建窗口，这里不同步清掉就会拿旧引用去 isDestroyed()
  win.on('closed', () => { if (mainWin === win) mainWin = null; });
  // 长时间挂着（笔记本合盖一晚上）后再回到应用，顺手补一次检查，别等到 6 小时定时器
  win.on('focus', () => {
    if (readPref('autoUpdate', true) === false) return;
    // 成功过：2 小时内不重复查；上次失败：10 分钟后允许再试（别让关机重开也干等 6 小时）
    if (lastCheckAt && Date.now() - lastCheckAt < 2 * 3600 * 1000) return;
    if (lastFailAt && Date.now() - lastFailAt < 10 * 60 * 1000) return;
    checkWithRetry();
  });
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
    setupUpdaterIPC();
    // 先出窗口（显示"正在连接"），再去起服务：失败也看得到界面，不再是双击无反应
    mainWin = createWindow(localPage('connecting'));
    startServer((ok, reason) => {
      log('startServer -> ' + (ok ? 'ok' : 'FAILED') + (reason ? ' (' + reason + ')' : ''));
      if (!mainWin || mainWin.isDestroyed()) return;
      mainWin.loadURL(ok ? `http://127.0.0.1:${PORT}/` : localPage('error', reason));
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
