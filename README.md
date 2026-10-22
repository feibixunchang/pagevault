# PageVault

> GitHub 仓库：https://github.com/feibixunchang/pagevault （私有；如需公开：`gh repo edit --visibility public`）

一个**六端同步**的"整页网页收藏"工具：在浏览器里点一下扩展，就把当前页面**完整**保存下来，落到本地同步库，之后随时离线回看，像本地浏览一样。每条记录都带**来源平台**和**保存时间**。

当前版本：**v1.1.0**。已实现四端：浏览器扩展 + Mac 桌面端 + Windows 桌面端 + Docker 自托管端（飞牛 NAS 实测运行）。
下一步：iOS 端（Xcode 原生壳 + WebView 阅读器），之后是 Linux / Android。

## 架构

```
浏览器扩展 (Chrome/Edge)
   │  整页 HTML + 元数据 {url, title, savedAt, platform}
   ▼
同步服务端 (Node，零依赖)  ←── 未来即 Docker 端（同一份代码，Dockerfile 已就绪）
   │  存储: data/pages/<id>.html + data/index.json
   ▼
阅读器 UI (Mac 上用浏览器打开 http://localhost:8731)
   │  WebView 渲染保存的 HTML（后续由原生壳 / Flutter 接管）
```

六端 = 5 客户端（Mac / Win / Linux / iOS / Android）+ 1 服务端（Docker）。已实现：扩展 + Mac + Windows + Docker（v1.1.0）。

## 目录

```
pagevault/
├── server/              # 同步服务端（也是 Docker 端 / 家庭 NAS 端）
│   ├── server.js         # 零依赖 Node 服务：保存/列表/单页/删除/收藏/全文搜索 + SSE 实时推送 + 对端同步接口
│   ├── sync.js           # 多目标同步引擎（每个目标独立轮询/状态；拉取/合并/推送/删除传播/孤儿自愈）
│   ├── providers.js      # 同步目标适配层：WebDAV 网盘 / PageVault 服务器（对端）
│   ├── webdav.js         # 极简 WebDAV 客户端（PROPFIND/GET/PUT/DELETE/MKCOL）
│   ├── dnsx.js           # 域名解析兜底：系统 DNS 失败自动走 DoH，A/AAAA 双栈
│   ├── zip.js            # store 模式 zip 读写（整库备份导出/导入）
│   ├── public/index.html # 阅读器 UI（含底部状态栏/设置面板/安装引导）
│   ├── public/readability.js # Mozilla Readability（阅读模式抽取正文）
│   ├── Dockerfile         # 自托管镜像
│   └── docker-compose.yml
├── extension/           # Chrome/Edge MV3 扩展（v0.6，基于 SingleFile + 心跳）
│   ├── manifest.json
│   ├── popup.html / popup.js
│   ├── background.js     # 跨域抓图内联 + 30 秒心跳（浏览器有活动时立即补发）
│   ├── lib/single-file.js # SingleFile 官方 standalone 库（高保真捕获，自包含）
│   └── README.md
├── desktop/             # 桌面端（Electron；macOS + Windows 同一工程）
│   ├── main.js           # 启动内置同步服务端 + 原生窗口 + 本地化菜单 + 安装扩展引导
│   ├── build-app.sh      # macOS：组装并 ad-hoc 签名 → dist/网页收藏.app
│   ├── build-win.sh      # Windows：跨平台组装 → dist/WebVault-win32-x64(+zip)
│   ├── set-win-icon.mjs  # 把 AppIcon.ico 嵌进 exe 资源（与 Mac 图标完全一致）
│   ├── make_icon.py      # 生成图标母版 + AppIcon.icns（macOS 图标）
│   ├── make_icon_ico.py  # 由同一母版生成 AppIcon.ico（Windows 图标）
│   ├── vendor/node_modules/  # resedit + pe-library（嵌图标用，MIT）
│   └── dist/
├── load-extension.sh     # 扩展加载辅助（复制路径 + 打开扩展管理页）
└── run-mac.sh            # 一键在 Mac 上启动（纯服务端模式）
```

> **图标统一**：所有端（Mac / Windows / Linux…）都用 `make_icon.py` 生成的同一母版——
> macOS 用 `AppIcon.icns`，Windows 通过 `set-win-icon.mjs` 把 `AppIcon.ico` **嵌进 exe 资源**
> （只放一个 .ico 文件在旁边对资源管理器无效），已逐像素校验一致。

## Windows 端

在 Mac 上一键跨平台构建（纯文件组装，无需 wine）：

```bash
cd desktop && bash build-win.sh
```

产物 `desktop/dist/WebVault-win32-x64.zip`（约 106MB，包内纯英文文件名，避免解压乱码），
拷到 Windows **完整解压**后使用（包内 `README.txt` 有完整步骤）：

1. 解压到任意目录（建议纯英文路径，如 `D:\WebVault`）——不要在 zip 预览窗口里直接双击 exe
2. **双击 `install.cmd` 一键安装**（用户级，不需要管理员）：自动装到
   `%LOCALAPPDATA%\Programs\WebVault`、创建桌面/开始菜单快捷方式、注册"设置→应用"卸载入口，
   之后可像正常软件一样启动/卸载（`uninstall.cmd` 或系统设置里卸载）。
   也可以不安装，直接双击 `WebVault.exe` 便携使用，功能完全一样
3. 未买代码签名，SmartScreen 提示"未知发布者"→「更多信息」→「仍要运行」
4. 数据存 `%APPDATA%\pagevault-desktop`，端口 8731，与 Mac 版协议完全一致
5. **浏览器扩展已随安装包分发**：解压目录下的 `extension/` 文件夹就是扩展，
   在 `chrome://extensions` 开开发者模式 →「加载已解压的扩展程序」→ 选它即可；
   也可以在阅读器里点底部状态栏的「安装扩展」按弹窗步骤操作
6. Windows 版图标已嵌进 exe，与 Mac 版完全一致

**双击打不开？** 按 Release 说明里的排查清单：SmartScreen「更多信息→仍要运行」→
右键 exe 属性「解除锁定」→ 临时退出杀毒软件 → 看 `%APPDATA%\pagevault-desktop\desktop.log`
→ PowerShell 里 `.\WebVault.exe` 直跑看报错。启动失败时窗口会显示带日志路径的错误页，不会闪退。

## 自动更新

- 桌面端启动 5 秒后自动检查 GitHub 最新版（设置 → 关于与更新里可关闭）
- 发现新版本时，**顶部搜索框左侧**会出现「↑ 有新版本 vX.X.X」入口，点击打开更新弹窗
- 更新时自动**测速各下载渠道**（GitHub 官方 + ghfast / ghproxy 等国内镜像，前 128KB 实测带宽），
  默认选最快的，也可手动改选；下载带进度条，下完自动安装并重启
- macOS：下载 zip → 解压替换 `.app`（旧版自动备份成 `.bak-时间戳`）→ 重启
- Windows：下载 zip → 解压 → 自动替换安装目录 → 重启
- 版本探测走 `github.com/.../releases/latest` 的 302 重定向（不依赖 API，国内网络更稳）；
  网络请求在 Node 原生失败时自动降级 curl 子进程（企业代理环境也能用）；
  解析同样走 DNS 兜底（DoH），系统 DNS 坏了也能检查更新

## 版本号（单一来源）

`desktop/package.json` 的 `version` 是唯一真源，构建前自动同步到：

- `server/server.js` 的 `VERSION`（随 `/api/status` 下发给阅读器）
- `server/package.json`、`extension/manifest.json`

界面上可见版本号的位置：**窗口标题栏**（网页收藏 · 我的网页库 v0.6.1）、
**底部状态栏右侧**、**设置 → 关于与更新**、**浏览器扩展 popup 底部**（扩展版本 + 阅读器版本）。

手动同步/校验：

```bash
node scripts/stamp-version.js          # 同步
node scripts/stamp-version.js --check  # 只校验（不一致则退出码 1）
```

## 界面字体与字号

设置 → 外观 →「界面字体」：

- **跟随系统**（默认，macOS 苹方 / Windows 微软雅黑）
- 常用字体一键切换：**宋体 / 楷体 / 黑体 / 圆体 / 微软雅黑 / 苹方 / 等宽**
  （字体栈同时写了 mac 和 Windows 的字体名，双端都有效；只影响软件界面，
  保存的网页内容保持原页面字体）
- 偏好通过服务端同步，**多端实时生效**（SSE 广播，改一端其他端立即跟随）

「界面字体大小」：**小 / 标准 / 大 / 特大** 四档，整体缩放界面（文字、按钮、列表一起放大，
等效浏览器缩放，不会出现错位）；同样多端实时同步。

## 网络与 DNS 兼容（重要）

同步和自动更新都不依赖系统 DNS 的"运气"：

- **DNS 兜底**：系统解析失败（VPN/加速器接管 DNS 后失效、DNS 服务器抽风）时，
  自动改用 DoH（阿里 223.5.5.5 / 腾讯 1.12.12.12，直连 IP 不依赖本机 DNS）解析
- **双栈自动切换**：A/AAAA 一起查，IPv4 优先；遇到**只有 IPv6 记录**的域名也能连上，
  并在连不通时明确提示"该域名只有 IPv6 地址，建议补一条 A 记录"
- **多地址重试**：一个地址连不上会依次尝试其余地址，而不是直接报错
- **错误信息可读**：域名解析失败 / 连接被拒 / 连接超时 / 证书错误分别给出对应建议；
  还会顺带探测公网 DNS 是否整体不可用，避免把本机网络问题误判成"服务器挂了"

常见排查：

| 现象 | 原因 | 处理 |
|---|---|---|
| `域名解析失败` | 域名写错 / 无记录 / 本机 DNS 失效 | 用 `dig 域名 A` / `dig 域名 AAAA` 核对；本机 DNS 问题换 223.5.5.5 |
| 只有 AAAA 才能解析 | 域名只配了 IPv6 | 在域名服务商补一条 A 记录（IPv4） |
| `连接被拒` | 端口/路径错，或服务没起 | 浏览器直接访问该地址看是否有响应 |
| `认证失败 401` | 账号或密码错 | 坚果云等要用**应用密码**，不是登录密码 |

## 多端同步（同步目标）

阅读器右下角 ⚙ 设置 →「账号与同步」。同步靠一张**目标列表**，可以挂多个，互作备份：

| 目标类型 | 需要填 | 典型用途 |
| --- | --- | --- |
| **WebDAV 网盘** | 地址 / 账号 / 密码（应用密码）/ 目录 | 坚果云、Nextcloud、群晖、自建 Apache；数据只在自己网盘 |
| **PageVault 服务器** | 地址（如 `http://192.168.1.2:8731`）+ 同步令牌 | 家里 NAS、办公室电脑；局域网内同步，不依赖公网 |

- 每个目标可**单独启用/停用**、**单独设置自动同步间隔**（关闭 / 10 秒 / 30 秒 / 1 分钟）
- 同一份库挂多个目标时，任何一个目标写入的数据都会经本地库**顺序**同步到其他目标——
  例如桌面端同时挂「坚果云 + 家里 NAS」，坚果云负责异地容灾，NAS 负责局域网快速同步
- 数据只存在你自己的网盘或自己的机器里，服务端不接触任何第三方账号

### 把 NAS 当同步源（推荐的家庭用法）

1. NAS 上按 [Docker 部署](#docker-部署自托管服务端--飞牛-nas) 起好容器，浏览器打开 `http://<NAS-IP>:8731`
2. 设置 →「本机作为同步源」，复制**同步令牌**（首次启动自动生成，面板里同时列出本机局域网地址）
3. 在 Mac / Windows 客户端里「＋ 添加同步目标」→ 类型选 **PageVault 服务器**，
   地址填 `http://<NAS-IP>:8731`、粘贴令牌，保存即可开始互相同步
4. 想让 NAS 同时承担**异地备份**：在 NAS 自己的页面里再挂一个 **WebDAV** 目标——
   这样 NAS 既是别的端的同步源，又把库备份到你的网盘，一份数据两处落地

> 令牌就是访问控制：没有令牌，同一局域网里的其他设备也读不到你的库。
> 令牌外泄就在面板点「重新生成令牌」，然后到各客户端把令牌换掉（旧令牌立刻失效）。

#### 容器要连「只有 IPv6 域名」的 WebDAV 怎么办

很多人的宽带没有公网 IPv4，WebDAV 是挂在软路由上、靠 Lucky 之类反代成一个只有 AAAA 记录的域名
（例如 `https://home.example.com`）。宿主本身能连（走 IPv6），但 **Docker 默认桥接网络没有 IPv6 出口**，
容器里就会报 `ENOTFOUND` / 连接超时。

不用去改 `daemon.json` 开 IPv6（那会重启所有容器），只要在同一局域网里把这个域名钉到软路由的 IPv4：

```yaml
services:
  pagevault:
    extra_hosts:
      # 域名 → 软路由的局域网 IPv4；TLS 的 SNI 仍是域名，反代照常认得出
      - "home.example.com:192.168.1.1"
    environment:
      # 容器看不到宿主 IP，填上宿主局域网地址，「本机地址」才不会显示成 172.x
      PAGEVAULT_PUBLIC_ADDR: "192.168.1.2"
```

服务端的 DNS 解析是「系统解析优先（会读 `/etc/hosts`）→ 失败才走 DoH」，所以 `extra_hosts` 一定生效，
而且 TLS 证书校验用的还是域名，不会因为连的是 IP 而失败。

同步规则：页面按 id 去重合并；收藏冲突按 `starredAt` 时间戳取新；删除通过 tombstone 传播
（已删的页面不会被其他端推回来复活）；远端 `index.json` 丢失时能从页面文件头的元数据注释自愈；
WebDAV 目录不存在自动逐级创建。底部状态栏显示聚合状态，设置面板里每个目标有独立状态点与错误原因。

## 备份（导出 / 导入）

设置面板 →「备份」：

- **导出备份 (.zip)**：整库（索引 + 全部页面）打包下载，换电脑/重装前先来一份
- **导入备份**：上传之前导出的 zip，按页面 id 合并进当前库（不覆盖已有页面）

## Docker 部署（自托管服务端 / 飞牛 NAS）

容器里跑的就是同一个零依赖 Node 服务端，**不需要数据库、不需要外网、配置只有环境变量**。

### 一条命令起服务（任意装了 Docker 的机器）

```bash
# 在仓库根目录
docker compose up -d --build
# 打开 http://<主机IP>:8731
```

### 飞牛 NAS（fnOS）步骤

1. 在 NAS 上准备目录（`/your/nas/path` 是飞牛默认用户目录，按实际改）：

   ```bash
   mkdir -p /your/nas/path/pagevault/data
   cd /your/nas/path/pagevault
   ```

2. 把仓库里的 `docker-compose.yml`、`server/`、`extension/` 传上去（或者直接从 tar 包解压，
   见 `scripts/pack-docker.sh` 生成的 `pagevault-docker-*.tar.gz`），然后改两处：

   ```yaml
   volumes:
     - /your/nas/path/pagevault/data:/data   # 绝对路径，别用 ./data
   environment:
     PUID: "1000"   # NAS 终端里执行 `id` 看到的 uid
     PGID: "1000"
   ```

3. 起容器：

   ```bash
   docker compose up -d --build
   docker compose ps      # STATUS 里出现 (healthy) 就算成功
   docker compose logs -f  # 看启动日志
   ```

4. 浏览器打开 `http://<NAS的IP>:8731`——底部状态栏会显示 **「Docker 版 v1.1.x」**，
   说明连的是容器端（和桌面版用的是同一套数据格式）。

### 容器端的扩展怎么装

容器没有本地文件系统入口，所以扩展由服务端直接发整包：

```
http://<NAS的IP>:8731/api/extension.zip     # 下载后解压，chrome://extensions 加载该文件夹
```

装完后把扩展 popup 里的「服务器地址」填成 `http://<NAS的IP>:8731`，之后在任何电脑的 Chrome 里
点一下就能存到 NAS 上。

### 常用运维

| 动作 | 命令 |
|---|---|
| 看状态/日志 | `docker compose ps` / `docker compose logs -f` |
| 重启 | `docker compose restart` |
| 升级到新版本 | 换上新代码后 `docker compose up -d --build` |
| 备份 | 打包 `data/` 目录即可（页面 HTML + index.json + 偏好） |
| 迁移 | 把 `data/` 拷到新机器，起同一个镜像即可 |
| 卸载（保留数据） | `docker compose down` |

### 端口与目录约定

| 项 | 值 |
|---|---|
| 容器内端口 | `8731`（`PORT` 可改） |
| 数据目录 | `/data`（`PAGEVAULT_DATA` 可改），内含 `pages/` + `index.json` + `prefs.json` |
| 运行形态标识 | `PAGEVAULT_PLATFORM=docker`（界面据此显示"Docker 版"） |
| 健康检查 | 内置，每 30 秒 GET `/api/status` |

## 在 Mac 上运行（MVP）

### 方式 A：桌面端 App（推荐）

App 已安装到 `~/Applications/网页收藏.app`，**Launchpad 里搜「网页收藏」即可找到**，拖到 Dock 可常驻。
若 Launchpad 还没出现，从 Finder 打开 `~/Applications` 双击即可；想常驻就拖到 Dock。

- App 自带同步服务端（内置在 Resources/server，随 App 启停），数据存在
  `~/Library/Application Support/pagevault-desktop/`（改名不丢库，路径已钉死）
- 窗口就是阅读器；扩展照常往 `http://localhost:8731` 保存
- 首次打开若被 Gatekeeper 拦（未公证），右键 →「打开」，或到
  系统设置 → 隐私与安全性 → 点「仍要打开」
- 重新构建：`cd desktop && bash build-app.sh`，构建完再 `rsync` 到 `~/Applications` 覆盖即可

### 方式 B：纯服务端模式（调试用）

1. 启动同步服务端：

   ```bash
   cd pagevault
   ./run-mac.sh            # 自动打开 http://localhost:8731
   # 或手动： cd server && node server.js
   ```

2. 加载扩展（开发者模式）——可先用辅助脚本省两步：

   ```bash
   cd pagevault
   ./load-extension.sh          # 复制扩展路径到剪贴板 + 打开 Chrome 扩展管理页
   ```

   然后手动完成（扩展无法被程序自动注入，必须人工加载）：
   - 在 `chrome://extensions` 页面右上角打开「开发者模式」
   - 点「加载已解压的扩展程序」→ 弹窗里按 `Cmd+Shift+G`，`Cmd+V` 粘贴路径回车 → 选择
   - 固定扩展图标到工具栏
   - 已加载过旧版的话：点扩展卡片上的「刷新」按钮即可更新到 v0.2

3. 使用：
   - 打开任意网页 → 点扩展图标 → 「保存整页」（保存前会自动滚动整页触发懒加载图）
   - 在 `http://localhost:8731` 的阅读器里，左侧是按时间排序的列表，点开即在右侧 WebView 中完整回看
   - **搜索**：默认按标题/链接过滤；点「全文」按钮后同时搜索页面正文（带关键词上下文摘要）
   - **收藏**：列表条目 hover 出现 ☆/★，可单条收藏；顶部「☆ 收藏」只看收藏
   - **删除**：列表条目 hover 右上角 × 或打开页面后的「🗑 删除」按钮
   - **阅读模式**：「📖 阅读模式」用 Readability 抽取正文重排版（去页头/侧栏/推荐流，760px 窄栏，手机屏友好）
   - **导出**：「⤓ 导出 .html」把单页另存为独立文件（备份/换设备）
   - 所有操作（保存/删除/收藏）通过 SSE **实时同步**到所有打开的阅读器窗口

## 数据格式（六端通用）

每个保存项：

```json
{
  "id": "uuid",
  "title": "页面标题",
  "url": "https://来源链接",
  "savedAt": "2026-10-22T13:41:50.000Z",
  "platform": "Chrome/macOS",
  "format": "html",
  "size": 12345,
  "file": "<id>.html"
}
```

页面正文是**单个自包含 HTML 文件**（CSS、图片已内联为 data URL），任何端用 WebView 都能直接渲染。

## 已知边界（下一阶段要补）

- **保真度**：已接入 SingleFile，静态 / 图文页、CSS、图片、字体、Shadow DOM、懒加载图基本都能完整内联；
  **仍存不全的**：靠 JS 运行时才渲染的正文（SPA 首屏空白）、登录墙后内容。
- **视频 / 音频**：YouTube 等 iframe 只保存外壳，不保存媒体数据（离线看不到视频本身）。
- **体积**：整页内联后可能几 MB~几十 MB（服务端单页上限 80MB）；后续加压缩 / 懒加载 / 「只存正文」模式。
- **iOS 后台同步**：需用户打开 App 触发（系统限制），后续用后台刷新有限补偿。

## 路线图

1. ✅ Mac 主链路（扩展 + 服务端 + 阅读器）
2. ✅ 提升捕获保真度（接入 SingleFile 库，扩展 v0.4）
3. ✅ 原生 Mac 壳（Electron），真正的 `.app` 已装到 `~/Applications`
4. ✅ 阅读器增强：SSE 实时刷新、删除、收藏、全文搜索、阅读模式、导出、自动滚动触发懒加载
5. 🔜 Windows / Linux / iOS / Android 客户端（共用同一服务端协议；手机端默认阅读模式）
6. ✅ Docker 自托管端上线（飞牛 NAS 实测）+ ✅ 多同步目标（WebDAV / PageVault 对端互为源与备份）
7. 🔜 iOS 端（Xcode 原生壳）+ 端到端加密
