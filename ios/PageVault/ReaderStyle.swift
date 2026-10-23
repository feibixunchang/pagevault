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

/// 正文字体。iOS 自带这几套中文字体，不需要打包字体文件。
enum ReaderFont: String, CaseIterable, Identifiable {
    case system, songti, heiti, kaiti, yuanti

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "系统（苹方）"
        case .songti: return "宋体"
        case .heiti: return "黑体"
        case .kaiti: return "楷体"
        case .yuanti: return "圆体"
        }
    }

    /// 给 CSS 用的字体栈；后面都挂了系统字体兜底，避免缺字变成方块
    var css: String {
        switch self {
        case .system: return "-apple-system, \"PingFang SC\", \"Helvetica Neue\", sans-serif"
        case .songti: return "\"Songti SC\", \"SimSun\", \"STSong\", serif"
        case .heiti: return "\"Heiti SC\", \"PingFang SC\", \"STHeiti\", sans-serif"
        case .kaiti: return "\"Kaiti SC\", \"STKaiti\", \"KaiTi\", serif"
        case .yuanti: return "\"Yuanti SC\", \"PingFang SC\", \"STYuanti\", sans-serif"
        }
    }

    /// 设置页预览用（iOS 里的字体家族名）
    var uiFontName: String {
        switch self {
        case .system: return "PingFang SC"
        case .songti: return "Songti SC"
        case .heiti: return "Heiti SC"
        case .kaiti: return "Kaiti SC"
        case .yuanti: return "Yuanti SC"
        }
    }
}

/// 阅读页的一次性样式快照。值变了就重刷页面。
struct ReaderStyle: Equatable {
    var reader: Bool
    var fontSize: Double
    var font: ReaderFont
    var isDark: Bool

    /// 原文模式的放大比例：以 17px 为 100%
    var textAdjust: String { "\(Int((fontSize / 17.0 * 100).rounded()))%" }

    /// 原文模式的样式：布局一点都不动（放大靠 text-size-adjust，不会横向溢出），
    /// 只有显式选了非系统字体时才覆盖字体。
    var originalCSS: String {
        if font != .system {
            return "body,body p,body div,body span,body li,body td,body th,body h1,body h2,body h3,body h4,body h5,body blockquote,body a{font-family:\(font.css)!important;}"
        }
        return ""
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
            return """
            :root{--pv-bg:\(bg);--pv-fg:\(fg);--pv-muted:\(muted);--pv-line:\(line);--pv-code:\(code);--pv-link:\(link);color-scheme:\(scheme);}
            html,body{margin:0;padding:0;background:var(--pv-bg)!important;color:var(--pv-fg)!important;}
            body{-webkit-text-size-adjust:100%!important;}
            .pv-reader{max-width:720px;margin:0 auto;padding:16px 18px 76px;
              font-size:\(Int(fontSize))px;font-family:\(font.css);line-height:1.78;
              color:var(--pv-fg);word-wrap:break-word;overflow-wrap:break-word;
              -webkit-font-smoothing:antialiased;}
            /* 网页的样式表已经删掉了，但内联 style 还在，这里一次性压掉背景和字色 */
            .pv-reader,.pv-reader *{color:var(--pv-fg)!important;background-color:transparent!important;border-color:var(--pv-line)!important;}
            .pv-reader a,.pv-reader a *{color:var(--pv-link)!important;}
            .pv-reader .pv-title{font-size:1.32em;line-height:1.44;font-weight:600;margin:0 0 .9em;}
            .pv-reader p{margin:0 0 .95em;}
            .pv-reader .pv-li{padding-left:1.05em;text-indent:-1.05em;}
            .pv-reader .pv-li::before{content:"·\\00a0\\00a0";color:var(--pv-muted);}
            .pv-reader h2{font-size:1.16em;line-height:1.5;font-weight:600;margin:1.5em 0 .6em;}
            .pv-reader h3,.pv-reader h4{font-size:1.04em;font-weight:600;margin:1.3em 0 .5em;}
            .pv-reader blockquote{margin:1em 0;padding:.1em 0 .1em 1em;border-left:3px solid var(--pv-line);color:var(--pv-muted)!important;}
            .pv-reader pre{margin:1em 0;padding:12px;border-radius:8px;overflow:auto;background:var(--pv-code)!important;font-size:.92em;line-height:1.5;}
            .pv-reader img{max-width:100%;height:auto;display:block;margin:1em auto;border-radius:8px;background:var(--pv-code);}
            .pv-reader figcaption{display:block;font-size:.84em;color:var(--pv-muted)!important;text-align:center;margin:-.4em 0 1.2em;}
            .pv-reader table{width:100%;border-collapse:collapse;font-size:.94em;margin:1em 0;display:block;overflow-x:auto;}
            .pv-reader td,.pv-reader th{border:1px solid var(--pv-line);padding:6px 8px;}
            .pv-reader a{color:var(--pv-link);text-decoration:none;}
            """
        }
        // 原文模式（或正文提取失败退回时）用的样式
        return originalCSS
    }
}
