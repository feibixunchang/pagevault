import Foundation
import UIKit
import CoreText

/// 一款可下载的中文字体。
///
/// 为什么需要下载：iOS 只自带苹方（PingFang SC），宋体/黑体/楷体这些**根本不在系统里**，
/// 写个 font-family 名字不会有任何效果。所以要自己把字体文件下下来，
/// 再用 CTFontManager 注册给 App 用。
///
/// 用的都是 OFL 协议、可自由分发的开源中文字体（思源系列 + 霞鹜文楷）。
struct FontSpec: Identifiable {
    let id: String
    let title: String        // 宋体
    let subtitle: String     // 思源宋体
    let familyName: String   // 注册后用这个名字写 CSS
    let matchKey: String     // 字族名兜底匹配（不同版本可能带 Lite 后缀）
    let fileName: String
    let sizeMB: Double
    let urls: [String]

    var sizeText: String { String(format: "%.1f MB", sizeMB) }
}

enum FontError: LocalizedError {
    case http(Int)
    case badFile
    case allFailed

    var errorDescription: String? {
        switch self {
        case .http(let code): return "下载失败（HTTP \(code)）"
        case .badFile: return "下载到的文件不是有效字体"
        case .allFailed: return "所有下载渠道都连不上，稍后再试"
        }
    }
}

enum FontCatalog {

    static let specs: [FontSpec] = [
        FontSpec(id: "songti", title: "宋体", subtitle: "思源宋体", familyName: "Noto Serif SC",
                 matchKey: "Noto Serif SC", fileName: "NotoSerifSC-Regular.otf", sizeMB: 11.1,
                 urls: mirrors("googlefonts/noto-cjk/main/Serif/SubsetOTF/SC/NotoSerifSC-Regular.otf")),
        FontSpec(id: "heiti", title: "黑体", subtitle: "思源黑体", familyName: "Noto Sans SC",
                 matchKey: "Noto Sans SC", fileName: "NotoSansSC-Regular.otf", sizeMB: 7.9,
                 urls: mirrors("googlefonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf")),
        FontSpec(id: "kaiti", title: "楷体", subtitle: "霞鹜文楷", familyName: "LXGW WenKai Lite",
                 matchKey: "LXGW WenKai", fileName: "LXGWWenKaiLite-Regular.ttf", sizeMB: 13.3,
                 urls: mirrors("lxgw/LxgwWenKai-Lite/main/fonts/TTF/LXGWWenKaiLite-Regular.ttf"))
    ]

    /// 同一个文件的多个下载渠道：前一个不通就试下一个。
    ///
    /// 顺序是实测出来的（国内网络）：
    /// - GitHub 反代（ghfast / ghproxy / gh-proxy）能完整拿到 10MB+ 的字体；
    /// - jsDelivr 反而**拿不到 noto-cjk**（仓库太大没被索引，直接 404），
    ///   只适合 LXGW 这种小仓库，所以放最后当兜底。
    private static func mirrors(_ ghPath: String) -> [String] {
        [
            "https://ghfast.top/https://raw.githubusercontent.com/\(ghPath)",
            "https://ghproxy.net/https://raw.githubusercontent.com/\(ghPath)",
            "https://gh-proxy.com/https://raw.githubusercontent.com/\(ghPath)",
            "https://cdn.jsdelivr.net/gh/\(ghPath)",
            "https://fastly.jsdelivr.net/gh/\(ghPath)"
        ]
    }

    static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("PageVault/fonts", isDirectory: true)
    }

    static func fileURL(_ spec: FontSpec) -> URL {
        dir.appendingPathComponent(spec.fileName)
    }

    static func spec(id: String) -> FontSpec? {
        specs.first { $0.id == id }
    }

    static func installedIDs() -> Set<String> {
        Set(specs.filter { FileManager.default.fileExists(atPath: fileURL($0).path) }.map(\.id))
    }

    /// 已下载的字体在每个进程里都要重新注册一次（注册不跨进程保存）
    static func registerAll() {
        for spec in specs where FileManager.default.fileExists(atPath: fileURL(spec).path) {
            register(fileURL(spec))
        }
    }

    @discardableResult
    static func register(_ url: URL) -> Bool {
        var err: Unmanaged<CFError>?
        let ok = CTFontManagerRegisterFontsForURL(url as CFURL, .process, &err)
        return ok
    }

    /// 注册后能拿到的真实字族名。版本不同可能带后缀，所以兜底按关键字找一次。
    static func resolvedFamily(_ spec: FontSpec) -> String? {
        let families = UIFont.familyNames
        if families.contains(spec.familyName) { return spec.familyName }
        return families.first { $0.localizedCaseInsensitiveContains(spec.matchKey) }
    }

    static func isUsable(_ spec: FontSpec) -> Bool {
        FileManager.default.fileExists(atPath: fileURL(spec).path) && resolvedFamily(spec) != nil
    }

    static func download(_ spec: FontSpec, progress: @escaping (Double) -> Void) async throws {
        var lastError: Error?
        for urlString in spec.urls {
            guard let url = URL(string: urlString) else { continue }
            do {
                let tmp = try await fetch(url, progress: progress)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let dest = fileURL(spec)
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.moveItem(at: tmp, to: dest)
                register(dest)
                if resolvedFamily(spec) != nil { return }
                // 下到的不是有效字体（可能是错误页）——删掉换下一个渠道
                try? FileManager.default.removeItem(at: dest)
                throw FontError.badFile
            } catch {
                lastError = error
            }
        }
        throw lastError ?? FontError.allFailed
    }

    static func remove(_ spec: FontSpec) {
        try? FileManager.default.removeItem(at: fileURL(spec))
    }

    /// 下载到临时文件，边下边报进度。
    ///
    /// 注意：**不能用 `URLSession.bytes` 逐字节 for-await** —— 一个 10MB 字体要迭代上千万次
    /// async 序列，实际等于永远下不完（表现就是进度条一直 0%）。这里用 DownloadTask +
    /// delegate，进度来自系统回调，稳定且几乎零开销。
    private static func fetch(_ url: URL, progress: @escaping (Double) -> Void) async throws -> URL {
        let downloader = Downloader(onProgress: progress)
        let tmp = try await downloader.start(url)
        let size = (try? FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? NSNumber)?.int64Value ?? 0
        if size < 100_000 {   // 太小肯定不是字体（多半是 404 页面）
            try? FileManager.default.removeItem(at: tmp)
            throw FontError.badFile
        }
        progress(1)
        return tmp
    }

    /// 一次下载任务的封装：把 delegate 回调转成 async/await
    private final class Downloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
        private let onProgress: (Double) -> Void
        private var continuation: CheckedContinuation<URL, Error>?
        private var saved: URL?
        private var failure: Error?
        private var session: URLSession?

        init(onProgress: @escaping (Double) -> Void) {
            self.onProgress = onProgress
        }

        func start(_ url: URL) async throws -> URL {
            try await withCheckedThrowingContinuation { cont in
                self.continuation = cont
                let cfg = URLSessionConfiguration.default
                cfg.timeoutIntervalForRequest = 30
                cfg.timeoutIntervalForResource = 180
                let session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
                self.session = session
                session.downloadTask(with: url).resume()
            }
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                        didWriteData bytesWritten: Int64,
                        totalBytesWritten: Int64,
                        totalBytesExpectedToWrite: Int64) {
            guard totalBytesExpectedToWrite > 0 else { return }
            onProgress(min(0.99, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)))
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                        didFinishDownloadingTo location: URL) {
            if let http = downloadTask.response as? HTTPURLResponse, http.statusCode != 200 {
                failure = FontError.http(http.statusCode)
                return
            }
            // location 在这个回调返回后就会被系统删掉，必须当场搬走
            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent("pvfont-\(UUID().uuidString)")
            do {
                try FileManager.default.moveItem(at: location, to: tmp)
                saved = tmp
            } catch {
                failure = error
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            session.finishTasksAndInvalidate()
            self.session = nil
            defer { continuation = nil }
            if let error {
                continuation?.resume(throwing: error)
            } else if let failure {
                continuation?.resume(throwing: failure)
            } else if let saved {
                continuation?.resume(returning: saved)
            } else {
                continuation?.resume(throwing: FontError.badFile)
            }
        }
    }
}
