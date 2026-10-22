# PageVault

> GitHub 仓库：https://github.com/feibixunchang/pagevault （私有；如需公开：`gh repo edit --visibility public`）

一个**六端同步**的"整页网页收藏"工具：在浏览器里点一下扩展，就把当前页面**完整**保存下来，落到本地同步库，之后随时离线回看，像本地浏览一样。每条记录都带**来源平台**和**保存时间**。

当前进度：**Mac-first MVP** —— 已跑通"扩展捕获 → 本地同步服务端 → Mac 上阅读"主链路。其他客户端（Windows / Linux / iOS / Android）和 Docker 自托管端在此基座上扩展。

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

六端 = 5 客户端（Mac / Win / Linux / iOS / Android）+ 1 服务端（Docker）。现在已实现：扩展 + 服务端 + Mac 阅读器。

## 目录

```
pagevault/
├── server/              # 同步服务端（也是未来 Docker 端）
│   ├── server.js         # 零依赖 Node 服务：保存/列表/单页/删除/收藏/全文搜索 + SSE 实时推送
│   ├── public/index.html # 阅读器 UI
│   ├── public/readability.js # Mozilla Readability（阅读模式抽取正文）
│   ├── Dockerfile         # 自托管镜像
│   └── docker-compose.yml
├── extension/           # Chrome/Edge MV3 扩展（v0.4，基于 SingleFile）
│   ├── manifest.json
│   ├── popup.html / popup.js
│   ├── lib/single-file.js # SingleFile 官方 standalone 库（高保真捕获，自包含）
│   └── README.md
├── desktop/             # 桌面端（Electron；macOS + Windows 同一工程）
│   ├── main.js           # 启动内置同步服务端 + 原生窗口
│   ├── build-app.sh      # macOS：组装并 ad-hoc 签名 → dist/网页收藏.app
│   ├── build-win.sh      # Windows：跨平台组装 → dist/网页收藏-win32-x64(+zip)
│   ├── make_icon.py      # 生成 AppIcon.icns（macOS 图标）
│   ├── make_icon_ico.py  # 生成 AppIcon.ico（Windows 图标）
│   └── dist/
├── load-extension.sh     # 扩展加载辅助（复制路径 + 打开扩展管理页）
└── run-mac.sh            # 一键在 Mac 上启动（纯服务端模式）
```

## Windows 端

在 Mac 上一键跨平台构建（纯文件组装，无需 wine）：

```bash
cd desktop && bash build-win.sh
```

产物 `desktop/dist/网页收藏-win32-x64.zip`（约 100MB），拷到 Windows 解压即用：

1. 解压到任意目录（如 `D:\网页收藏`）
2. 双击 `网页收藏.exe`。未买代码签名，SmartScreen 会提示"未知发布者"→「更多信息」→「仍要运行」
3. 数据存 `%APPDATA%\pagevault-desktop`，端口 8731，与 Mac 版协议完全一致
4. Chrome/Edge 加载 `pagevault/extension` 扩展，两端可往同一个库保存/查看

> Windows 与 Mac 数据互通的正确姿势：任一端开服务端，另一端把"服务地址"指向它
> （扩展 popup 里可改服务地址，如 `http://192.168.x.x:8731`），即实现真正的双端同步。

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
6. 🔜 Docker 自托管端上线（已备 Dockerfile）+ 端到端加密 + 整库打包导出
