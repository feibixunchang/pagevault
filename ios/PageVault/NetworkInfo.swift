import Foundation
import Darwin

/// 手机自己的网络状况，只用于设置页诊断显示，不参与同步逻辑。
///
/// 为什么需要它：iOS 对「访问本地网络被拒绝」和「完全没网」回的是同一个错误码
/// （NSURLErrorNotConnectedToInternet），光看错误根本分不清是没连 Wi-Fi、
/// 还是「本地网络」权限没给、还是连到了别的网段。把手机自己的 IP 显示出来，
/// 一眼就能判断是不是和服务端在同一个网段。
enum NetworkInfo {

    /// 正在用的 Wi-Fi IPv4（en0）。没连 Wi-Fi 时为 nil。
    static func wifiIPv4() -> String? {
        address(of: "en0")
    }

    /// 是否有蜂窝数据接口（pdp_ip0）。
    static func hasCellular() -> Bool {
        address(of: "pdp_ip0") != nil
    }

    /// 取某个网卡上的 IPv4 地址。
    private static func address(of interface: String) -> String? {
        var addrs: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addrs) == 0, let first = addrs else { return nil }
        defer { freeifaddrs(addrs) }

        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let ptr = cursor {
            let item = ptr.pointee
            cursor = item.ifa_next

            guard let sa = item.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            guard String(cString: item.ifa_name) == interface else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let rc = getnameinfo(sa, socklen_t(sa.pointee.sa_len),
                                 &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
            if rc == 0 {
                let ip = String(cString: host)
                if !ip.isEmpty { return ip }
            }
        }
        return nil
    }

    /// 两个 IPv4 是否同一 /24 网段（家庭局域网基本都按 /24 分）。
    static func sameSubnet(_ a: String, _ b: String) -> Bool {
        func prefix(_ s: String) -> String? {
            let parts = s.split(separator: ".")
            guard parts.count == 4 else { return nil }
            return parts.prefix(3).joined(separator: ".")
        }
        guard let pa = prefix(a), let pb = prefix(b) else { return false }
        return pa == pb
    }

    /// 从服务端 URL 里抠出主机名（可能是域名，也可能直接是 IP）。
    static func host(of urlString: String) -> String? {
        var t = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.lowercased().hasPrefix("http://") && !t.lowercased().hasPrefix("https://") {
            t = "http://" + t
        }
        return URL(string: t)?.host
    }
}
