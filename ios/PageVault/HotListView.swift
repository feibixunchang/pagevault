import SwiftUI

/// 热榜：从知乎 / V2EX / 掘金 / 少数派… 的榜单里把文章抓下来存进库里。
///
/// 抓取、抽正文都在服务端做（`/api/sources`），手机这边只负责发指令、看结果。
struct HotListView: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss

    @State private var sources: [HotSource] = []
    @State private var loading = true
    @State private var busy: Set<String> = []
    @State private var message = ""
    @State private var cookieDraft: [String: String] = [:]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        pullAll()
                    } label: {
                        HStack {
                            Label("全部拉取", systemImage: "arrow.down.circle")
                            Spacer()
                            if busy.contains("__all__") { ProgressView() }
                        }
                    }
                    .disabled(!busy.isEmpty)
                } footer: {
                    Text("服务端会把榜单里的文章抓下来、只留正文存进库里，跟电脑上用扩展保存的一模一样。已经收藏过的会自动跳过。")
                }

                if loading {
                    Section { ProgressView("正在读取来源…") }
                }

                ForEach(sources) { s in
                    Section {
                        HStack(spacing: 10) {
                            Text(s.emoji).font(.title3)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.name).pvFont(.body, weight: .semibold)
                                Text(subtitle(s))
                                    .pvFont(.caption)
                                    .foregroundColor(.secondary)
                            }
                            Spacer()
                            Button {
                                pull(s)
                            } label: {
                                if busy.contains(s.id) { ProgressView() } else { Text("拉取") }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!busy.isEmpty)
                        }

                        if s.needsCookie {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(s.cookieHint)
                                    .pvFont(.caption2)
                                    .foregroundColor(.secondary)
                                TextField("cookie: z_c0=…", text: Binding(
                                    get: { cookieDraft[s.id] ?? "" },
                                    set: { cookieDraft[s.id] = $0 }
                                ))
                                .pvFont(.caption)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .padding(8)
                                .background(Color(.secondarySystemBackground))
                                .cornerRadius(8)
                                Button("保存 Cookie") { saveCookie(s) }
                                    .pvFont(.caption)
                                    .buttonStyle(.bordered)
                            }
                        }
                    }
                }
            }
            .navigationTitle("热榜")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    private func subtitle(_ s: HotSource) -> String {
        var parts = [s.desc]
        if s.needsCookie { parts.append(s.hasCookie ? "已配 Cookie" : "需要 Cookie") }
        if let r = s.lastResult {
            parts.append("上次 \(r.saved) 篇")
        }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        loading = true
        do {
            sources = try await store.hotSources()
        } catch {
            message = "读不到来源：\(error.localizedDescription)"
        }
        loading = false
    }

    private func pull(_ s: HotSource) {
        busy.insert(s.id)
        message = "正在拉取\(s.name)…"
        Task {
            let r = await store.pullHotSource(s.id, limit: s.limit, cookie: cookieDraft[s.id])
            busy.remove(s.id)
            if let err = r.error {
                message = "拉取失败：\(err)"
            } else {
                message = "存入 \(r.saved.count) 篇"
                    + (r.skipped.count > 0 ? "，跳过 \(r.skipped.count) 篇（多半已经收藏过）" : "")
                    + "，用时 \(Int(r.durationMs / 1000)) 秒"
                await store.refresh(showSpinner: false)
            }
            await load()
        }
    }

    private func pullAll() {
        busy.insert("__all__")
        message = "正在依次拉取所有来源…"
        Task {
            let r = await store.pullAllHotSources()
            busy.remove("__all__")
            if let err = r.error {
                message = "拉取失败：\(err)"
            } else {
                let saved = r.results.reduce(0) { $0 + $1.saved.count }
                message = "全部拉取完成：存入 \(saved) 篇"
                await store.refresh(showSpinner: false)
            }
            await load()
        }
    }

    private func saveCookie(_ s: HotSource) {
        let c = cookieDraft[s.id] ?? ""
        Task {
            _ = await store.saveHotSourceConfig(s.id, cookie: c)
            await load()
        }
    }
}

// MARK: - 数据模型

struct HotSource: Identifiable, Decodable {
    let id: String
    let name: String
    let emoji: String
    let desc: String
    let needsCookie: Bool
    let cookieHint: String
    let hasCookie: Bool
    let limit: Int
    let intervalSec: Int
    let lastResult: HotLastResult?

    struct HotLastResult: Decodable {
        let ok: Bool?
        let saved: Int
        let skipped: Int
        let errors: Int
        let at: Double
    }
}

struct HotPullResult: Decodable {
    struct Saved: Decodable { let id: String; let title: String; let url: String }
    let ok: Bool?
    let saved: [Saved]
    let skipped: [HotSkip]
    let errors: [HotErrorItem]
    let durationMs: Double

    /// 失败原因（服务端把错误放在 errors 里，这里取第一条）
    var error: String? { errors.first?.error }
}

struct HotSkip: Decodable { let title: String?; let why: String? }
struct HotErrorItem: Decodable { let title: String?; let error: String? }

struct HotPullAllResult: Decodable {
    let ok: Bool?
    let results: [HotPullResult]
    let error: String?
}
