import Foundation

/// 服务端 `/api/pages` 返回的一条元数据。
/// 注意 `starred` / `starredAt` 只在为真时出现，所以必须是可选。
struct PageMeta: Codable, Identifiable, Hashable {
    let id: String
    var title: String
    var url: String
    var savedAt: String
    var platform: String?
    var format: String?
    var size: Int?
    var starred: Bool?
    var starredAt: String?

    var isStarred: Bool { starred ?? false }

    var domain: String {
        guard let h = URL(string: url)?.host else { return url }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }

    var savedDate: Date { DateParsing.date(from: savedAt) ?? .distantPast }

    var savedAtText: String {
        let d = savedDate
        if d == .distantPast { return "" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        if Calendar.current.isDateInToday(d) {
            f.dateFormat = "HH:mm"
            return "今天 " + f.string(from: d)
        }
        if Calendar.current.isDateInYesterday(d) {
            f.dateFormat = "HH:mm"
            return "昨天 " + f.string(from: d)
        }
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    var sizeText: String {
        guard let size = size, size > 0 else { return "" }
        return ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }
}

enum DateParsing {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func date(from string: String) -> Date? {
        withFraction.date(from: string) ?? plain.date(from: string)
    }
}

struct ServerStatus: Decodable {
    var version: String?
    var platform: String?
    var counts: Counts?

    struct Counts: Decodable {
        var total: Int?
        var starred: Int?
    }

    /// 端名：status 里的 platform 是 desktop / docker / web
    var platformName: String {
        switch platform ?? "" {
        case "desktop": return "桌面端"
        case "docker": return "Docker"
        case "web": return "网页版"
        default: return platform ?? ""
        }
    }
}
