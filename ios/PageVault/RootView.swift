import SwiftUI

struct RootView: View {
    @EnvironmentObject private var store: Store

    @State private var path: [PageMeta] = []
    @State private var query = ""
    @State private var onlyStarred = false
    @State private var showSettings = false

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
            .task {
                if store.pages.isEmpty { await store.refresh() }
                openDebugScreenIfRequested()
            }
            // 从后台切回来时静默刷新：在电脑上刚存的页面，回到手机就该看见
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
                Task { await store.refresh(showSpinner: false) }
            }
        }
    }

    /// 命令行验证界面用（只在 Debug 构建里编译）：
    /// `xcrun devicectl device process launch --console --device <UDID> com.feibixunchang.pagevault -pvOpenFirst`
    private func openDebugScreenIfRequested() {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-pvOpenSettings") {
            showSettings = true
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
        .font(.footnote)
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
                    .font(.system(size: 15.5, weight: .medium))
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
                .font(.system(size: 11.5))
                .foregroundColor(.secondary)
            }
            Spacer(minLength: 0)
            Button {
                Task { await store.toggleStar(page) }
            } label: {
                Image(systemName: page.isStarred ? "star.fill" : "star")
                    .font(.system(size: 17))
                    .foregroundColor(page.isStarred ? .yellow : Color.secondary.opacity(0.45))
                    .frame(width: 38, height: 38)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(page.isStarred ? "取消星标" : "加星标")

            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
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
                    .font(.system(size: 38))
                    .foregroundColor(.secondary)
                Text(store.errorMessage == nil ? "还没有收藏" : "连不上服务端")
                    .font(.headline)
                if let err = store.errorMessage {
                    Text(err)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                } else if store.online {
                    Text("在浏览器里装好扩展，看到想留的页面点一下就行")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
                Button {
                    showSettings = true
                } label: {
                    Label("打开设置", systemImage: "gearshape")
                        .font(.footnote)
                }
                .padding(.top, 2)
            }
        } else if filtered.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 32)).foregroundColor(.secondary)
                Text(query.isEmpty ? "没有星标页面" : "没有匹配的结果")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
        }
    }
}

#Preview {
    RootView().environmentObject(Store())
}
