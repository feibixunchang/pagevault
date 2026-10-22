import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss

    @State private var testing = false
    @State private var testResult: (ok: Bool, message: String)?
    @State private var cacheText = ""

    private var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return b.isEmpty ? v : "\(v) (\(b))"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.100.3:8731", text: $store.serverURLString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .font(.system(size: 15, design: .monospaced))
                } header: {
                    Text("服务端地址")
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("填你运行「网页收藏」的电脑或 NAS，例如 http://192.168.100.3:8731。手机要和它在同一个网络。")
                        Button("用家里 NAS") {
                            store.serverURLString = Store.defaultServerURL
                        }
                        .font(.footnote)
                    }
                }

                Section {
                    Button {
                        testing = true
                        testResult = nil
                        Task {
                            let r = await store.testConnection(store.serverURLString)
                            testResult = r
                            testing = false
                        }
                    } label: {
                        HStack {
                            Text("测试连接")
                            Spacer()
                            if testing { ProgressView() }
                        }
                    }
                    .disabled(testing)

                    if let r = testResult {
                        Text(r.message)
                            .font(.footnote)
                            .foregroundColor(r.ok ? .green : .red)
                    }

                    Button("立即刷新") {
                        Task { await store.refresh() }
                    }
                } header: {
                    Text("连接")
                } footer: {
                    if store.online {
                        Text("当前已连上 \(store.serverPlatform.isEmpty ? "服务端" : store.serverPlatform) v\(store.serverVersion)")
                            .foregroundColor(.green)
                    } else if let err = store.errorMessage {
                        Text(err).foregroundColor(.red)
                    }
                }

                Section {
                    LabeledContent("收藏条数", value: "\(store.pages.count)")
                    LabeledContent("星标", value: "\(store.starredCount)")
                    LabeledContent("离线缓存", value: cacheText)
                    Button(role: .destructive) {
                        store.clearCache()
                        cacheText = store.cacheSizeText
                    } label: {
                        Text("清空缓存")
                    }
                } header: {
                    Text("数据")
                } footer: {
                    Text("读过的页面会自动存在手机上，断网也能看（图片等远程资源需要联网）。")
                }

                Section {
                    LabeledContent("客户端版本", value: appVersion)
                    Text("iOS 端：原生列表 + 本地缓存 + 内置阅读器。与 Mac / Windows / 扩展共用同一个服务端，收藏实时同步。")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                } header: {
                    Text("关于")
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
            .onAppear { cacheText = store.cacheSizeText }
        }
    }
}

#Preview {
    SettingsView().environmentObject(Store())
}
