# PageVault

> GitHub 仓库：https://github.com/feibixunchang/pagevault （私有；如需公开：`gh repo edit --visibility public`）

一个**六端同步**的"整页网页收藏"工具：在浏览器里点一下扩展，就把当前页面**完整**保存下来，落到本地同步库，之后随时离线回看，像本地浏览一样。每条记录都带**来源平台**和**保存时间**。

当前版本：**v1.4.0**。已实现六端：浏览器扩展 + Mac 桌面端 + Windows 桌面端 + **Linux 桌面端（deb / rpm / AppImage / 便携包）** + Docker 自托管端（飞牛 NAS 实测运行）+ iOS 端（自签真机）。
下一步：Android。

> **安装包命名规则**（v1.4.0 起）：所有发布件都带版本号，形如
> `WebVault-1.4.0-macos-x64.dmg`、`WebVault-1.4.0-win32-x64.zip`、
> `WebVault-1.4.0-linux-x64.deb`。下载多个版本放在一起也不会搞混。

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

六端 = 5 客户端（Mac / Win / Linux / iOS / Android）+ 1 服务端（Docker）。已实现：扩展 + Mac + Windows + Docker + iOS（v1.2.0）。

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
├── desktop/             # 桌面端（Electron；macOS / Windows / Linux 同一套代码）
│   ├── main.js           # 启动内置同步服务端 + 原生窗口 + 本地化菜单 + 安装扩展引导
│   ├── updater.js         # 自动更新：版本探测 + 多渠道测速 + 就地升级（三平台）
│   ├── build-app.sh      # macOS：组装并 ad-hoc 签名 → dist/网页收藏.app
│   ├── build-win.sh      # Windows：跨平台组装 → dist/WebVault-win32-x64(+zip)
│   ├── build-linux.sh    # Linux：组装 → tar.gz / deb（+ rpm/AppImage，需原生工具）
│   ├── linux-icons/      # 由同一母版导出的 Linux 多尺寸 png（16…512）
│   ├── set-win-icon.mjs  # 把 AppIcon.ico 嵌进 exe 资源（与 Mac 图标完全一致）
│   ├── make_icon.py      # 生成图标母版 + AppIcon.icns（macOS 图标）
│   ├── make_icon_ico.py  # 由同一母版生成 AppIcon.ico（Windows 图标）
│   ├── vendor/node_modules/  # resedit + pe-library（嵌图标用，MIT）
│   └── dist/
├── scripts/
│   ├── stamp-version.js  # 版本号单一来源 → 同步到 9 处（含 Xcode 工程）
│   └── mkdeb.py          # 纯 Python 生成 .deb（macOS 无 dpkg-deb 时的兜底）
├── .github/workflows/
│   └── build-linux.yml   # Ubuntu runner 生成 rpm/AppImage 并校验 deb、上传 release
├── ios/                 # iOS 端（SwiftUI 原生壳 + WKWebView 阅读页 + 本地缓存）
│   ├── project.yml       # XcodeGen 工程定义（版本号由 stamp-version.js 统一写）
│   ├── PageVault.xcodeproj/  # 可直接打开运行（自签装真机）
│   └── PageVault/        # APIClient / Cache / Store / RootView / ReaderView / SettingsView
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

产物 `desktop/dist/WebVault-<版本>-win32-x64.zip`（约 106MB，包内纯英文文件名，避免解压乱码），
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

## Linux 端

原生安装包为主，不是网页套壳：装到 `/opt/WebVault`，注册应用菜单入口和 hicolor 图标，
`/usr/bin/webvault` 可直接在终端启动，卸载走发行版包管理器（`apt remove webvault`）。

```bash
cd desktop && bash build-linux.sh
```

产出（文件名都带版本号）：

| 文件 | 适用 | 说明 |
|---|---|---|
| `WebVault-<ver>-linux-x64.deb` | Debian / Ubuntu / Deepin / UOS / 麒麟 | `sudo apt install ./xxx.deb` |
| `WebVault-<ver>-linux-x86_64.rpm` | Fedora / RHEL / CentOS / openEuler | `sudo dnf install ./xxx.rpm` |
| `WebVault-<ver>-linux-x86_64.AppImage` | 任意发行版 | 免安装，`chmod +x` 后双击 |
| `WebVault-<ver>-linux-x64.tar.gz` | 任意发行版 | 便携包，解压后 `./webvault.sh` |

几点实现上的取舍：

- **谁能在哪打**：macOS 上能出 `tar.gz` + `deb`（deb 由 `scripts/mkdeb.py` 纯 Python 生成，
  因为 Homebrew 的 dpkg 在这台机器的沙箱里装不上）；`rpm` / `AppImage` 必须有原生工具，
  交给 `.github/workflows/build-linux.yml` 在 Ubuntu runner 上产出，顺带**真装一遍 deb** 验证。
- **chrome-sandbox 必须 setuid**：Electron 的 Chromium 沙箱要求这个文件属主 root、权限 4755，
  否则启动直接报 `SUID sandbox helper binary was found, but is not configured correctly`。
  macOS 上 `chmod 4755` 会**静默失败**（沙箱限制），所以 `mkdeb.py` 直接把权限写进 tar 头。
- **便携包不设 setuid**：解压出来的目录没有 root，`webvault.sh` 检测到不是 setuid 就
  自动加 `--no-sandbox`（不少发行版禁了 user namespace，这样做最省事）。
- **数据目录**：`~/.config/pagevault-desktop`，与 mac/win 的协议完全一致，端口 8731。

## 自动更新

- 桌面端**启动 4 秒后自动检查** GitHub 最新版；失败会重试三次（刚开机网络没起来时常失败一次），
  之后每 6 小时再查一次，切回窗口时若距上次检查超过 2 小时也会补查
- **发现新版本直接弹系统对话框**（`v1.2.0 → v1.3.0`，按钮是「立即更新 / 稍后」），
  不再是页面角落一个小入口；点「立即更新」进入测速下载流程
- 也可以随时手动查：菜单「帮助 → 检查更新…」或 设置 → 关于与更新 →「检查更新」
- 更新时自动**测速各下载渠道**（GitHub 官方 + ghfast / ghproxy / gh-proxy 等国内镜像，
  前 128KB 实测带宽），默认选最快的，也可手动改选；下载带进度条
- **就地升级**：装到"当前正在运行的这份"所在位置（macOS 是那个 `.app`，Windows 是 exe 所在目录），
  不会另装一份让你有两个版本
- 安装完成后**主动退出旧进程**再拉起新版本——否则 macOS 的 `open` 只会激活旧进程，
  看起来像"点了更新没反应"
- macOS：解压替换 `.app`（旧版自动备份成 `.bak-时间戳`）；Windows：解压后 robocopy 覆盖再启动；
  Linux：解压 `tar.gz` 后整目录替换（同样留 `.old-时间戳` 备份）
- **资产名兼容**：v1.4.0 起发布件统一带版本号（`WebVault-1.4.0-macos-x64.zip`）。
  新版更新器先按带版本号的名字找，探测不到再退回老名字（`pagevault-macos-x64.zip`），
  所以还停留在 1.3.0 及更早版本的客户端不会卡住升不上来
- **Linux 的自动更新只对便携包生效**：装在 `/opt/WebVault` 时目录属主是 root，
  普通用户写不进去，此时会明确提示用 `sudo apt install ./WebVault-<版本>-linux-x64.deb` 升级，
  而不是假装成功
- 版本探测走 `github.com/.../releases/latest` 的 302 重定向（不依赖 API，国内网络更稳）；
  网络请求在 Node 原生失败时自动降级 curl 子进程（企业代理环境也能用）；
  解析同样走 DNS 兜底（DoH），系统 DNS 坏了也能检查更新

> **从 v0.6.x 升到 v1.x 需要手动装一次**：那会儿的版本还没有现在这套提示逻辑（也没弹窗），
> 自动检查失败时是完全静默的，所以你只会看到"没有提示"。
> 下载最新的 Windows zip 解压覆盖一次，之后再更新就都能自己弹了。
>
> iOS 端**不支持自动更新**（自签名 App 没有应用商店通道）。
> 版本号在 设置 → 关于 里能看；要升级就在 Xcode 里重新 ⌘R 一次。

## 版本号（单一来源）

`desktop/package.json` 的 `version` 是唯一真源，构建前自动同步到 9 处：

- `server/server.js` 的 `VERSION`（随 `/api/status` 下发给阅读器）
- `server/package.json`、`extension/manifest.json`
- `server/Dockerfile` 的 OCI 版本标签、两份 `docker-compose.yml` 的镜像 tag
- `ios/project.yml` 的 `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`（后者把 `x.y.z` 压成 `xyyzz`，
  1.4.0 → 10400，App Store 要求单调递增）
- **`ios/PageVault.xcodeproj/project.pbxproj`**：`project.yml` 只在 xcodegen 重新生成时生效，
  日常构建直接用现成的 pbxproj —— 不同步这里，装到手机的版本号会永远是旧的

所有发布件文件名也带版本号（`WebVault-<ver>-<平台>-<架构>.<ext>`），由各构建脚本从
`package.json` 读出来拼，不需要手改。

界面上可见版本号的位置：**窗口标题栏**（网页收藏 · 我的网页库 v0.6.1）、
**底部状态栏右侧**、**设置 → 关于与更新**、**浏览器扩展 popup 底部**（扩展版本 + 阅读器版本）。

手动同步/校验：

```bash
node scripts/stamp-version.js          # 同步
node scripts/stamp-version.js --check  # 只校验（不一致则退出码 1）
```

## 界面字体与字号

字号、粗细、字体这三项，**每个客户端都作用于整个界面**（列表、设置、按钮、提示），
不是只改正文；阅读模式下的正文会按同一套设置渲染，所以六端观感一致。

| | 字号 | 粗体 | 字体 | 生效范围 |
|---|---|---|---|---|
| Mac / Windows / Docker 网页版 | 小/标准/大/特大 | 开/关 | 8 种（含宋体/楷体/黑体/圆体/等宽） | 整个界面 + 阅读模式正文 |
| iOS | 小/标准/大/特大/超大 | 开/关 | 系统（苹方）/ 宋体 / 黑体 / 楷体 | 整个界面 + 阅读模式正文 |
| 浏览器扩展 popup | 跟随服务端偏好 | 跟随服务端偏好 | 跟随服务端偏好 | popup 全部文字 |

桌面端（设置 → 外观）：

- **界面字体**：跟随系统（macOS 苹方 / Windows 微软雅黑）、宋体、楷体、黑体、圆体、
  微软雅黑、苹方、等宽。字体栈同时写了 mac 和 Windows 的字体名，双端都有效。
- **界面字体大小**：小 / 标准 / 大 / 特大 四档，整体缩放界面（文字、按钮、列表一起放大，
  等效浏览器缩放，不会出现错位），阅读模式正文按 `15 / 17 / 19.5 / 22px` 同步变化。
- **粗体**：界面文字加粗，阅读模式正文一起加粗。
- 偏好通过服务端同步，**多端实时生效**（SSE 广播，改一端其他端立即跟随）；
  扩展 popup 每次打开会自己拉一次偏好，跟着一起变。

iOS（设置 → 字号与字体）：

- **字号** 5 档，映射到系统动态字型（`.small` → `.xxxLarge`），所以表单、开关、
  分段控件、标题会一起缩放，不是只放大正文。
- **粗体**：所有文字至少抬到 semibold，正文字重 400 → 600。
- **字体**：iOS 只自带苹方，宋体/黑体/楷体**必须下载**（思源宋体 / 思源黑体 / 霞鹜文楷，
  都是 OFL 开源字体），下载后 `CTFontManager` 注册到进程内即可用于界面和正文。

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

1. 在 NAS 上准备目录（下面的路径按你自己的 NAS 实际情况改）：

   ```bash
   mkdir -p /你的/路径/pagevault/data
   cd /你的/路径/pagevault
   ```

2. 把仓库里的 `docker-compose.yml`、`server/`、`extension/` 传上去（或者直接从 tar 包解压，
   见 `scripts/pack-docker.sh` 生成的 `pagevault-docker-*.tar.gz`），然后改两处：

   ```yaml
   volumes:
     - /你的/路径/pagevault/data:/data   # 绝对路径，别用 ./data
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

## 手机端怎么保存文章

电脑上靠浏览器扩展「抓整页 DOM」再上传。手机上没这个能力——Safari 和微信都不会把页面交给扩展，
所以换一条路：**把链接交给服务端，由服务端去抓**。

服务端接口：`POST /api/pages/from-url`，body `{"url":"https://…","title":"可选"}`。
它会跟随重定向、按 `meta charset` 解码（GBK 站点也不会乱码）、给页面注入 `<base>`，
然后和扩展上传走**同一套**落盘 / 索引 / 广播 / 同步逻辑，所以各端看到的数据完全一致。

两个入口：

1. **任何能打开阅读器页面的设备**（手机 Safari、iPad、另一台电脑）：右上角 `＋` → 粘贴链接 → 保存。
   在微信里长按链接复制，切到页面上粘贴即可。
2. **iPhone 原生 App**：左上角 `＋` → 粘贴链接 → 保存。

已知限制：少数站点会反爬（直接 403、或跳到人机验证页），这类只能回电脑上用扩展保存。
接口会用中文告诉你失败原因（`对方网站返回 HTTP 403` 这种）。

## iOS 端（自签装真机）

原生壳 + 本地缓存：列表/搜索/星标是 SwiftUI 的，正文用 WKWebView 读服务端已存的 HTML。
读过的页面正文会自动存手机沙盒，**断网也能翻**（图片等远程资源需要联网）。

阅读体验（设置页 或 文章页右上角「大小」按钮）：

- **外观**：跟随系统 / 浅色 / 深色
- **只显示正文**（默认开）：在页面里挑出正文块，剥掉导航、侧栏、广告、评论区后重新排版，
  所以**字号放到多大都不会超出屏幕**；个别页面提取不准时关掉开关即可看原样
- **字号**：小 / 标准 / 大 / 特大 / 超大（15–24px）
- **字体**：系统（苹方）/ 宋体 / 黑体 / 楷体 / 圆体
- 关掉「只显示正文」时，放大走 `-webkit-text-size-adjust`——**只放大文字、不动布局**，
  不会出现"字大了但页面横向溢出、右边看不全"

```bash
open ios/PageVault.xcodeproj     # 打开工程
```

1. TARGETS → PageVault → **Signing & Capabilities** → Team 选自己的 Apple ID（个人免费账号即可）；
   Bundle ID 若被占用就改成 `com.你的名字.pagevault`
2. 数据线连 iPhone（手机上「信任此电脑」）→ 顶部选你的设备 → **⌘R**
3. 首次安装会提示未受信任：**设置 → 通用 → VPN 与设备管理 → 开发者 App → 信任**
4. 首次打开弹「允许访问本地网络」——必须允许，否则连不上电脑/NAS
5. 设置里填服务端：NAS `http://192.168.1.2:8731`，或 Mac 桌面端的局域网地址，点「测试连接」验证

> 免费账号签的 App 7 天过期，到期重跑一次 ⌘R 即可。
> 细节、重构工程、命令行编译见 [`ios/README.md`](ios/README.md)。

## 热榜自动拉取（新增）

服务端能自己去各家的榜单页，把热门的文章抓下来、**只留正文**存进库，
所有端立刻就能看到（跟用扩展保存的一模一样，断网也能读）。

界面上点「🔥 热榜」按钮（网页端 / 桌面端 / iOS / 安卓都有），
选来源 → 拉取；也能设成每隔几小时自动拉。

**现在收录的来源**：

| 来源 | 能不能直接用 | 说明 |
|---|---|---|
| 🔶 知乎热榜 | 需要登录 Cookie | 知乎接口必须带登录态，界面上有输入框 |
| 🔥 V2EX 热榜 | ✅ | 程序员社区热门主题 |
| 💎 掘金热榜 | ✅ | 前端/后端热门文章 |
| 🧩 少数派 | ✅ | 效率与数字生活 |
| 💻 IT之家 | ✅ | 科技新闻 |
| 📖 阮一峰博客 | ✅ | 科技周刊长文 |
| 🐧 Solidot | ✅ | 奇客的资讯 |
| 📱 爱范儿 | ✅ | 科技生活方式 |
| 🚄 极客公园 | ✅ | 科技与商业 |
| 🟧 Hacker News | ✅ | 英文技术圈（链接指向原文站点） |

**为什么没有百度热搜、今日头条**：那两个是「热词榜」，点进去是搜索结果页而不是文章，
存下来是搜索页不是原文。想要的话得再走一步「热词 → 找原文」，而且这两家都要
JS 渲染，服务端没有浏览器引擎做不到。

**正文是怎么挑出来的**：服务端自己写了一个极简抽取器（`server/htmlish.js`）——
按段落打分、链接占比过半的直接排除，再配合每个站点指定的正文容器
（如 V2EX 的 `.topic_content`、IT之家的 `#paragraph`）。
抽不到正文的（比如楼主只发了个标题的帖子）**宁可跳过也不存空页面**。

## Android 端（原生 APK）

和 iOS 端同一套服务端接口，纯 Java + 框架 API 写的，**不依赖任何第三方库**
（网络用 `HttpURLConnection`，JSON 用系统自带的 `org.json`，界面用原生 View）。

功能与 iOS 端对齐：

- 列表 / 搜索 / 全部·收藏筛选 / 星标 / 长按删除
- 点开阅读：WebView 读服务端存的整页 HTML，图片走服务端 `/api/img` 代理，**断网也能看**
- **只显示正文**（默认开）：用服务端的 `readability.js` 抽正文，去掉导航、侧栏、推荐流
- 字号 15–24px、**粗体**、正文字体（系统 / 宋体 / 黑体 / 楷体，楷体可下载霞鹜文楷）
- 外观：跟随系统 / 浅色 / 深色
- ＋ 粘贴链接保存（服务端代抓页面，和 iOS 同一个接口）

### 安装

下载 `PageVault-<版本>-android.apk`，传到手机点开安装（需要允许「安装未知来源应用」）。
装好后打开 App，进设置填服务端地址（NAS `http://192.168.1.2:8731`），点「测试连接」验证。

### 自己构建

```bash
bash android/build.sh          # 需要 ANDROID_HOME 与 JDK 17
# 产物：android/dist/PageVault-<版本>-android.apk
```

构建**不走 Gradle**：用 SDK 自带的 `aapt2 + javac + d8 + apksigner` 直接拼 APK，
既不用下载 Gradle 发行包，也不用联网解析 Maven 依赖，在任何装了 Android SDK 的机器上都能一条命令出包。

> 签名用的是仓库内的调试密钥（`android/keys/debug.keystore`），保证以后升级能直接覆盖安装。

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
5. ✅ Windows 客户端 + Docker 自托管端（飞牛 NAS 实测）+ 多同步目标（WebDAV / PageVault 对端互为源与备份）
6. ✅ iOS 端（SwiftUI 原生壳 + WKWebView 阅读器 + 本地缓存，自签真机）
7. 🔜 Linux / Android 客户端 + 端到端加密
