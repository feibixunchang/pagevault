import Foundation
import SwiftUI

@MainActor
final class Store: ObservableObject {
    @Published private(set) var pages: [PageMeta] = []
    @Published private(set) var loading = false
    @Published private(set) var online = false
    @Published private(set) var serverVersion = ""
    @Published private(set) var serverPlatform = ""
    @Published private(set) var lastUpdated: Date?
    @Published var errorMessage: String?
    @Published var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: Keys.serverURL) }
    }

    // MARK: - 外观与阅读偏好（全部落 UserDefaults，改了立即生效）

    @Published var theme: AppTheme {
        didSet { persist(theme.rawValue, Keys.theme) }
    }
    @Published var readerMode: Bool {
        didSet { persist(readerMode, Keys.readerMode) }
    }
    @Published var fontSize: Double {
        didSet { persist(fontSize, Keys.fontSize) }
    }
    @Published var readerFont: ReaderFont {
        didSet { persist(readerFont.rawValue, Keys.readerFont) }
    }
    @Published var boldText: Bool {
        didSet { persist(boldText, Keys.boldText) }
    }

    // MARK: - 字体下载

    struct FontJob: Equatable {
        let id: String
        var progress: Double
    }

    @Published private(set) var installedFonts: Set<String> = []
    @Published private(set) var fontJob: FontJob?
    @Published var fontDownloadError: String?

    /// 调试启动参数改的偏好不写盘，免得污染用户真实设置
    private var suppressPersist = false
    private func persist(_ value: Any, _ key: String) {
        if suppressPersist { return }
        UserDefaults.standard.set(value, forKey: key)
    }

    private enum Keys {
        static let serverURL = "pv.serverURL"
        static let theme = "pv.theme"
        static let readerMode = "pv.readerMode"
        static let fontSize = "pv.fontSize"
        static let readerFont = "pv.readerFont"
        static let boldText = "pv.boldText"
    }

    /// 可选字号档位（正文基准 px）
    struct FontSizeOption: Identifiable {
        let value: Double
        let label: String
        var id: Double { value }
    }

    static let fontSizes: [FontSizeOption] = [
        FontSizeOption(value: 15, label: "小"),
        FontSizeOption(value: 17, label: "标准"),
        FontSizeOption(value: 19, label: "大"),
        FontSizeOption(value: 21, label: "特大"),
        FontSizeOption(value: 24, label: "超大")
    ]

    /// 默认指向家里 NAS（局域网内最快）；换地址在设置里改
    static let defaultServerURL = "http://192.168.1.2:8731"

    init() {
        let d = UserDefaults.standard
        let saved = d.string(forKey: Keys.serverURL)
        serverURLString = (saved?.isEmpty == false ? saved! : Store.defaultServerURL)

        theme = AppTheme(rawValue: d.string(forKey: Keys.theme) ?? "") ?? .auto
        // 默认开「只显示正文」：整页 HTML 里导航侧栏太多，手机上放大只会更难看
        readerMode = d.object(forKey: Keys.readerMode) as? Bool ?? true
        let size = d.double(forKey: Keys.fontSize)
        fontSize = size > 0 ? size : 17
        readerFont = ReaderFont(rawValue: d.string(forKey: Keys.readerFont) ?? "") ?? .system
        boldText = d.object(forKey: Keys.boldText) as? Bool ?? false

        // 已下载的字体要在每个进程启动时重新注册一次，否则 CSS 里的字族名找不到
        FontCatalog.registerAll()
        installedFonts = FontCatalog.installedIDs()

        let cached = Cache.shared.loadIndex()
        if !cached.isEmpty { pages = cached }

        #if DEBUG
        // 命令行验证界面用（suppressPersist 保证不写盘）：
        //   -- -pvTheme dark -pvFontSize 24 -pvFont songti -pvBold -pvOpenIndex 0
        suppressPersist = true
        let args = ProcessInfo.processInfo.arguments
        func value(_ flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        if let t = value("-pvTheme"), let v = AppTheme(rawValue: t) { theme = v }
        if let s = value("-pvFontSize"), let v = Double(s) { fontSize = v }
        if let f = value("-pvFont"), let v = ReaderFont(rawValue: f) { readerFont = v }
        if args.contains("-pvOriginal") { readerMode = false }
        if args.contains("-pvBold") { boldText = true }
        if args.contains("-pvNoBold") { boldText = false }
        if args.contains("-pvListFonts") {
            for family in UIFont.familyNames.sorted() {
                let names = UIFont.fontNames(forFamilyName: family).joined(separator: " ~ ")
                print("PVFONT|\(family)|\(names)")
            }
        }
        suppressPersist = false
        #endif
    }

    /// 传给阅读页的样式快照
    var readerStyle: ReaderStyle {
        ReaderStyle(reader: readerMode,
                    fontSize: fontSize,
                    fontCSS: readerFont.cssStack(installed: installedFonts),
                    bold: boldText,
                    isDark: theme.isDark)
    }

    /// 整个界面统一的字体（列表、设置、按钮全部用它）
    var appType: AppType {
        AppType(family: readerFont.uiFamily(installed: installedFonts), bold: boldText)
    }

    /// 字号档位 → 动态字型档位。界面靠这一档整体缩放，
    /// 系统控件（表单、开关、分段控件、标题）会一起变大变小。
    var dynamicTypeSize: DynamicTypeSize {
        switch fontSize {
        case ..<16: return .small
        case ..<18: return .large
        case ..<20: return .xLarge
        case ..<22: return .xxLarge
        default: return .xxxLarge
        }
    }

    /// 和上面那五档一一对应的纯比例，给导航栏这类拿不到动态字型的 UIKit 控件用
    var uiScale: CGFloat {
        switch fontSize {
        case ..<16: return 0.88
        case ..<18: return 1.0
        case ..<20: return 1.12
        case ..<22: return 1.23
        default: return 1.35
        }
    }

    /// 当前选中字体是否已经可用（未下载时阅读页会退回系统字体）
    var selectedFontNeedsDownload: Bool {
        readerFont.needsDownload(installed: installedFonts)
    }

    // MARK: - 字体下载

    func downloadFont(_ font: ReaderFont) async {
        guard let spec = font.spec else { return }
        guard fontJob == nil else { return }
        fontDownloadError = nil
        fontJob = FontJob(id: spec.id, progress: 0)
        do {
            try await FontCatalog.download(spec) { p in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    if var job = self.fontJob, job.id == spec.id {
                        job.progress = p
                        self.fontJob = job
                    }
                }
            }
            installedFonts = FontCatalog.installedIDs()
            if !installedFonts.contains(spec.id) {
                fontDownloadError = "字体下载完了但注册失败，换个字体试试"
            }
        } catch {
            fontDownloadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        fontJob = nil
    }

    func removeFont(_ font: ReaderFont) {
        guard let spec = font.spec else { return }
        FontCatalog.remove(spec)
        installedFonts = FontCatalog.installedIDs()
    }

    var fontsSizeText: String {
        let bytes = FontCatalog.specs
            .filter { installedFonts.contains($0.id) }
            .reduce(0.0) { $0 + $1.sizeMB }
        return bytes > 0 ? String(format: "%.1f MB", bytes) : "0 MB"
    }

    var fontSizeLabel: String {
        Store.fontSizes.first { $0.value == fontSize }?.label ?? "\(Int(fontSize))"
    }

    var api: APIClient? { APIClient(serverURL: serverURLString) }

    var cacheSizeText: String { Cache.shared.sizeText }

    var starredCount: Int { pages.filter { $0.isStarred }.count }

    func page(id: String) -> PageMeta? { pages.first { $0.id == id } }

    // MARK: - 刷新

    func refresh(showSpinner: Bool = true) async {
        if showSpinner { loading = true }
        defer { if showSpinner { loading = false } }

        guard let api = api else {
            online = false
            errorMessage = "服务端地址填得不对，去设置里改一下"
            return
        }
        do {
            let list = try await api.pages()
            let status = try? await api.status()
            pages = list
            online = true
            errorMessage = nil
            lastUpdated = Date()
            serverVersion = status?.version ?? ""
            serverPlatform = status?.platformName ?? ""
            Cache.shared.saveIndex(list)
        } catch {
            online = false
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            let cached = Cache.shared.loadIndex()
            if !cached.isEmpty { pages = cached }
        }
    }

    // MARK: - 星标

    func toggleStar(_ page: PageMeta) async {
        guard let idx = pages.firstIndex(where: { $0.id == page.id }) else { return }
        let newValue = !pages[idx].isStarred
        let oldAt = pages[idx].starredAt
        pages[idx].starred = newValue
        pages[idx].starredAt = ISO8601DateFormatter().string(from: Date())
        Cache.shared.saveIndex(pages)

        guard let api = api else { return }
        do {
            _ = try await api.toggleStar(id: page.id)
        } catch {
            if let i = pages.firstIndex(where: { $0.id == page.id }) {
                pages[i].starred = !newValue
                pages[i].starredAt = oldAt
                Cache.shared.saveIndex(pages)
            }
            errorMessage = "星标没同步上去：\((error as? LocalizedError)?.errorDescription ?? "未知错误")"
        }
    }

    // MARK: - 删除

    func delete(_ page: PageMeta) {
        pages.removeAll { $0.id == page.id }
        Cache.shared.removeHTML(id: page.id)
        Cache.shared.saveIndex(pages)
        Task {
            guard let api = api else { return }
            do {
                try await api.delete(id: page.id)
            } catch {
                errorMessage = "删除没同步到服务端，稍后刷新会回来"
                await refresh(showSpinner: false)
            }
        }
    }

    // MARK: - 正文

    /// 缓存优先；没有就下载并落盘，方便下次离线读
    func html(for page: PageMeta) async -> String? {
        if let cached = Cache.shared.html(id: page.id) { return cached }
        guard let api = api else { return nil }
        guard let data = try? await api.html(id: page.id) else { return nil }
        Cache.shared.saveHTML(data, id: page.id)
        return String(data: data, encoding: .utf8)
    }

    // MARK: - 设置里的动作

    func testConnection(_ urlString: String) async -> (ok: Bool, message: String) {
        guard let api = APIClient(serverURL: urlString) else {
            return (false, "地址格式不对")
        }
        do {
            let status = try await api.status()
            let count = status.counts?.total ?? 0
            let name = status.platformName
            let version = status.version ?? "?"
            return (true, "连接成功：\(name) v\(version) · \(count) 条")
        } catch {
            return (false, (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    func clearCache() {
        Cache.shared.clear()
        pages = []
        errorMessage = nil
    }
}
