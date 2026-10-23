'use strict';

// 网页收藏 · 自动更新（零依赖）
// 设计：
//   1. 版本探测走 github.com/.../releases/latest 的 302 Location（不依赖 api.github.com，
//      国内网络下 API 经常 403，而 www 域名一般可达）
//   2. 下载多渠道 + 测速选最快：GitHub 官方 + 若干国内镜像，Range 请求前 128KB 实测带宽
//   3. 安装：macOS 解压替换 .app 后 relaunch；Windows 解压 + detached PowerShell 替换重启
// 所有回调经 onEvent 推给主进程 → IPC → 阅读器 UI。

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { URL } = require('url');

const REPO = 'feibixunchang/pagevault';
const LATEST_URL = `https://github.com/${REPO}/releases/latest`;
const UA = 'WebVault-Updater';

// 版本探测的多个来源：并发打，谁先解析出 tag 用谁。
// v1.4.0 及以前只依赖 github.com 的 302 Location，一旦这条线路在国内网络超时/被拦，
// 检查更新就彻底静默——用户看到的现象就是"明明有新版本，却从不提示"。这里加上
// api.github.com 与几个镜像前缀作为兜底（实测 gh-proxy.com 代理 API 可用）。
const LATEST_SOURCES = [
  { id: 'github', url: LATEST_URL, kind: 'redirect' },
  { id: 'gh-proxy.com', url: `https://gh-proxy.com/https://api.github.com/repos/${REPO}/releases/latest`, kind: 'json' },
  { id: 'api.github.com', url: `https://api.github.com/repos/${REPO}/releases/latest`, kind: 'json' },
  { id: 'ghfast.top', url: `https://ghfast.top/https://api.github.com/repos/${REPO}/releases/latest`, kind: 'json' },
  { id: 'ghproxy.net', url: `https://ghproxy.net/https://api.github.com/repos/${REPO}/releases/latest`, kind: 'json' }
];

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时 ' + Math.round(ms / 1000) + 's')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// 从 302 的 Location 或 JSON 响应体里挖出版本 tag
function extractTag(r) {
  const norm = (s) => (s.startsWith('v') ? s : 'v' + s);
  const loc = (r && r.headers && r.headers.location) || '';
  let m = loc.match(/\/tag\/(v?\d+\.\d+\.\d+)/);
  if (m) return norm(m[1]);
  const text = r && r.body && r.body.length && r.body.length < 2 * 1024 * 1024 ? r.body.toString('utf8') : '';
  if (!text) return null;
  m = text.match(/"tag_name"\s*:\s*"(v?\d+\.\d+\.\d+)"/);
  if (m) return norm(m[1]);
  // 镜像可能直接返回 HTML 页面（跟随后重定向），页面里有 releases/tag/vX.Y.Z
  m = text.match(/releases\/tag\/(v\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

async function probeLatest(src, timeoutMs) {
  const r = await withTimeout(httpGet(src.url, {}, timeoutMs || 10000), (timeoutMs || 10000) + 1500);
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  const tag = extractTag(r);
  if (!tag) throw new Error('无法解析版本号（HTTP ' + r.status + '）');
  return tag;
}

// DNS 兜底（DoH + 双栈）。系统 DNS 被 VPN/加速器弄挂时，Node 原生请求会直接 ENOTFOUND，
// 连 curl 也一样，所以这里复用 server/dnsx.js 先解析出 IP 再连。
// 打包后布局：Contents/Resources/app/updater.js 与 Contents/Resources/server/dnsx.js 同级目录
function loadDnsx() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'server', 'dnsx.js'));
  candidates.push(path.join(__dirname, '..', 'server', 'dnsx.js'));
  for (const c of candidates) {
    try { return require(c); } catch { /* 试下一个 */ }
  }
  return null;
}
const dnsx = loadDnsx();

// 小请求：先试 Node 原生 http(s)，失败（企业代理/TLS 拦截等）自动 fallback 到 curl。
// 返回 { status, headers: {location, content-length, ...}, body: Buffer }
function httpGet(url, headers, timeoutMs) {
  return nodeGet(url, headers, timeoutMs).catch((e) => curlGet(url, headers, timeoutMs, e));
}

async function nodeGet(url, headers, timeoutMs) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const opts = { headers: Object.assign({ 'User-Agent': UA }, headers || {}), timeout: timeoutMs || 12000 };
  if (dnsx) {
    try {
      const { addrs } = await dnsx.resolveHost(u.hostname);
      if (addrs && addrs.length) opts.lookup = dnsx.pinnedLookup(addrs[0].address, addrs[0].family);
    } catch { /* 解析失败就交给系统默认 */ }
  }
  return new Promise((resolve, reject) => {
    const req = mod.get(url, opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: { location: res.headers.location || '', 'content-length': res.headers['content-length'] || '' },
        body: Buffer.concat(chunks)
      }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function curlGet(url, headers, timeoutMs, origErr) {
  return new Promise((resolve, reject) => {
    // 注意：不加 -L——checkLatest 需要看 302 Location，跟随了就丢了
    const args = ['-sS', '--max-time', String(Math.ceil((timeoutMs || 12000) / 1000)), '-A', UA];
    for (const k of Object.keys(headers || {})) args.push('-H', k + ': ' + headers[k]);
    args.push('-w', '\n@@PV_STATUS=%{http_code} @@PV_REDIRECT=%{redirect_url}', url);
    execFile('curl', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((origErr ? origErr.message + ' / ' : '') + 'curl: ' + (stderr || err.message).slice(0, 120)));
        return;
      }
      const m = stdout.match(/\n@@PV_STATUS=(\d+) @@PV_REDIRECT=(.*)$/s);
      if (!m) { resolve({ status: 200, headers: { location: '', 'content-length': '' }, body: Buffer.from(stdout) }); return; }
      resolve({
        status: Number(m[1]),
        headers: { location: (m[2] || '').trim(), 'content-length': '' },
        body: Buffer.from(stdout.slice(0, m.index))
      });
    });
  });
}

// 流式 GET（下载大文件用）：返回 { status, headers, stream }；Node 失败时 fallback curl 子进程 stdout
async function httpGetStream(url, headers, timeoutMs) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const opts = { headers: Object.assign({ 'User-Agent': UA }, headers || {}), timeout: timeoutMs || 30000 };
  if (dnsx) {
    try {
      const { addrs } = await dnsx.resolveHost(u.hostname);
      if (addrs && addrs.length) opts.lookup = dnsx.pinnedLookup(addrs[0].address, addrs[0].family);
    } catch { /* 解析失败交给系统 */ }
  }
  return new Promise((resolve, reject) => {
    const req = mod.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); reject(Object.assign(new Error('redirect'), { redirect: res.headers.location })); return; }
      resolve({ status: res.statusCode, headers: { location: '', 'content-length': res.headers['content-length'] || '' }, stream: res });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => {
      // Node 不通（沙箱/代理/TLS 拦截）：curl 子进程兜底，stdout 即数据流
      const args = ['-sS', '--max-time', '600', '-A', UA];
      for (const k of Object.keys(headers || {})) args.push('-H', k + ': ' + headers[k]);
      args.push(url);
      const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let errBuf = '';
      child.stderr.on('data', d => { errBuf += d.toString(); });
      child.on('error', () => reject(e));
      // curl 拿不到真实 content-length，进度按已下载字节显示
      resolve({ status: 200, headers: { location: '', 'content-length': '' }, stream: child.stdout, child });
    });
  });
}

// 各平台随 Release 分发的文件名。v1.4.0 起统一带版本号（用户下载下来一眼能看出是哪个版本）。
// 老版本（<=1.3.0）的更新器只会拼不带版本号的名字，所以这里返回**候选列表**：
// 先试新名字，探测不到再退回旧名字，避免老客户端卡在旧版升不上来。
function assetNames(platform, version) {
  const v = String(version || '').replace(/^v/, '');
  if (platform === 'win32') return [`WebVault-${v}-win32-x64.zip`, 'WebVault-win32-x64.zip'];
  if (platform === 'darwin') return [`WebVault-${v}-macos-x64.zip`, 'pagevault-macos-x64.zip'];
  return [`WebVault-${v}-linux-x64.tar.gz`, 'WebVault-linux-x64.tar.gz'];
}

function assetName(platform, version) {
  return assetNames(platform, version)[0];
}

// 下载渠道（按 id 去重后并发测速，取最快）。镜像类渠道只是给官方 URL 套前缀，
// 文件内容完全一致（都由 GitHub Releases 托管）。
const CHANNELS = [
  { id: 'official', name: 'GitHub 官方', url: (t, f) => `https://github.com/${REPO}/releases/download/${t}/${f}` },
  { id: 'ghfast', name: 'ghfast 镜像', url: (t, f) => `https://ghfast.top/https://github.com/${REPO}/releases/download/${t}/${f}` },
  { id: 'ghproxy', name: 'ghproxy 镜像', url: (t, f) => `https://ghproxy.net/https://github.com/${REPO}/releases/download/${t}/${f}` },
  { id: 'gh-proxy-com', name: 'gh-proxy.com 镜像', url: (t, f) => `https://gh-proxy.com/https://github.com/${REPO}/releases/download/${t}/${f}` }
];

// 真实下载 URL 由 tag + 文件名拼（CHANNELS 里的 url 工厂第一个参数是 tag）
function channelUrls(tag, file) {
  return CHANNELS.map(c => ({ id: c.id, name: c.name, url: c.url(tag, file) })).filter(c => !!c.url);
}

function parseVersion(v) {
  const m = String(v || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(remote, local) {
  const r = parseVersion(remote), l = parseVersion(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] > l[i]) return true;
    if (r[i] < l[i]) return false;
  }
  return false;
}

class Updater {
  constructor(opts) {
    this.platform = opts.platform || process.platform;
    this.currentVersion = opts.currentVersion || '0.0.0';
    this.listeners = [];
    this.state = { status: 'idle' }; // idle|checking|available|not-available|downloading|ready|error
    this.downloadAbort = null;
  }

  onEvent(fn) { this.listeners.push(fn); }

  emit(patch) {
    this.state = Object.assign({}, this.state, patch);
    for (const fn of this.listeners) {
      try { fn(this.state); } catch { /* UI 回调异常不影响更新流程 */ }
    }
  }

  // ---------- 版本探测：多来源并发，任一成功即可 ----------
  async checkLatest() {
    this.emit({ status: 'checking', error: '' });
    const settled = await Promise.allSettled(LATEST_SOURCES.map(s => probeLatest(s, 10000)));
    const errors = [];
    let tag = null;
    settled.forEach((r, i) => {
      const id = LATEST_SOURCES[i].id;
      if (r.status === 'fulfilled' && r.value) {
        if (!tag) tag = r.value;
      } else {
        errors.push(id + '：' + ((r.reason && r.reason.message) || '失败'));
      }
    });
    if (!tag) {
      // 把每个来源的失败原因都带上，用户/日志里能看出是网络问题还是解析问题
      this.emit({ status: 'error', error: errors.join('；') });
      return null;
    }
    const has = isNewer(tag, this.currentVersion);
    this.emit(has
      ? { status: 'available', remoteVersion: tag, error: '' }
      : { status: 'not-available', remoteVersion: tag, error: '' });
    return tag;
  }

  // ---------- 渠道测速：Range 拉前 128KB，算带宽 ----------
  // files 可以是单个文件名，也可以是候选名数组（新命名 → 旧命名依次探测）
  async speedTest(tag, files) {
    const candidates = Array.isArray(files) ? files : [files];
    let ok = [];
    let used = candidates[0];
    for (const file of candidates) {
      const urls = channelUrls(tag, file);
      const RANGE_BYTES = 128 * 1024;
      const results = await Promise.all(urls.map(u => this._probe(u, RANGE_BYTES)));
      ok = results.filter(r => r.ok).sort((a, b) => b.bps - a.bps);
      if (ok.length) { used = file; break; }
    }
    this.emit({ status: 'available', remoteVersion: tag, asset: used, channels: ok, error: ok.length ? '' : '所有下载渠道都连不上' });
    return ok;
  }

  _probe(entry, bytes) {
    const started = Date.now();
    return httpGet(entry.url, { Range: `bytes=0-${bytes - 1}` }, 8000)
      .then((r) => {
        const ms = Date.now() - started;
        if (r.status !== 200 && r.status !== 206) return { ok: false, id: entry.id };
        const received = r.body.length;
        if (received <= 0) return { ok: false, id: entry.id };
        return { ok: true, id: entry.id, name: entry.name, url: entry.url, bps: (received * 8) / (ms / 1000), ms, received };
      })
      .catch(() => ({ ok: false, id: entry.id }));
  }

  // ---------- 完整下载（带进度） ----------
  async download(url, destPath, onProgress) {
    this.emit({ status: 'downloading', progress: 0, error: '' });
    let got = 0;
    try {
      const r = await httpGetStream(url, {}, 30000);
      if (r.status !== 200) throw new Error('下载失败 HTTP ' + r.status);
      const total = Number(r.headers['content-length'] || 0);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(destPath);
        r.stream.on('data', (c) => {
          got += c.length;
          if (total && onProgress) onProgress(got / total);
          else if (onProgress) onProgress(-1); // 拿不到总大小（curl 兜底时）
        });
        r.stream.on('error', reject);
        out.on('error', reject);
        out.on('finish', () => out.close(resolve));
        r.stream.pipe(out);
      });
      this.emit({ status: 'downloading', progress: 1, error: '' });
      return destPath;
    } catch (e) {
      // 流被中断时 curl 子进程可能还在，补一刀
      try { fs.unlinkSync(destPath); } catch { /* 没下完的文件删不掉就算了 */ }
      throw e;
    }
  }

  cancelDownload() { if (this.downloadAbort) this.downloadAbort(); }

  // ---------- 安装：解压 + 替换 + 重启 ----------
  async install(zipPath, opts) {
    opts = opts || {};
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-upd-'));
    const tag = this.state.remoteVersion || '';
    if (this.platform === 'darwin') {
      const appName = '网页收藏.app';
      // 1. 解压
      await this._run('unzip', ['-q', '-o', zipPath, '-d', tmp]);
      const newApp = path.join(tmp, appName);
      if (!fs.existsSync(newApp)) throw new Error('安装包内没有找到 ' + appName);
      // 2. 目标位置：优先用户指定的（~/Applications），否则与当前进程同目录
      const target = opts.targetApp || path.join(os.homedir(), 'Applications', appName);
      // 3. 备份旧版（便于回滚）
      const backup = target + '.bak-' + Date.now();
      if (fs.existsSync(target)) fs.renameSync(target, backup);
      // 4. 覆盖安装
      await this._run('ditto', ['--rsrc', newApp, target]);
      // 5. 延迟启动新实例（等旧实例退出释放单实例锁和端口），然后退出旧进程
      const relaunch = spawn('/bin/sh', ['-c', `sleep 2; open "${target}"`], { detached: true, stdio: 'ignore' });
      relaunch.unref();
      this.emit({ status: 'ready', installedTo: target, backup });
      return { target, backup };
    }
    if (this.platform === 'win32') {
      // 1. 解压（Win10 1803+ 自带 tar，能解 zip）
      const unpack = path.join(tmp, 'unpacked');
      fs.mkdirSync(unpack, { recursive: true });
      await this._run('tar', ['-xf', zipPath, '-C', unpack]);
      // 2. 找到解压出的目录（zip 内是 WebVault-win32-x64/）
      const inner = fs.readdirSync(unpack).find(n => fs.statSync(path.join(unpack, n)).isDirectory());
      if (!inner) throw new Error('安装包内容异常');
      const src = path.join(unpack, inner);
      const exeName = 'WebVault.exe';
      if (!fs.existsSync(path.join(src, exeName))) throw new Error('安装包内没有 ' + exeName);
      // 3. detached PowerShell：等旧进程退出 → robocopy 覆盖 → 启动新 exe → 清理
      const target = opts.targetDir || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'WebVault');
      const ps = [
        'Start-Sleep 3',
        `Stop-Process -Name WebVault -Force -ErrorAction SilentlyContinue`,
        `robocopy "${src}" "${target}" /MIR /NFL /NDL /NJH /NJS /NC /NS /NP`,
        `Start-Process "${path.join(target, exeName)}"`,
        `Remove-Item -Recurse -Force "${tmp}" -ErrorAction SilentlyContinue`
      ].join('; ');
      const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore' });
      child.unref();
      this.emit({ status: 'ready', installedTo: target });
      return { target };
    }
    if (this.platform === 'linux') {
      // 解压 tar.gz，再整目录覆盖。注意两种安装形态：
      //   a) deb/rpm 装到 /opt/WebVault（属主 root）→ 普通用户写不进去，必须交给包管理器
      //   b) 用户自己解压到 ~/WebVault → 可以就地替换
      // 不做 pkexec 提权（无桌面 polkit 代理时直接静默失败，体验更差），
      // 而是明确告诉用户该跑哪条命令。
      const target = opts.targetDir || path.dirname(process.execPath);
      try {
        fs.accessSync(target, fs.constants.W_OK);
      } catch {
        throw new Error('当前安装位置需要管理员权限，请用包管理器升级：sudo apt install ./WebVault-' +
          (this.state.remoteVersion || '').replace(/^v/, '') + '-linux-x64.deb');
      }
      const unpack = path.join(tmp, 'unpacked');
      fs.mkdirSync(unpack, { recursive: true });
      await this._run('tar', ['-xzf', zipPath, '-C', unpack]);
      const inner = fs.readdirSync(unpack).find(n => {
        try { return fs.statSync(path.join(unpack, n)).isDirectory(); } catch { return false; }
      });
      if (!inner) throw new Error('安装包内容异常');
      const src = path.join(unpack, inner);
      if (!fs.existsSync(path.join(src, 'webvault'))) throw new Error('安装包内没有 webvault 可执行文件');
      // tar -xzf 到同一父目录再整体替换，避免边删边写导致进程正在用的 .so 消失
      const stage = target + '.new-' + Date.now();
      await this._run('cp', ['-a', src + '/.', stage]);
      const old = target + '.old-' + Date.now();
      fs.renameSync(target, old);
      try {
        fs.renameSync(stage, target);
      } catch (e) {
        fs.renameSync(old, target);          // 回滚
        throw e;
      }
      const exe = path.join(target, 'webvault');
      const child = spawn('/bin/sh', ['-c', `sleep 2; "${exe}" >/dev/null 2>&1 &`], { detached: true, stdio: 'ignore' });
      child.unref();
      this.emit({ status: 'ready', installedTo: target });
      return { target, backup: old };
    }
    throw new Error('暂不支持该平台的自动安装：' + this.platform);
  }

  _run(cmd, args) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} 执行失败：${stderr || err.message}`));
        else resolve(stdout);
      });
    });
  }
}

module.exports = { Updater, isNewer, parseVersion, channelUrls, assetName, assetNames, CHANNELS, REPO, LATEST_SOURCES, probeLatest, extractTag };
