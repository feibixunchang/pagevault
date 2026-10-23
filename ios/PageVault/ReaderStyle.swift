import SwiftUI

/// 外观：跟随系统 / 浅色 / 深色
enum AppTheme: String, CaseIterable, Identifiable {
    case auto, light, dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .auto: return "跟随系统"
        case .light: return "浅色"
        case .dark: return "深色"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .auto: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    var isDark: Bool { self == .dark }
}

/// 正文字体。
/// iOS **只自带苹方**（实测 iOS 27 上 Songti/Kaiti/Yuanti 都不存在），
/// 所以宋体/黑体/楷体要自己下载（见 FontCatalog）。这里只表示"用户选了什么"。
enum ReaderFont: String, CaseIterable, Identifiable {
    case system, songti, heiti, kaiti

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "系统"
        case .songti: return "宋体"
        case .heiti: return "黑体"
        case .kaiti: return "楷体"
        }
    }

    var subtitle: String {
        switch self {
        case .system: return "苹方"
        default: return spec?.subtitle ?? ""
        }
    }

    var spec: FontSpec? {
        self == .system ? nil : FontCatalog.spec(id: rawValue)
    }

    /// 需要先下载才能用
    func needsDownload(installed: Set<String>) -> Bool {
        guard let spec = spec else { return false }
        return !installed.contains(spec.id)
    }

    /// 给 CSS 用的字体栈。没装就退回系统字体，绝不显示成方块。
    func cssStack(installed: Set<String>) -> String {
        if let spec = spec, installed.contains(spec.id),
           let family = FontCatalog.resolvedFamily(spec) {
            return "\"\(family)\", \"PingFang SC\", -apple-system, sans-serif"
        }
        return "-apple-system, \"PingFang SC\", \"Helvetica Neue\", sans-serif"
    }

    var isSystem: Bool { self == .system }

    /// 界面要用的字族名：只有「下载了、也确实注册上了」才返回，否则退回系统字体。
    /// 这样用户选了宋体但还没下载时，界面不会突然变成别的字体或方块。
    func uiFamily(installed: Set<String>) -> String? {
        guard let spec, installed.contains(spec.id) else { return nil }
        return FontCatalog.resolvedFamily(spec)
    }

    /// 设置页预览用
    func uiFontName(installed: Set<String>) -> String {
        uiFamily(installed: installed) ?? "PingFang SC"
    }
}

/// 阅读页的一次性样式快照。值变了就重刷页面。
struct ReaderStyle: Equatable {
    var reader: Bool
    var fontSize: Double
    var fontCSS: String
    var bold: Bool
    var isDark: Bool

    /// 原文模式的放大比例：以 17px 为 100%
    var textAdjust: String { "\(Int((fontSize / 17.0 * 100).rounded()))%" }

    /// 原文模式的样式：布局一点都不动（放大靠 text-size-adjust，不会横向溢出）
    /// 非 private：ReaderView 的 Coordinator 把它当「提取失败时」的兜底 CSS 用
    var originalCSS: String {
        var css = ""
        if !fontCSS.hasPrefix("-apple-system") {
            css += "body,body p,body div,body span,body li,body td,body th,body h1,body h2,body h3,body h4,body h5,body blockquote,body a{font-family:\(fontCSS)!important;}"
        }
        if bold {
            css += "body,body p,body div,body span,body li,body td,body th,body blockquote,body h1,body h2,body h3,body h4,body h5{font-weight:600!important;}"
        }
        return css
    }

    var css: String {
        if reader {
            let bg = isDark ? "#111214" : "#ffffff"
            let fg = isDark ? "#e8e8ea" : "#1b1b1f"
            let muted = isDark ? "#9a9aa2" : "#6b6b73"
            let line = isDark ? "#34353b" : "#e2e2e6"
            let code = isDark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.05)"
            let link = isDark ? "#7ab8ff" : "#0a6cff"
            let scheme = isDark ? "dark" : "light"
            let weight = bold ? 600 : 400
            return """
            :root{--pv-bg:\(bg);--pv-fg:\(fg);--pv-muted:\(muted);--pv-line:\(line);--pv-code:\(code);--pv-link:\(link);color-scheme:\(scheme);}
            html,body{margin:0;padding:0;background:var(--pv-bg)!important;color:var(--pv-fg)!important;}
            body{-webkit-text-size-adjust:100%!important;}
            .pv-reader{max-width:720px;margin:0 auto;padding:16px 18px 76px;
              font-size:\(Int(fontSize))px;font-family:\(fontCSS);font-weight:\(weight);line-height:1.78;
              color:var(--pv-fg);word-wrap:break-word;overflow-wrap:break-word;
              -webkit-font-smoothing:antialiased;}
            /* 网页的样式表已经删掉了，但内联 style 还在，这里一次性压掉背景和字色 */
            .pv-reader,.pv-reader *{color:var(--pv-fg)!important;background-color:transparent!important;border-color:var(--pv-line)!important;}
            .pv-reader a,.pv-reader a *{color:var(--pv-link)!important;}
            .pv-reader .pv-title{font-size:1.32em;line-height:1.44;font-weight:\(bold ? 700 : 600);margin:0 0 .9em;}
            .pv-reader p{margin:0 0 .95em;}
            .pv-reader .pv-li{padding-left:1.05em;text-indent:-1.05em;}
            .pv-reader .pv-li::before{content:"·\\00a0\\00a0";color:var(--pv-muted);}
            .pv-reader h2{font-size:1.16em;line-height:1.5;font-weight:700;margin:1.5em 0 .6em;}
            .pv-reader h3,.pv-reader h4{font-size:1.04em;font-weight:700;margin:1.3em 0 .5em;}
            .pv-reader blockquote{margin:1em 0;padding:.1em 0 .1em 1em;border-left:3px solid var(--pv-line);color:var(--pv-muted)!important;}
            .pv-reader pre{margin:1em 0;padding:12px;border-radius:8px;overflow:auto;background:var(--pv-code)!important;font-size:.92em;line-height:1.5;}
            .pv-reader img{max-width:100%;height:auto;display:block;margin:1em auto;border-radius:8px;background:var(--pv-code);}
            .pv-reader figcaption{display:block;font-size:.84em;color:var(--pv-muted)!important;text-align:center;margin:-.4em 0 1.2em;}
            .pv-reader table{width:100%;border-collapse:collapse;font-size:.94em;margin:1em 0;display:block;overflow-x:auto;}
            .pv-reader td,.pv-reader th{border:1px solid var(--pv-line);padding:6px 8px;}
            .pv-reader a{color:var(--pv-link);text-decoration:none;}
            """
        }
        return originalCSS
    }
}
