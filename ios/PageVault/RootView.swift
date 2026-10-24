import SwiftUI

struct RootView: View {
    @EnvironmentObject private var store: Store

    @State private var path: [PageMeta] = []
    @State private var query = ""
    @State private var onlyStarred = false
    @State private var showSettings = false
    @State private var showAdd = false
    @State private var showHot = false
    @State private var showFeeds = false
    @State private var addPrefillURL = ""
    @State private var addAutoSave = false

    private var filtered: [PageMeta] {
        var list = store.pages
        if onlyStarred { list = list.filter { $0.isStarred } }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty {
            list = list.filter {
                $0.title.localizedCaseInsensitiveContains(q) || $0.url.localizedCaseInsensitiveContains(q)
            }
        }
        return list
    }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                if !store.pages.isEmpty { filterBar }
                if let err = store.errorMessage, !store.pages.isEmpty { offlineBanner(err) }
                list
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("网页收藏")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索标题或网址")
            .navigationDestination(for: PageMeta.self) { page in
                ReaderView(page: page)
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        showAdd = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("保存文章")
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showHot = true
                    } label: {
                        Image(systemName: "flame")
                    }
                    .accessibilityLabel("热榜")
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showFeeds = true
                    } label: {
                        Image(systemName: "dot.radiowaves.left.and.right")
                    }
                    .accessibilityLabel("RSS 订阅")
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("设置")
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
            .sheet(isPresented: $showAdd) {
                AddByURLView(prefillURL: addPrefillURL, autoSave: addAutoSave)
                    .environmentObject(store)
            }
            .sheet(isPresented: $showHot) {
                HotListView()
                    .environmentObject(store)
            }
            .sheet(isPresented: $showFeeds) {
                FeedsView()
                    .environmentObject(store)
            }
            .task {
                // 有缓存也要刷一次。这里原先是 `if store.pages.isEmpty { refresh() }`，
                // 结果冷启动永远只显示上次的缓存：在电脑/网页上刚改过的标题、刚存进去的
                // 文章，手机上得手动下拉才出现，看着像"没生效"。
                // 现在先拿缓存秒开，同时静默拉一次最新（列表非空就不显示转圈）。
                await store.refresh(showSpinner: store.pages.isEmpty)
                openDebugScreenIfRequested()
            }
            // 导航栏标题/按钮是 UIKit 画的，得单独喂字体
            .onAppear { refreshNavBarFont() }
            .onChange(of: store.appType) { _ in refreshNavBarFont() }
            .onChange(of: store.fontSize) { _ in refreshNavBarFont() }
            // 从后台切回来时静默刷新：在电脑上刚存的页面，回到手机就该看见
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
                Task { await store.refresh(showSpinner: false) }
            }
        }
    }

    private func refreshNavBarFont() {
        NavBarFont.refresh(store.appType, scale: store.uiScale)
    }

    /// 命令行验证界面用（只在 Debug 构建里编译）：
    /// `xcrun devicectl device process launch --console --device <UDID> com.feibixunchang.pagevault -pvOpenFirst`
    private func openDebugScreenIfRequested() {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        // 命令行验证字体下载链路：配合 -pvFont songti 用，启动即下载并注册
        if args.contains("-pvAutoDownloadFont"), store.selectedFontNeedsDownload {
            Task { await store.downloadFont(store.readerFont) }
        }
        if args.contains("-pvOpenSettings") {
            showSettings = true
        } else if args.contains("-pvOpenHot") {
            showHot = true
        } else if args.contains("-pvOpenAdd") || args.contains("-pvAddURL") {
            // -pvAddURL <链接> 预填链接；再加 -pvAddAutoSave 就自动保存，用来真机跑通整条链路
            if let i = args.firstIndex(of: "-pvAddURL"), i + 1 < args.count {
                addPrefillURL = args[i + 1]
                addAutoSave = args.contains("-pvAddAutoSave")
            }
            showAdd = true
        } else if path.isEmpty, let first = store.pages.first {
            // -pvOpenIndex N 打开第 N 条（默认 0）；用来挑"小页面"验证，避开几百 MB 的巨页
            var index = 0
            if let i = args.firstIndex(of: "-pvOpenIndex"), i + 1 < args.count, let n = Int(args[i + 1]) {
                index = max(0, min(n, store.pages.count - 1))
            }
            if args.contains("-pvOpenFirst") || args.contains("-pvOpenIndex") {
                path.append(store.pages[index])
            }
            _ = first
        }
        #endif
    }

    // MARK: - 子视图

    private var filterBar: some View {
        Picker("筛选", selection: $onlyStarred) {
            Text("全部 \(store.pages.count)").tag(false)
            Text("星标 \(store.starredCount)").tag(true)
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    private func offlineBanner(_ text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "wifi.exclamationmark")
            Text(text).lineLimit(2)
            Spacer(minLength: 0)
        }
        .pvFont(.footnote)
        .foregroundColor(.orange)
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }

    private var list: some View {
        List {
            ForEach(filtered) { page in
                row(page)
                    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 12))
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button(role: .destructive) {
                            store.delete(page)
                        } label: {
                            Label("删除", systemImage: "trash")
                        }
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        Button {
                            Task { await store.toggleStar(page) }
                        } label: {
                            Label(page.isStarred ? "取消星标" : "星标",
                                  systemImage: page.isStarred ? "star.slash" : "star")
                        }
                        .tint(.yellow)
                    }
            }
        }
        .listStyle(.plain)
        .overlay { emptyState }
        .refreshable { await store.refresh(showSpinner: false) }
    }

    private func row(_ page: PageMeta) -> some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(page.title.isEmpty ? page.url : page.title)
                    .pvFont(.subheadline, weight: .medium)
                    .lineLimit(2)
                    .foregroundColor(.primary)
                HStack(spacing: 6) {
                    Text(page.domain)
                        .lineLimit(1)
                    Text("·")
                    Text(page.savedAtText)
                    if !page.sizeText.isEmpty {
                        Text("·")
                        Text(page.sizeText)
                    }
                }
                .pvFont(.caption2)
                .foregroundColor(.secondary)
            }
            Spacer(minLength: 0)
            Button {
                Task { await store.toggleStar(page) }
            } label: {
                Image(systemName: page.isStarred ? "star.fill" : "star")
                    .pvFont(.body)
                    .foregroundColor(page.isStarred ? .yellow : Color.secondary.opacity(0.45))
                    .frame(width: 38, height: 38)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(page.isStarred ? "取消星标" : "加星标")

            Image(systemName: "chevron.right")
                .pvFont(.caption, weight: .semibold)
                .foregroundColor(Color.secondary.opacity(0.35))
        }
        .contentShape(Rectangle())
        .onTapGesture { path.append(page) }
    }

    @ViewBuilder
    private var emptyState: some View {
        if store.loading {
            ProgressView("正在连接服务端…")
        } else if store.pages.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: store.errorMessage == nil ? "tray" : "wifi.exclamationmark")
                    .pvFont(.largeTitle)
                    .foregroundColor(.secondary)
                Text(store.errorMessage == nil ? "还没有收藏" : "连不上服务端")
                    .pvFont(.headline)
                if let err = store.errorMessage {
                    Text(err)
                        .pvFont(.footnote)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    // 连不上时把「正在连哪个地址」摆出来，否则用户根本不知道该改什么
                    Text("当前地址：\(store.serverURLString)")
                        .pvFont(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    HStack(spacing: 14) {
                        Button {
                            Task { await store.refresh() }
                        } label: {
                            Label("重试", systemImage: "arrow.clockwise").pvFont(.footnote)
                        }
                        // 地址填错（比如还指着某台已经关机的电脑）时，一键切回默认的 NAS
                        if store.serverURLString != Store.defaultServerURL {
                            Button {
                                store.serverURLString = Store.defaultServerURL
                                Task { await store.refresh() }
                            } label: {
                                Label("切回默认地址", systemImage: "arrow.uturn.backward").pvFont(.footnote)
                            }
                        }
                    }
                    .padding(.top, 2)
                } else if store.online {
                    Text("电脑上装好扩展，看到想留的页面点一下就行；手机上点左上角 + 粘贴链接也能存。")
                        .pvFont(.footnote)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
                Button {
                    showSettings = true
                } label: {
                    Label("打开设置", systemImage: "gearshape")
                        .pvFont(.footnote)
                }
                .padding(.top, 2)
            }
        } else if filtered.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "magnifyingglass").pvFont(.title).foregroundColor(.secondary)
                Text(query.isEmpty ? "没有星标页面" : "没有匹配的结果")
                    .pvFont(.footnote)
                    .foregroundColor(.secondary)
            }
        }
    }
}

#Preview {
    RootView().environmentObject(Store())
}
