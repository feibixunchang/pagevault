import Foundation

struct APIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

final class APIClient {
    private let base: URL
    private let token: String
    private let session: URLSession

    init?(serverURL: String, token: String = "") {
        guard let url = APIClient.normalize(serverURL) else { return nil }
        self.base = url
        self.token = token
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 20
        cfg.timeoutIntervalForResource = 40
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: cfg)
    }

    /// 允许用户只填 `192.168.1.2:8731`
    static func normalize(_ raw: String) -> URL? {
        var t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        let lower = t.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            t = "http://" + t
        }
        while t.hasSuffix("/") { t.removeLast() }
        guard let u = URL(string: t), let host = u.host, !host.isEmpty else { return nil }
        return u
    }

    private func fetch(_ path: String, method: String) async throws -> Data {
        guard let url = URL(string: path, relativeTo: base) else {
            throw APIError(message: "服务端地址无效")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return try await send(req)
    }

    /// 统一的发送 + 错误翻译。服务端会把失败原因放在 {"error": "..."}（中文），
    /// 直接显示给用户比「服务端返回 HTTP 502」有用得多。
    private func send(_ req: URLRequest) async throws -> Data {
        do {
            let (data, response) = try await session.data(for: req)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                if http.statusCode == 401 { throw APIError(message: "鉴权失败（令牌不对）") }
                if http.statusCode == 404 { throw APIError(message: "接口不存在，服务端版本可能太旧") }
                if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let msg = obj["error"] as? String, !msg.isEmpty {
                    throw APIError(message: msg)
                }
                throw APIError(message: "服务端返回 HTTP \(http.statusCode)")
            }
            return data
        } catch let e as APIError {
            throw e
        } catch {
            throw APIError(message: APIClient.friendly(error))
        }
    }

    private static func friendly(_ error: Error) -> String {
        let ns = error as NSError
        switch ns.code {
        case NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost:
            return "连不上服务端，检查地址和端口是否正确"
        case NSURLErrorTimedOut:
            return "连接超时，手机和服务端是不是不在同一个网络？"
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed:
            return "找不到这个地址，检查是不是填错了"
        case NSURLErrorNotConnectedToInternet:
            // iOS 把「没连网」和「本地网络权限被拒」都归到 -1009，光看错误分不清，
            // 所以这里把两种可能都写出来，别让人以为是手机断网了。
            return "访问不到本地网络：确认手机连的是同一个 Wi-Fi，并在 设置 → 网页收藏 里打开「本地网络」"
        case NSURLErrorAppTransportSecurityRequiresSecureConnection:
            return "被系统安全策略拦截了（http 明文访问）"
        default:
            return ns.localizedDescription
        }
    }

    func status() async throws -> ServerStatus {
        let data = try await fetch("/api/status", method: "GET")
        return (try? JSONDecoder().decode(ServerStatus.self, from: data)) ?? ServerStatus()
    }

    func pages() async throws -> [PageMeta] {
        let data = try await fetch("/api/pages", method: "GET")
        do {
            return try JSONDecoder().decode([PageMeta].self, from: data)
        } catch {
            throw APIError(message: "返回数据解析失败，服务端版本可能不匹配")
        }
    }

    func html(id: String) async throws -> Data {
        try await fetch("/p/" + id, method: "GET")
    }

    func toggleStar(id: String) async throws -> Bool {
        let data = try await fetch("/api/pages/\(id)/star", method: "PATCH")
        struct Reply: Decodable { var starred: Bool? }
        return (try? JSONDecoder().decode(Reply.self, from: data))?.starred ?? false
    }

    func delete(id: String) async throws {
        _ = try await fetch("/api/pages/" + id, method: "DELETE")
    }

    /// 手机端收藏：只把网址交给服务端，由服务端去抓页面。
    /// 手机上拿不到浏览器扩展那种「整页 DOM」，这是唯一可行的保存方式。
    /// 返回新页面的 id；抓不到时服务端会给出中文原因，由 send() 抛出来。
    func saveFromURL(_ rawURL: String, title: String? = nil) async throws -> String? {
        guard let url = URL(string: "/api/pages/from-url", relativeTo: base) else {
            throw APIError(message: "服务端地址无效")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 60          // 服务端要去抓页面，比普通请求慢，给足时间
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        var body: [String: String] = ["url": rawURL, "platform": "ios"]
        if let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
            body["title"] = t
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let data = try await send(req)
        struct Reply: Decodable { var id: String? }
        return (try? JSONDecoder().decode(Reply.self, from: data))?.id
    }

    // MARK: - 热榜

    func hotSources() async throws -> Data {
        try await fetch("/api/sources", method: "GET")
    }

    func pullHotSource(id: String, limit: Int, cookie: String?) async throws -> HotPullResult {
        guard let url = URL(string: "/api/sources/\(id)/pull", relativeTo: base) else {
            throw APIError(message: "服务端地址无效")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 180           // 抓榜单 + 逐篇抓原文，可能要一分多钟
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["limit": max(1, min(20, limit))]
        if let c = cookie, !c.isEmpty { body["cookie"] = c }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let data = try await send(req)
        return (try? JSONDecoder().decode(HotPullResult.self, from: data))
            ?? HotPullResult(ok: false, saved: [], skipped: [], errors: [], durationMs: 0)
    }

    func pullAllHotSources() async throws -> HotPullAllResult {
        guard let url = URL(string: "/api/sources/pull-all", relativeTo: base) else {
            throw APIError(message: "服务端地址无效")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 600
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let data = try await send(req)
        return (try? JSONDecoder().decode(HotPullAllResult.self, from: data))
            ?? HotPullAllResult(ok: false, results: [], error: "返回数据看不懂")
    }

    func saveHotSourceConfig(id: String, cookie: String) async throws -> Data {
        guard let url = URL(string: "/api/sources/\(id)", relativeTo: base) else {
            throw APIError(message: "服务端地址无效")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["cookie": cookie])
        return try await send(req)
    }
}
