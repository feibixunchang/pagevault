import SwiftUI

@main
struct PageVaultApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                // 外观：跟随系统时给 nil，让系统自己决定
                .preferredColorScheme(store.theme.colorScheme)
        }
    }
}
