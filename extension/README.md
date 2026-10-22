# PageVault 扩展

Chrome / Edge (Manifest V3) 扩展。点一下按钮，把当前页面**完整**保存为自包含 HTML 并上报到 PageVault 同步服务端。

## 加载方式

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本目录
4. 固定图标到工具栏

## 工作原理（v0.2，基于 SingleFile）

- `popup.js`：点按钮 → 拿到当前标签页 → 在页面 MAIN world 注入 `lib/single-file.js` → 调用 `singlefile.getPageData()` 取得自包含 HTML → POST 到服务端
- `lib/single-file.js`：SingleFile 官方 standalone 库（从 GitHub 仓库 `lib/` 取得，自包含、零依赖），负责把当前页面的 DOM、CSS、图片、字体、Shadow DOM、懒加载图等内联进**一个 HTML 文件**
- `manifest.json`：通过 `web_accessible_resources` 把 `lib/single-file.js` 暴露给页面加载
- 上报时附带 `platform`（如 `Chrome/macOS`）、`savedAt` 与 `engine: "singlefile"`

## 捕获保真度

- **几乎完整**：静态图文、CSS、内联/外链图片、字体、Shadow DOM、懒加载图片（`loadDeferredImages` 已开启）都能内联
- **仍有限**：靠 JS 运行时才能渲染的正文（SPA 首屏空白）、登录墙后内容、以及**视频/音频媒体数据**（如 YouTube iframe 只存外壳，离线看不到视频本身）
- 单个页面内联后可能数 MB~数十 MB，服务端单页上限 80MB

## 配置服务端地址

弹窗里的输入框可修改服务端地址，默认 `http://localhost:8731`，存于 `chrome.storage.local`。
