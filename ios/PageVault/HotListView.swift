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
    @State private var messageHasError = false
    @State private var cookieDraft: [String: String] = [:]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !message.isEmpty {
                    Text(message)
                        .pvFont(.footnote)
                        .foregroundColor(messageHasError ? Color.red : Color.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color(.secondarySystemBackground))
                }
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
                                    .foregroundColor(s.isOn ? .secondary : .orange)
                            }
                            Spacer()
                            Button {
                                pull(s)
                            } label: {
                                if busy.contains(s.id) { ProgressView() } else { Text("拉取") }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!busy.isEmpty || !s.isOn)
                        }

                        // 停用的来源不参与「全部拉取」和定时任务，但配置留着
                        HStack {
                            Toggle("启用", isOn: Binding(
                                get: { s.isOn },
                                set: { v in setEnabled(s, v) }
                            ))
                            .pvFont(.caption)
                            .disabled(!busy.isEmpty)
                            Spacer()
                            Menu {
                                ForEach([3, 5, 8, 10, 15], id: \.self) { n in
                                    Button("\(n) 篇") { setLimit(s, n) }
                                }
                            } label: {
                                Text("每次 \(s.limit) 篇")
                                    .pvFont(.caption)
                                    .foregroundColor(.accentColor)
                            }
                            .disabled(!busy.isEmpty)
                        }

                        if s.needsCookie {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(s.cookieHint)
                                    .pvFont(.caption2)
                                    .foregroundColor(.secondary)
                                TextField(s.hasCookie ? "已配置（粘贴新的可替换）" : "cookie: z_c0=…", text: Binding(
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

    /// 统一的提示：成功/失败都要说出来，不能让用户对着界面猜
    private func say(_ text: String, isError: Bool = false) {
        message = text
        messageHasError = isError
    }

    private func subtitle(_ s: HotSource) -> String {
        var parts: [String] = []
        if !s.isOn { parts.append("已停用") }
        parts.append(s.desc)
        if s.needsCookie { parts.append(s.hasCookie ? "已配 Cookie" : "需要 Cookie") }
        if let r = s.lastResult {
            parts.append("上次 \(r.saved) 篇")
        }
        return parts.joined(separator: " · ")
    }

    /// 切启用开关：先本地生效（开关跟手），存不上再拨回去并说清楚
    private func setEnabled(_ s: HotSource, _ v: Bool) {
        if let i = sources.firstIndex(where: { $0.id == s.id }) {
            sources[i].enabled = v
        }
        Task {
            let ok = await store.saveHotSourceConfig(s.id, enabled: v)
            if !ok {
                if let i = sources.firstIndex(where: { $0.id == s.id }) {
                    sources[i].enabled = !v
                }
                say("\(s.name) 的开关没保存上：连不上服务端", isError: true)
            } else {
                say("\(s.name)：" + (v ? "已启用" : "已停用（不会被「全部拉取」带上）"))
            }
            await load()
        }
    }

    private func load() async {
        loading = true
        do {
            sources = try await store.hotSources()
        } catch {
            say("读不到来源：\(error.localizedDescription)", isError: true)
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
                say("拉取失败：\(err)", isError: true)
            } else {
                say("拉取成功：存入 \(r.saved.count) 篇"
                    + (r.skipped.count > 0 ? "，跳过 \(r.skipped.count) 篇（多半已经收藏过）" : "")
                    + "，用时 \(Int(r.durationMs / 1000)) 秒")
                await store.refresh(showSpinner: false)
            }
            await load()
        }
    }

    private func pullAll() {
        if sources.allSatisfy({ !$0.isOn }) {
            say("所有来源都停用了，先在上面的列表里打开一个", isError: true)
            return
        }
        busy.insert("__all__")
        message = "正在依次拉取所有来源…"
        Task {
            let r = await store.pullAllHotSources()
            busy.remove("__all__")
            if let err = r.error {
                say("拉取失败：\(err)", isError: true)
            } else {
                let saved = r.results.reduce(0) { $0 + $1.saved.count }
                let errs = r.results.reduce(0) { $0 + $1.errors.count }
                say("全部拉取完成：存入 \(saved) 篇" + (errs > 0 ? "，失败 \(errs) 篇" : ""))
                await store.refresh(showSpinner: false)
            }
            await load()
        }
    }

    /// 改「每次拉几篇」
    private func setLimit(_ s: HotSource, _ n: Int) {
        if let i = sources.firstIndex(where: { $0.id == s.id }) {
            sources[i].limit = n
        }
        Task {
            let ok = await store.saveHotSourceConfig(s.id, limit: n)
            if ok {
                say("\(s.name)：每次拉 \(n) 篇")
            } else {
                say("\(s.name) 的条数没保存上：连不上服务端", isError: true)
            }
            await load()
        }
    }

    private func saveCookie(_ s: HotSource) {        let c = (cookieDraft[s.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if c.isEmpty {
            say("Cookie 是空的，没保存", isError: true)
            return
        }
        Task {
            let ok = await store.saveHotSourceConfig(s.id, cookie: c)
            if ok {
                say("\(s.name) 的 Cookie 已保存", isError: false)
            } else {
                say("Cookie 保存失败：连不上服务端", isError: true)
            }
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
    var limit: Int
    let intervalSec: Int
    /// 缺失时按「启用」处理：老服务端不返回这个字段
    var enabled: Bool?
    let lastResult: HotLastResult?

    var isOn: Bool { enabled != false }

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
