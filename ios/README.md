# iOS 端（原生壳 + 本地缓存）

跟 Mac / Windows / 浏览器扩展共用同一个服务端，收藏实时同步。
列表、搜索、星标是原生的（SwiftUI），正文用 WKWebView 渲染服务端已保存的 HTML。

## 功能

- **列表**：标题、域名、收藏时间、大小；下拉刷新
- **搜索**：本地过滤标题和网址（断网也能搜）
- **星标**：行尾按钮 + 左滑 + 阅读页右上角，三处都可以；改完立即推给服务端，失败会回滚
- **删除**：右滑删除，服务端同步删（会通过 tombstone 传播到其他端）
- **阅读**：内置阅读器，右上角可跳到 Safari 打开原文
- **离线**：读过的页面正文自动存本地（`Application Support/PageVault/pages/`），断网照样能读；
  图片等远程资源需要联网
- **回前台自动刷新**：在电脑上刚存的页面，切回手机就能看见
- **设置**：服务端地址（默认 `http://192.168.1.2:8731`）、测试连接、网络诊断、缓存大小、清空缓存

## 连不上服务端怎么查

iOS 把「完全没网」和「本地网络权限被拒」都报成同一个错误（`-1009`），光看提示分不清。
所以设置页有一块**网络诊断**，直接列出手机自己的 Wi-Fi IP 和服务端主机：

- 两边显示「同一网段，可以直接连」→ 网络没问题，问题在权限或服务端没起来
- 手机显示「未连接 Wi-Fi（在用蜂窝数据）」→ 手机不在局域网，连不上 `192.168.x.x`
- 两边网段不同 → 手机连了别的 Wi-Fi（比如访客网络）

权限被拒的表现是每次都说「访问不到本地网络」，去 **设置 → 网页收藏 → 本地网络** 打开。

## 装到自己的 iPhone（自签，不需要开发者账号）

1. 打开 `ios/PageVault.xcodeproj`
2. 左侧选中 **PageVault** 工程 → **TARGETS: PageVault** → **Signing & Capabilities**
   - 勾上 **Automatically manage signing**
   - **Team** 已经预填好了（`project.yml` 里的 `DEVELOPMENT_TEAM`）；换机器/换账号就改成你自己的
   - 如果提示 Bundle ID 被占用，把 `com.feibixunchang.pagevault` 改成别的（如 `com.你的名字.pagevault`）
3. 顶部设备选你的 iPhone（用数据线连接，手机上要「信任此电脑」）
4. 按 **⌘R** 运行
5. 第一次装完，手机上会提示「未受信任的开发者」：
   **设置 → 通用 → VPN 与设备管理 → 开发者 App → 信任**
6. 首次打开 App 会弹「允许访问本地网络」——必须点**允许**，否则连不上电脑/NAS

> 免费账号签的 App **7 天过期**，到期重跑一次 ⌘R 就行（升级到付费开发者账号是 1 年）。

### 不走 Xcode，命令行直接装（已连数据线时）

```bash
cd ios
# 1. 编译并签名（第一次会自动向 Apple 申请描述文件）
xcodebuild -project PageVault.xcodeproj -scheme PageVault \
  -destination 'id=<设备 UDID>' -configuration Debug \
  -derivedDataPath /tmp/pvdd-dev -allowProvisioningUpdates \
  OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox' build

# 2. 安装
xcrun devicectl device install app --device <设备 UDID> \
  /tmp/pvdd-dev/Build/Products/Debug-iphoneos/PageVault.app

# 3. 启动
xcrun devicectl device process launch --device <设备 UDID> com.feibixunchang.pagevault
```

设备 UDID 用 `xcrun devicectl list devices` 看。截真机屏幕：
`xcrun devicectl device capture screenshot --device <UDID> --destination shot.png`。

## 换服务端地址

App 里 ⚙ 设置 →「服务端地址」，填你的服务端，例如：

- 家里 NAS：`http://192.168.1.2:8731`
- Mac 桌面端：`http://<Mac 的局域网 IP>:8731`（Mac 上设置面板「本机作为同步源」里能看到）
- 反代到公网：`https://你的域名`（走 https 也能用）

填完点「测试连接」，会显示服务端端名、版本和条数。

## 重新生成工程

`.xcodeproj` 是 XcodeGen 从 `project.yml` 生成的（已入库，正常不用管）。
改了 `project.yml` 或增删源文件后：

```bash
brew install xcodegen        # 只需一次
cd ios && xcodegen generate
```

## 命令行编译（CI / 自检）

```bash
cd ios
xcodebuild -project PageVault.xcodeproj -scheme PageVault \
  -destination 'generic/platform=iOS' -configuration Release \
  -derivedDataPath /tmp/pvdd CODE_SIGNING_ALLOWED=NO build
```

> 如果在某些受限环境里报 `SwiftUIMacros.StateMacro could not be found ... malformed response`，
> 那是 Swift 宏插件被外层沙箱挡住了，加一个编译器参数即可：
> `OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox'`（正常在 Xcode 里构建不需要）。

## 目录

```
ios/
├── project.yml                 # XcodeGen 工程定义（版本号由 scripts/stamp-version.js 统一写）
├── PageVault.xcodeproj/        # 生成的工程，可直接打开
└── PageVault/
    ├── PageVaultApp.swift      # 入口
    ├── Models.swift            # PageMeta / ServerStatus
    ├── APIClient.swift         # 服务端接口（/api/pages、/p/:id、PATCH star、DELETE）
    ├── Cache.swift             # 索引 + 正文的本地缓存
    ├── Store.swift             # 状态与动作（刷新/星标/删除/取正文）
    ├── RootView.swift          # 列表 + 搜索 + 星标筛选
    ├── ReaderView.swift        # WKWebView 阅读页
    ├── NetworkInfo.swift       # 手机 Wi-Fi 地址 + 网段比对（设置页诊断用）
    ├── SettingsView.swift      # 设置
    └── Assets.xcassets         # 图标（复用桌面端）与主色
```
