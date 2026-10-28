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
const crypto = require('crypto');
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
// follow：3xx 时自动跟随几跳（测速/下载要；版本探测必须不跟，靠 302 的 Location 取 tag）
// maxBytes：响应体上限（测速场景挡"忽略 Range 返回 200 全量"——不设上限会把整包吞进内存）
function httpGet(url, headers, timeoutMs, follow, maxBytes) {
  return nodeGet(url, headers, timeoutMs, 0, follow, maxBytes)
    .catch((e) => curlGet(url, headers, timeoutMs, e, follow, maxBytes));
}

async function nodeGet(url, headers, timeoutMs, redirects, follow, maxBytes) {
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
      // GitHub Releases 的下载地址永远先 302 到 objects.githubusercontent.com，
      // v1.5.9 及以前不跟这个跳转，"GitHub 官方"渠道测速/下载全程是死的。
      const sc = res.statusCode || 0;
      if (sc >= 300 && sc < 400 && res.headers.location && (follow || 0) > (redirects || 0)) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch { reject(new Error('重定向地址不对')); return; }
        nodeGet(next, headers, timeoutMs, (redirects || 0) + 1, follow, maxBytes).then(resolve, reject);
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (maxBytes && size > maxBytes) {
          req.destroy(new Error('响应体超过上限 ' + maxBytes + ' 字节（服务器未按 Range 返回）'));
          return;
        }
        chunks.push(c);
      });
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

function curlGet(url, headers, timeoutMs, origErr, follow, maxBytes) {
  return new Promise((resolve, reject) => {
    // 不加 -L 时保留 302（checkLatest 靠 Location）；测速/下载传 follow 就带上
    const args = ['-sS', '--max-time', String(Math.ceil((timeoutMs || 12000) / 1000)), '-A', UA];
    if (follow) args.push('-L', '--max-redirs', String(follow));
    if (maxBytes) args.push('--max-filesize', String(maxBytes));
    for (const k of Object.keys(headers || {})) args.push('-H', k + ': ' + headers[k]);
    args.push('-w', '\n@@PV_STATUS=%{http_code} @@PV_REDIRECT=%{redirect_url}', url);
    // maxBuffer 也要卡上限：否则 Node 路径被内存护栏掐断后 fallback 到这里，
    // curl 反而把几十 MB 全量吞回内存（实测踩过：护栏形同虚设）。
    const cap = (maxBytes || 2 * 1024 * 1024) * 4;
    execFile('curl', args, { maxBuffer: Math.max(64 * 1024, Math.min(64 * 1024 * 1024, cap)) }, (err, stdout, stderr) => {
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
// 3xx 跟随（GitHub 官方下载地址必 302 跳转）；curl 兜底同理补 -L
async function httpGetStream(url, headers, timeoutMs, hops) {
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
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((hops || 0) >= 5) { reject(new Error('重定向次数太多')); return; }
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch { reject(new Error('重定向地址不对')); return; }
        httpGetStream(next, headers, timeoutMs, (hops || 0) + 1).then(resolve, reject);
        return;
      }
      resolve({ status: res.statusCode, headers: { location: '', 'content-length': res.headers['content-length'] || '' }, stream: res });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => {
      // Node 不通（沙箱/代理/TLS 拦截）：curl 子进程兜底，stdout 即数据流
      const args = ['-sSL', '--max-redirs', '5', '--max-time', '600', '-A', UA];
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
  if (platform === 'darwin') {
    // macOS 从 v1.5.4 起按真实架构分开发包（arm64 / x64）。
    // 之前的包名一律写 -macos-x64，但 M 系列机器上产出的其实是 arm64 —— 名字不可信，
    // 所以这里按当前进程架构先挑对应的那个，再退回旧名字（旧名字仍是可用的 x64 包）。
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const names = [`WebVault-${v}-macos-${arch}.zip`];
    if (arch !== 'x64') names.push(`WebVault-${v}-macos-x64.zip`);
    names.push('pagevault-macos-x64.zip');
    return names;
  }
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

// Windows 应用更新用的 PowerShell 脚本。
// 为什么写成文件而不是 -Command 内联：内联字符串里必然带引号，Node 传参时会把 " 转义成 \"，
// PowerShell 对 \" 的解析和 cmd 不一样，一旦解析失败就是**静默什么都不做**——
// 用户看到的就是"点了更新、窗口关了、什么都没发生"。
// 这里脚本内容全是 ASCII 结构 + 通过 -File 传参数，路径由 PowerShell 自己绑定，不进命令行。
function psScript() {
  return `param(
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$Src,
  [Parameter(Mandatory=$true)][string]$Stage,
  [Parameter(Mandatory=$true)][string]$LogPath
)

$ErrorActionPreference = 'Continue'
function Write-Log([string]$Message) {
  try { Add-Content -LiteralPath $LogPath -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Message) -Encoding UTF8 } catch { }
}

$exe  = Join-Path $Target 'WebVault.exe'
$old  = $Target + '.old-' + (Get-Date -Format 'yyyyMMddHHmmss')

Write-Log '==== 开始应用更新 ===='
Write-Log ('目标目录: ' + $Target)

# 1. 等旧进程真的退出（最多 60 秒），再强杀一次兜底
$waited = 0
while ($waited -lt 120) {
  $p = Get-Process -Name 'WebVault' -ErrorAction SilentlyContinue
  if (-not $p) { break }
  Start-Sleep -Milliseconds 500
  $waited++
}
Get-Process -Name 'WebVault' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 1000
Write-Log '旧进程已退出'

# 2. 目录交换：全程只做 rename，不去覆盖正在被占用的 exe
$swapped = $false
try {
  if (Test-Path -LiteralPath $Target) {
    Rename-Item -LiteralPath $Target -NewName (Split-Path -Leaf $old) -ErrorAction Stop
    Write-Log ('旧目录改名为 ' + (Split-Path -Leaf $old))
  }
  Move-Item -LiteralPath $Src -Destination $Target -ErrorAction Stop
  $swapped = $true
  Write-Log '新版本已就位'
} catch {
  Write-Log ('目录交换失败: ' + $_.Exception.Message)
}

# 3. 失败要回滚，绝不能让用户对着一个被搬走的空目录
if (-not $swapped) {
  if ((Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $Target)) {
    try { Rename-Item -LiteralPath $old -NewName (Split-Path -Leaf $Target) -ErrorAction Stop; Write-Log '已回滚到旧版本' }
    catch { Write-Log ('回滚失败: ' + $_.Exception.Message) }
  } elseif ((Test-Path -LiteralPath $Src) -and -not (Test-Path -LiteralPath $Target)) {
    try { Move-Item -LiteralPath $Src -Destination $Target -ErrorAction Stop; Write-Log '重试移动成功' }
    catch { Write-Log ('重试移动失败: ' + $_.Exception.Message) }
  }
}

# 4. 启动：无论装没装上，都要尽量把窗口还给用户
if (Test-Path -LiteralPath $exe) {
  try { Start-Process -FilePath $exe -WorkingDirectory $Target -ErrorAction Stop; Write-Log '已启动实例' }
  catch { Write-Log ('启动失败: ' + $_.Exception.Message) }
} else {
  Write-Log ('找不到可执行文件: ' + $exe)
}

# 5. 清理。只有"已经换上新版本"才删旧目录；换失败时旧目录是用户唯一的可用副本，
#    必须留着，等他手动恢复或者把日志发过来。
if ($swapped -and (Test-Path -LiteralPath $old)) {
  try { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction Stop } catch { Write-Log '旧目录被占用，留待下次清理' }
} elseif (Test-Path -LiteralPath $old) {
  Write-Log ('旧版本保留在 ' + $old + '，可手动改名回退')
}
if ($swapped -and (Test-Path -LiteralPath $Stage)) {
  try { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction Stop } catch { }
}
Write-Log '==== 结束 ===='
`;
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
    // follow=3：官方渠道先 302 到 objects.githubusercontent，不跟就永远测不出它可用；
    // maxBytes：个别镜像无视 Range 直接回 200 全量，不设上限会把整包（数百 MB）吞进内存。
    return httpGet(entry.url, { Range: `bytes=0-${bytes - 1}` }, 8000, 3, bytes * 4)
      .then((r) => {
        const ms = Date.now() - started;
        if (r.status !== 200 && r.status !== 206) return { ok: false, id: entry.id };
        const received = r.body.length;
        if (received <= 0) return { ok: false, id: entry.id };
        return { ok: true, id: entry.id, name: entry.name, url: entry.url, bps: (received * 8) / (ms / 1000), ms, received };
      })
      .catch(() => ({ ok: false, id: entry.id }));
  }

  // ---------- 完整性校验（尽力而为）：从 Release 资产元数据的 digest 字段取 sha256 ----------
  // 只信 GitHub 官方来源；拿不到就返回 ''（降级为不校验，绝不因取不到摘要就阻断更新）。
  async fetchAssetDigest(tag, filename) {
    if (!tag || !filename) return '';
    const sources = [
      `https://api.github.com/repos/${REPO}/releases/tags/${tag}`,
      `https://gh-proxy.com/https://api.github.com/repos/${REPO}/releases/tags/${tag}`,
      `https://ghfast.top/https://api.github.com/repos/${REPO}/releases/tags/${tag}`
    ];
    for (const s of sources) {
      try {
        const r = await httpGet(s, { Accept: 'application/vnd.github+json' }, 8000);
        if (r.status !== 200) continue;
        const j = JSON.parse(r.body.toString('utf8'));
        const asset = (j.assets || []).find(a => a && a.name === filename);
        const dg = asset && asset.digest;
        if (asset && /^sha256-[0-9a-f]{64}$/i.test(String(dg || ''))) return String(dg).replace(/^sha256-/i, '').toLowerCase();
      } catch { /* 换下一个源 */ }
    }
    return '';
  }

  // ---------- 完整下载（带进度 + 可取消 + 可选 sha256 校验）----------
  // opts: { onProgress(p), expectedSha256 }
  async download(url, destPath, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress;
    const expectedSha256 = String(opts.expectedSha256 || '').toLowerCase();
    this.emit({ status: 'downloading', progress: 0, error: '' });
    let got = 0;
    try {
      const r = await httpGetStream(url, {}, 30000);
      if (r.status !== 200) throw new Error('下载失败 HTTP ' + r.status);
      const total = Number(r.headers['content-length'] || 0);
      const hash = crypto.createHash('sha256');
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(destPath);
        // 取消：kill curl 子进程 + destroy 输入流，中断 pipe 后按失败收尾
        this.downloadAbort = () => {
          try { if (r.child) r.child.kill(); } catch { /* ignore */ }
          try { r.stream.destroy(); } catch { /* ignore */ }
          reject(new Error('cancelled'));
        };
        r.stream.on('data', (c) => {
          got += c.length; hash.update(c);
          if (total && onProgress) onProgress(got / total);
          else if (onProgress) onProgress(-1); // 拿不到总大小（curl 兜底时）
        });
        r.stream.on('error', reject);
        out.on('error', reject);
        out.on('finish', () => out.close(resolve));
        r.stream.pipe(out);
      });
      // 完整性：拿到 GitHub 官方 sha256 才比对；拿不到跳过（不阻断更新）
      if (expectedSha256) {
        const actual = hash.digest('hex');
        if (actual !== expectedSha256) throw new Error('下载完整性校验失败：sha256 不匹配（渠道可能返回了损坏或被替换的文件）');
      }
      this.emit({ status: 'downloading', progress: 1, error: '' });
      return destPath;
    } catch (e) {
      // 流被中断时 curl 子进程可能还在，补一刀
      try { fs.unlinkSync(destPath); } catch { /* 没下完的文件删不掉就算了 */ }
      throw e;
    } finally {
      this.downloadAbort = null;
    }
  }

  cancelDownload() { if (this.downloadAbort) { try { this.downloadAbort(); } catch { /* ignore */ } } }

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
      // 4. 覆盖安装；失败了必须把备份搬回来，否则用户就只剩一个空位置
      try {
        await this._run('ditto', ['--rsrc', newApp, target]);
      } catch (e) {
        if (fs.existsSync(backup)) {
          try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 半截目录尽力删 */ }
          try { fs.renameSync(backup, target); } catch { /* 回滚也失败就只能保留备份 */ }
        }
        throw e;
      }
      // 5. 延迟启动新实例（等旧实例退出释放单实例锁和端口），然后退出旧进程
      const relaunch = spawn('/bin/sh', ['-c', `sleep 2; open "${target}"`], { detached: true, stdio: 'ignore' });
      relaunch.unref();
      // 6. 装成功后打扫：解压临时目录直接删；同目录的旧版备份只保留最新一份
      //    （以前每次都留一个 200MB+ 的 .bak 且永不清理，装几次 ~/Applications 就满了）
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 系统会清 tmp */ }
      try {
        const parent = path.dirname(target);
        const base = path.basename(target);
        const baks = fs.readdirSync(parent)
          .filter(n => n.startsWith(base + '.bak-'))
          .sort(); // '.bak-<毫秒时间戳>' 定长，字典序即时间序
        for (const n of baks.slice(0, Math.max(0, baks.length - 1))) {
          try { fs.rmSync(path.join(parent, n), { recursive: true, force: true }); } catch { /* 删不动就算了 */ }
        }
      } catch { /* 清不了不影响已装好的新版 */ }
      this.emit({ status: 'ready', installedTo: target, backup });
      return { target, backup };
    }
    if (this.platform === 'win32') {
      // Windows 没法学 macOS 那样"先删再拷"：正在运行的 exe 是锁死的，robocopy 覆盖它会失败。
      // 老实现就是 robocopy /MIR 硬盖 + 内联 -Command 拼一长串 PowerShell，两个都是静默
      // 失败点（覆盖被拒、命令行引号被 Node 转义后 PowerShell 解析不了），表现就是
      // "点了安装并重启 → 什么都没发生 → 手动开还是旧版本 → 再提示更新"。
      //
      // 现在改成 Squirrel 那套：新版本先解压到**同级目录**（同一个卷），再由一个脚本
      // 等进程退出 → 把旧目录改名 → 把新目录改名成原来的名字。全程只做 rename，
      // 不覆盖任何被占用的文件；每一步都写日志，失败也不会把应用弄丢。
      const exeName = 'WebVault.exe';
      const target = opts.targetDir || path.dirname(process.execPath);
      const parent = path.dirname(target);

      // 解压到目标目录的兄弟位置，保证 rename 是同卷操作（不同卷会退化成复制，慢且可能失败）。
      // 这一步同时充当"写权限探针"：装到 Program Files 之类普通用户写不进的地方，
      // 直接把原因讲清楚，而不是继续跑一条注定失败的脚本。
      const stage = path.join(parent, '.pv-update-' + Date.now());
      try {
        fs.mkdirSync(stage, { recursive: true });
      } catch {
        throw new Error('没有写入权限：' + parent + '。请把程序放到当前用户有权限的目录（如 D:\\WebVault）后再更新，或手动下载新版覆盖。');
      }
      const cleanupStage = () => { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ } };
      try {
        await this._run('tar', ['-xf', zipPath, '-C', stage]);
      } catch (e) {
        cleanupStage();
        throw e;
      }

      const inner = fs.readdirSync(stage).find(n => {
        try { return fs.statSync(path.join(stage, n)).isDirectory(); } catch { return false; }
      });
      if (!inner) { cleanupStage(); throw new Error('安装包内容异常'); }
      const src = path.join(stage, inner);
      if (!fs.existsSync(path.join(src, exeName))) { cleanupStage(); throw new Error('安装包内没有 ' + exeName); }

      // 换上去之前先自检版本号：宁可报错，也不要把一个错包/半个包换到用户机器上
      let newVer = '';
      try {
        newVer = JSON.parse(fs.readFileSync(path.join(src, 'resources', 'app', 'package.json'), 'utf8')).version || '';
      } catch { /* 读不到就不校验 */ }
      if (newVer && this.state.remoteVersion && !isNewer(newVer, this.currentVersion)) {
        cleanupStage();
        throw new Error(`安装包版本异常（包内是 ${newVer}，当前 ${this.currentVersion}）`);
      }

      const logPath = path.join(os.tmpdir(), 'pagevault-update.log');
      const ps1 = path.join(os.tmpdir(), 'pagevault-apply-' + Date.now() + '.ps1');
      fs.writeFileSync(ps1, '\ufeff' + psScript(), 'utf8');

      // 路径全部走 -File 的参数，不拼进命令字符串 —— 中文用户名、空格、引号都不会出问题。
      // cwd 必须是别的目录：如果子进程的工作目录正好是待改名的 $Target，
      // Rename-Item 会报"文件正被另一个进程使用"。
      const child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', ps1, '-Target', target, '-Src', src, '-Stage', stage, '-LogPath', logPath
      ], { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() });
      child.unref();
      this.emit({ status: 'ready', installedTo: target, logPath, newVersion: newVer });
      return { target, logPath };
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
