import SwiftUI
import WebKit

struct ReaderView: View {
    let page: PageMeta

    @EnvironmentObject private var store: Store
    @Environment(\.openURL) private var openURL

    @State private var html: String?
    @State private var loading = true
    @State private var failed = false

    /// 星标状态以 store 里的为准（可能在列表里刚被改过）
    private var current: PageMeta { store.page(id: page.id) ?? page }

    var body: some View {
        ZStack {
            if let html {
                HTMLView(html: html, baseURL: URL(string: store.serverURLString))
                    .ignoresSafeArea(edges: .bottom)
            } else if failed {
                VStack(spacing: 12) {
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(.system(size: 38))
                        .foregroundColor(.secondary)
                    Text("这篇还没缓存，也连不上服务端")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                    Button("重试") { Task { await load(force: true) } }
                        .font(.footnote)
                }
            } else {
                ProgressView().opacity(loading ? 1 : 0)
            }
        }
        .navigationTitle(current.domain)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                Button {
                    Task { await store.toggleStar(current) }
                } label: {
                    Image(systemName: current.isStarred ? "star.fill" : "star")
                }
                .accessibilityLabel(current.isStarred ? "取消星标" : "加星标")

                if let url = URL(string: page.url) {
                    Button {
                        openURL(url)
                    } label: {
                        Image(systemName: "safari")
                    }
                    .accessibilityLabel("在浏览器中打开")
                }
            }
        }
        .task { await load() }
    }

    private func load(force: Bool = false) async {
        if !force, let h = html { _ = h; return }
        loading = true
        failed = false
        if let cached = await store.html(for: page) {
            html = cached
            loading = false
            return
        }
        // 缓存没有再走网络（store.html 已经试过网络，这里给用户一个明确的失败态）
        html = nil
        loading = false
        failed = true
    }
}

/// WKWebView 宿主：正文按 `store.serverURLString` 作为 baseURL 载入，
/// 这样服务端改写过的 `/api/img?...` 相对地址能正常解析成远程图片。
struct HTMLView: UIViewRepresentable {
    let html: String
    let baseURL: URL?

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        let view = WKWebView(frame: .zero, configuration: cfg)
        view.allowsBackForwardNavigationGestures = false
        view.scrollView.contentInsetAdjustmentBehavior = .always
        view.isOpaque = false
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.lastHTML != html else { return }
        context.coordinator.lastHTML = html
        view.loadHTMLString(html, baseURL: baseURL)
    }

    final class Coordinator {
        var lastHTML: String?
    }
}
