import SwiftUI

/// 界面字体：**整个客户端界面**（列表、设置、按钮、提示……）都走这一份。
///
/// 三件事一起管：
/// 1. 字族 —— `family`，nil 表示系统字体（苹方）。
/// 2. 粗细 —— `bold`，开启后所有文字至少抬到 semibold。
/// 3. 字号 —— 不在这里，用 App 根节点的 `.dynamicTypeSize(...)` 统一缩放
///    （系统控件、表单、标题全跟着走，比逐个 view 乘系数稳）。
///
/// 用法：`.pvFont(.footnote)` 代替 `.font(.footnote)`，
/// `.pvFont(.subheadline, weight: .medium)` 代替 `.font(.system(size:15.5, weight:.medium))`。
struct AppType: Equatable {
    /// 字体族名（已注册的真实家族名）；nil = 系统字体
    var family: String?
    /// 全局加粗
    var bold: Bool

    static let system = AppType(family: nil, bold: false)

    /// 各语义字号对应的系统点数——自定义字体按这个大小起步，
    /// 再交给 `relativeTo:` 跟随动态字型缩放，视觉上和系统字体一样大。
    private static let baseSizes: [Font.TextStyle: CGFloat] = [
        .largeTitle: 34,
        .title: 28,
        .title2: 22,
        .title3: 20,
        .headline: 17,
        .body: 17,
        .callout: 16,
        .subheadline: 15,
        .footnote: 13,
        .caption: 12,
        .caption2: 11
    ]

    static func baseSize(_ style: Font.TextStyle) -> CGFloat {
        baseSizes[style] ?? 17
    }

    func font(_ style: Font.TextStyle,
              weight: Font.Weight? = nil,
              design: Font.Design = .default) -> Font {
        let base: Font = family.map {
            Font.custom($0, size: Self.baseSize(style), relativeTo: style)
        } ?? Font.system(style, design: design)

        guard let w = resolvedWeight(weight) else { return base }
        return base.weight(w)
    }

    /// 粗体开关：不超过 semibold 的一律抬到 semibold，本来就更粗的保持原样
    private func resolvedWeight(_ weight: Font.Weight?) -> Font.Weight? {
        guard bold else { return weight }
        guard let weight else { return .semibold }
        switch weight {
        case .ultraLight, .thin, .light, .regular, .medium, .semibold:
            return .semibold
        default:
            return weight
        }
    }
}

// MARK: - 环境传递

private struct AppTypeKey: EnvironmentKey {
    static let defaultValue = AppType.system
}

extension EnvironmentValues {
    var appType: AppType {
        get { self[AppTypeKey.self] }
        set { self[AppTypeKey.self] = newValue }
    }
}

private struct PVFontModifier: ViewModifier {
    @Environment(\.appType) private var type
    let style: Font.TextStyle
    let weight: Font.Weight?
    let design: Font.Design

    func body(content: Content) -> some View {
        content.font(type.font(style, weight: weight, design: design))
    }
}

extension View {
    /// 界面统一字体。所有视图都用它，别再写 `.font(.system(size:))`。
    func pvFont(_ style: Font.TextStyle,
                weight: Font.Weight? = nil,
                design: Font.Design = .default) -> some View {
        modifier(PVFontModifier(style: style, weight: weight, design: design))
    }
}
