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

// 小请求：先试 Node 原生 http(s)，失败（企业代理/TLS 拦截等）自动 fallback 到 curl。
// 返回 { status, headers: {location, content-length, ...}, body: Buffer }
function httpGet(url, headers, timeoutMs) {
  return nodeGet(url, headers, timeoutMs).catch((e) => curlGet(url, headers, timeoutMs, e));
}

function nodeGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}), timeout: timeoutMs || 12000 }, (res) => {
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
function httpGetStream(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}), timeout: timeoutMs || 30000 }, (res) => {
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

// 各平台随 Release 分发的文件名
function assetName(platform, version) {
  if (platform === 'win32') return `WebVault-win32-x64.zip`;
  if (platform === 'darwin') return `pagevault-macos-x64.zip`;
  return `WebVault-linux-x64.zip`;
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

  // ---------- 版本探测：走 302 Location，不调 API ----------
  async checkLatest() {
    this.emit({ status: 'checking', error: '' });
    try {
      const r = await httpGet(LATEST_URL, {}, 12000);
      // Location 形如 /feibixunchang/pagevault/releases/tag/v0.6.0
      const m = (r.headers.location || '').match(/\/tag\/(v?[\d.]+)/);
      if (!m) throw new Error('无法解析最新版本号（HTTP ' + r.status + '）');
      const tag = m[1].startsWith('v') ? m[1] : 'v' + m[1];
      const has = isNewer(tag, this.currentVersion);
      this.emit(has
        ? { status: 'available', remoteVersion: tag, error: '' }
        : { status: 'not-available', remoteVersion: tag, error: '' });
      return tag;
    } catch (e) {
      this.emit({ status: 'error', error: e.message });
      return null;
    }
  }

  // ---------- 渠道测速：Range 拉前 128KB，算带宽 ----------
  async speedTest(tag, file) {
    const urls = channelUrls(tag, file);
    const RANGE_BYTES = 128 * 1024;
    const results = await Promise.all(urls.map(u => this._probe(u, RANGE_BYTES)));
    const ok = results.filter(r => r.ok).sort((a, b) => b.bps - a.bps);
    this.emit({ status: 'available', remoteVersion: tag, channels: ok, error: ok.length ? '' : '所有下载渠道都连不上' });
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

module.exports = { Updater, isNewer, parseVersion, channelUrls, assetName, CHANNELS, REPO };
