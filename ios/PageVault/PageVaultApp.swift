import SwiftUI

@main
struct PageVaultApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                // 界面字体：字族 + 粗细走 AppType 环境，字号走动态字型档位。
                // 这两条挂在最外层，所以列表、设置、弹窗、按钮全部一起变。
                .environment(\.appType, store.appType)
                .dynamicTypeSize(store.dynamicTypeSize)
                .environment(\.legibilityWeight, store.boldText ? .bold : .regular)
                // 兜底：没显式设字体的文字（表单行、开关标题、分区页脚）也跟随
                .environment(\.font, store.appType.font(.body))
                // 外观：跟随系统时给 nil，让系统自己决定
                .preferredColorScheme(store.theme.colorScheme)
        }
    }
}
