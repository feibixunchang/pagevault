import SwiftUI

/// 手机端保存文章。
///
/// 电脑上靠浏览器扩展「抓整页 DOM」保存，手机上做不到（Safari / 微信都不给），
/// 所以换一条路：在微信或浏览器里复制链接，回到这里粘贴一下，由服务端去抓页面并存库。
/// 存好之后所有端（Mac / Windows / 网页 / 这个手机）立刻都能看到。
struct AddByURLView: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss

    /// 命令行验证用（只在 Debug 构建里传）：预填链接并自动保存，
    /// 用来在真机上跑通「手机 → 服务端抓取 → 落盘 → 列表」整条链路。
    var prefillURL: String = ""
    var autoSave: Bool = false

    @State private var text = ""
    @State private var title = ""
    @State private var busy = false
    @State private var errorText: String?
    @FocusState private var urlFocused: Bool

    private var canSave: Bool {
        !busy && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://…", text: $text, axis: .vertical)
                        .lineLimit(1...3)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .focused($urlFocused)
                } header: {
                    Text("文章链接")
                } footer: {
                    Text("在微信、浏览器里长按复制链接，回到这里粘贴即可。服务端会去抓取这一页，存好后所有设备都能离线看。")
                }

                Section {
                    Button {
                        if let s = UIPasteboard.general.string { text = s }
                    } label: {
                        Label("从剪贴板粘贴", systemImage: "doc.on.clipboard")
                    }
                }

                Section {
                    TextField("留空自动取网页标题", text: $title)
                        .autocorrectionDisabled()
                } header: {
                    Text("标题（可选）")
                }

                if let errorText {
                    Section {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundColor(.orange)
                            Text(errorText)
                                .pvFont(.footnote)
                                .foregroundColor(.secondary)
                        }
                    }
                }

                if busy {
                    Section {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("正在抓取页面…（大页面要几秒）")
                                .pvFont(.footnote)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("保存文章")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "保存中…" : "保存") { save() }
                        .disabled(!canSave)
                }
            }
            .onAppear {
                urlFocused = true
                // 调试：命令行直接读启动参数，避免 SwiftUI 把 prefillURL 传丢
                // 注意：@State 写入后同一段代码里读到的还是旧值，所以要用局部变量往下传
                var t = text
                if t.isEmpty {
                    let args = ProcessInfo.processInfo.arguments
                    if let i = args.firstIndex(of: "-pvAddURL"), i + 1 < args.count {
                        t = args[i + 1]
                    }
                }
                text = t
                let wantAuto = autoSave || ProcessInfo.processInfo.arguments.contains("-pvAddAutoSave")
                if wantAuto, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    saveValue(t)
                }
            }
        }
    }

    private func save() {
        saveValue(text)
    }

    private func saveValue(_ url: String) {
        busy = true
        errorText = nil
        let t = title
        Task {
            let err = await store.addByURL(url, title: t)
            busy = false
            if let err {
                errorText = err
            } else {
                dismiss()
            }
        }
    }
}

#Preview {
    AddByURLView().environmentObject(Store())
}
