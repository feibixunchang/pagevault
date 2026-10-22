import Foundation

/// 本地缓存：索引（JSON）+ 每篇正文（HTML）都写进沙盒。
/// 断网时列表照常能看、读过的页面照常能读；图片等远程资源需要联网。
final class Cache {
    static let shared = Cache()

    private let fm = FileManager.default

    private var root: URL {
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("PageVault", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private var pagesDir: URL {
        let dir = root.appendingPathComponent("pages", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
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
