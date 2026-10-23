import SwiftUI
import WebKit

struct ReaderView: View {
    let page: PageMeta

    @EnvironmentObject private var store: Store
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var systemScheme

    @State private var html: String?
    @State private var loading = true
    @State private var failed = false
    @State private var showStyleSheet = false

    /// 星标状态以 store 里的为准（可能在列表里刚被改过）
    private var current: PageMeta { store.page(id: page.id) ?? page }

    /// 「跟随系统」时要拿当前真实外观，不能只看主题设置
    private var style: ReaderStyle {
        var s = store.readerStyle
        if store.theme == .auto { s.isDark = (systemScheme == .dark) }
        return s
    }

    var body: some View {
        ZStack {
            if let html {
                HTMLView(html: html, baseURL: URL(string: store.serverURLString), style: style)
                    .ignoresSafeArea(edges: .bottom)
            } else if failed {
                VStack(spacing: 12) {
                    Image(systemName: "doc.text.magnifyingglass")
                        .pvFont(.largeTitle)
                        .foregroundColor(.secondary)
                    Text("这篇还没缓存，也连不上服务端")
                        .pvFont(.footnote)
                        .foregroundColor(.secondary)
                    Button("重试") { Task { await load(force: true) } }
                        .pvFont(.footnote)
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
                    showStyleSheet = true
                } label: {
                    Image(systemName: "textformat.size")
                }
                .accessibilityLabel("阅读设置")

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
        .sheet(isPresented: $showStyleSheet) {
            NavigationStack {
                Form { ReaderStyleControls() }
                    .navigationTitle("阅读设置")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .navigationBarTrailing) {
                            Button("完成") { showStyleSheet = false }
                        }
                    }
            }
            .environmentObject(store)
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
/// 页面加载完再执行 `window.pvApply`：按当前设置决定要不要只留正文、字号多大、用什么字体。
struct HTMLView: UIViewRepresentable {
    let html: String
    let baseURL: URL?
    let style: ReaderStyle

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        let uc = WKUserContentController()
        uc.addUserScript(WKUserScript(source: ReaderScript.source,
                                      injectionTime: .atDocumentEnd,
                                      forMainFrameOnly: true))
        cfg.userContentController = uc

        let view = WKWebView(frame: .zero, configuration: cfg)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        view.scrollView.contentInsetAdjustmentBehavior = .always
        view.isOpaque = false
        view.backgroundColor = .clear
        context.coordinator.webView = view
        context.coordinator.style = style
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let co = context.coordinator
        let key = html.hashValue
        // 切「只显示正文」必须整页重载：正文提取会替换掉 body，回不去原文
        let needReload = (co.htmlKey != key) || (co.appliedReader != style.reader)

        co.style = style
        view.overrideUserInterfaceStyle = style.isDark ? .dark : .light

        if needReload {
            co.htmlKey = key
            co.loaded = false
            view.loadHTMLString(html, baseURL: baseURL)
        } else if co.loaded {
            co.apply()
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        weak var webView: WKWebView?
        var htmlKey: Int?
        var loaded = false
        var appliedReader: Bool?
        var style = ReaderStyle(reader: false, fontSize: 17,
                                fontCSS: "-apple-system, \"PingFang SC\", sans-serif",
                                bold: false, isDark: false)

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true
            appliedReader = style.reader
            apply()
        }

        func apply() {
            guard let wv = webView else { return }
            let payload: [String: Any] = [
                "reader": style.reader,
                "css": style.css,
                "fallbackCss": style.originalCSS,
                "textAdjust": style.textAdjust
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            wv.evaluateJavaScript("window.pvApply && window.pvApply(\(json));")
        }
    }
}
