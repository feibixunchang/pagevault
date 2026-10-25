import Foundation

/// 本地缓存：索引（JSON）+ 每篇正文（HTML）都写进沙盒。
/// 断网时列表照常能看、读过的页面照常能读；图片等远程资源需要联网。
final class Cache {
    static let shared = Cache()

    /// 正文缓存格式版本。
    /// 服务端从 1.5.4 起给阅读页做了瘦身（剥掉 <script>，微信文章 3.4MB → 76KB），
    /// 旧缓存里存的是"整页带脚本"的版本，手机上加载会直接被系统杀掉（表现为点开就闪退）。
    /// v3（1.5.9）：服务端把 /p/ 的图片代理地址从**根相对**改成了绝对地址（修裂图），
    /// 并且阅读时会剥离广告容器。v2 及更早的缓存存的是"根相对 /api/img + 带广告"的
    /// 旧渲染结果——WKWebView 里 loadHTMLString 的 baseURL 会被 HTML 内层的
    /// `<base href="原文章网址">` 盖掉，根相对的 /api/img 被解析到原站 404（裂图），
    /// 广告也还烙在缓存里。缓存又是"写入后永不刷新"的，所以必须整批作废重拉。
    /// 换这个值等于**清空所有正文缓存**，下次打开会从服务端重新拉——不要随便动。
    private static let formatVersion = "v3"

    private let fm = FileManager.default

    private var root: URL {
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("PageVault", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private var pagesDir: URL {
        let dir = root.appendingPathComponent("pages-" + Cache.formatVersion, isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// 换格式版本后，把旧版正文缓存删掉，别白占几百 MB。启动时跑一次即可。
    /// ⚠️ 必须删掉**所有**历史格式的 pages* 目录：只删早期的 "pages" 是不够的——
    /// 版本化之后 pages-v2 会一直躺在盘上，既白占空间，还会被 sizeBytes() 算进
    /// "缓存大小"里，用户在设置里看到的数字对不上实际用量。
    func migrateIfNeeded() {
        let marker = root.appendingPathComponent("format-" + Cache.formatVersion)
        if fm.fileExists(atPath: marker.path) { return }
        if let dirs = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
            for u in dirs {
                let name = u.lastPathComponent
                if name.hasPrefix("pages") && name != "pages-" + Cache.formatVersion {
                    try? fm.removeItem(at: u)
                }
            }
        }
        try? Data().write(to: marker)
    }

    private var indexURL: URL { root.appendingPathComponent("index.json") }

    private func htmlURL(id: String) -> URL { pagesDir.appendingPathComponent(id + ".html") }

    /// 只允许 id 里的安全字符，避免拼出 ../ 之类的路径
    private func safeID(_ id: String) -> String? {
        id.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil ? id : nil
    }

    func saveIndex(_ pages: [PageMeta]) {
        guard let data = try? JSONEncoder().encode(pages) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }

    func loadIndex() -> [PageMeta] {
        guard let data = try? Data(contentsOf: indexURL),
              let list = try? JSONDecoder().decode([PageMeta].self, from: data) else { return [] }
        return list
    }

    @discardableResult
    func saveHTML(_ data: Data, id: String) -> Bool {
        guard let id = safeID(id) else { return false }
        do {
            try data.write(to: htmlURL(id: id), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    func html(id: String) -> String? {
        guard let id = safeID(id), let data = try? Data(contentsOf: htmlURL(id: id)) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func hasHTML(id: String) -> Bool {
        guard let id = safeID(id) else { return false }
        return fm.fileExists(atPath: htmlURL(id: id).path)
    }

    func removeHTML(id: String) {
        guard let id = safeID(id) else { return }
        try? fm.removeItem(at: htmlURL(id: id))
    }

    func clear() {
        try? fm.removeItem(at: indexURL)
        try? fm.removeItem(at: pagesDir)
    }

    func sizeBytes() -> Int64 {
        var total: Int64 = 0
        guard let e = fm.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) else { return 0 }
        for case let u as URL in e {
            let v = try? u.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            if v?.isRegularFile == true { total += Int64(v?.fileSize ?? 0) }
        }
        return total
    }

    var sizeText: String {
        ByteCountFormatter.string(fromByteCount: sizeBytes(), countStyle: .file)
    }
}
