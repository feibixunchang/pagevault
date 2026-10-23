import SwiftUI
import UIKit

/// 导航栏标题（大字标题 / inline 标题 / 右上角按钮文字）是 UIKit 画的，
/// SwiftUI 的 `.font()` 和 `\.font` 环境都够不到，所以只能单独喂一次 UIFont。
///
/// 只在「选了自定义字体」或「开了粗体」时才接管；否则原样放给系统，
/// 让系统自己去跟随动态字型，避免多此一举。
enum NavBarFont {

    /// 尺寸 = 系统基准 × 我们自己那 5 档的缩放比（和动态字型档位对齐）
    static func refresh(_ appType: AppType, scale: CGFloat) {
        guard appType.family != nil || appType.bold else {
            // 交回系统默认（顺便把我们之前可能写进去的覆盖清掉）
            let plain = UINavigationBarAppearance()
            plain.configureWithDefaultBackground()
            UINavigationBar.appearance().standardAppearance = plain
            UINavigationBar.appearance().scrollEdgeAppearance = plain
            UINavigationBar.appearance().compactAppearance = plain
            applyToExistingBars(plain)
            return
        }

        let appearance = UINavigationBarAppearance()
        appearance.configureWithDefaultBackground()

        let large = font(appType, size: 34 * scale, weight: .bold)
        let inline = font(appType, size: 17 * scale, weight: appType.bold ? .semibold : .regular)
        appearance.largeTitleTextAttributes[.font] = large
        appearance.titleTextAttributes[.font] = inline

        // 右上角「完成」「设置」这类按钮文字也要跟着
        let button = UIBarButtonItemAppearance(style: .plain)
        button.normal.titleTextAttributes = [.font: inline]
        button.highlighted.titleTextAttributes = [.font: inline]
        appearance.buttonAppearance = button
        appearance.doneButtonAppearance = button

        UINavigationBar.appearance().standardAppearance = appearance
        UINavigationBar.appearance().scrollEdgeAppearance = appearance
        UINavigationBar.appearance().compactAppearance = appearance
        applyToExistingBars(appearance)
    }

    private static func font(_ appType: AppType, size: CGFloat, weight: UIFont.Weight) -> UIFont {
        guard let family = appType.family,
              let base = UIFont(name: family, size: size) else {
            return .systemFont(ofSize: size, weight: appType.bold ? .semibold : weight)
        }
        let wantBold = appType.bold || weight.rawValue >= UIFont.Weight.semibold.rawValue
        guard wantBold, !base.fontDescriptor.symbolicTraits.contains(.traitBold),
              let bolded = base.fontDescriptor.withSymbolicTraits(.traitBold) else { return base }
        return UIFont(descriptor: bolded, size: size)
    }

    /// appearance 代理只对「之后创建」的栏生效，已经在屏幕上的要自己刷一遍
    private static func applyToExistingBars(_ appearance: UINavigationBarAppearance) {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                walk(window, appearance)
            }
        }
    }

    private static func walk(_ view: UIView, _ appearance: UINavigationBarAppearance) {
        if let bar = view as? UINavigationBar {
            bar.standardAppearance = appearance
            bar.scrollEdgeAppearance = appearance
            bar.compactAppearance = appearance
            bar.setNeedsLayout()
        }
        for sub in view.subviews { walk(sub, appearance) }
    }
}
