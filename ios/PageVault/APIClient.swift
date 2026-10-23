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

    /// 允许用户只填 `192.168.100.3:8731`
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
        do {
            let (data, response) = try await session.data(for: req)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                if http.statusCode == 401 { throw APIError(message: "鉴权失败（令牌不对）") }
                if http.statusCode == 404 { throw APIError(message: "接口不存在，服务端版本可能太旧") }
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
}
