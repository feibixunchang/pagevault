import SwiftUI
import UniformTypeIdentifiers

/// RSS 订阅：把自己常用的 RSS/Atom 源加进来，服务端去抓文章、抽正文存进库里。
///
/// 手机上不直接解析 XML —— 那要处理各种半吊子 feed，坑多。正文抽取本来就只能在服务端做
/// （需要完整的 HTML 和站点选择器），所以这里只负责发指令、看结果。
struct FeedsView: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss

    @State private var feeds: [Feed] = []
    @State private var loading = true
    @State private var busy: Set<String> = []
    @State private var message = ""
    @State private var messageHasError = false

    @State private var urlDraft = ""
    @State private var showImporter = false

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
                        HStack(spacing: 8) {
                            TextField("https://example.com/feed.xml", text: $urlDraft)
                                .pvFont(.footnote)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                            Button {
                                addFeed()
                            } label: {
                                if busy.contains("__add__") { ProgressView() } else { Text("添加") }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!busy.isEmpty || urlDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        Button {
                            showImporter = true
                        } label: {
                            Label("从 OPML 文件批量导入", systemImage: "square.and.arrow.down")
                                .pvFont(.footnote)
                        }
                        .disabled(!busy.isEmpty)
                    } header: {
                        Text("添加订阅")
                    } footer: {
                        Text("服务端会把 feed 里的文章抓下来、只留正文存进库里，跟电脑上用扩展保存的一模一样。订阅自带全文的直接用全文，摘要太短的会再抓一次原文。")
                    }

                    if loading {
                        Section { ProgressView("正在读取订阅…") }
                    }

                    if feeds.isEmpty && !loading {
                        Section {
                            Text("还没有订阅")
                                .pvFont(.footnote)
                                .foregroundColor(.secondary)
                        }
                    }

                    ForEach(feeds) { f in
                        Section {
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 6) {
                                        Text(f.title)
                                            .pvFont(.body, weight: .semibold)
                                            .lineLimit(2)
                                        // 和内置热榜重复时给个提示
                                        if let d = f.duplicateOf {
                                            Text("与热榜「\(d.name)」重复")
                                                .pvFont(.caption2)
                                                .foregroundColor(.orange)
                                        }
                                    }
                                    Text(host(f.url))
                                        .pvFont(.caption)
                                        .foregroundColor(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                Button {
                                    pull(f)
                                } label: {
                                    if busy.contains(f.id) { ProgressView() } else { Text("拉取") }
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(!busy.isEmpty)
                            }

                            HStack {
                                Toggle("启用", isOn: Binding(
                                    get: { f.enabled },
                                    set: { v in setEnabled(f, v) }
                                ))
                                .pvFont(.caption)
                                .disabled(!busy.isEmpty)
                                Spacer()
                                limitPicker(f)
                            }
                            // 自动拉取间隔：以前订阅根本没这个开关，intervalSec 存了也没人读
                            HStack {
                                Text("自动拉取")
                                    .pvFont(.caption)
                                    .foregroundColor(.secondary)
                                Spacer()
                                Picker("", selection: Binding(
                                    get: { f.intervalSec ?? 0 },
                                    set: { v in setInterval(f, v) }
                                )) {
                                    Text("关闭").tag(0)
                                    Text("每小时").tag(3600)
                                    Text("每 3 小时").tag(10800)
                                    Text("每 6 小时").tag(21600)
                                    Text("每 12 小时").tag(43200)
                                    Text("每天").tag(86400)
                                }
                                .labelsHidden()
                                .pvFont(.caption)
                                .disabled(!busy.isEmpty)
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                remove(f)
                            } label: {
                                Label("删除", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            .navigationTitle("RSS 订阅")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .fileImporter(
                isPresented: $showImporter,
                allowedContentTypes: [UTType.xml, UTType(filenameExtension: "opml") ?? .xml, .text],
                allowsMultipleSelection: false
            ) { result in
                handleImport(result)
            }
            .task { await load() }
        }
    }

    private func say(_ text: String, isError: Bool = false) {
        message = text
        messageHasError = isError
    }

    private func host(_ url: String) -> String {
        URL(string: url)?.host ?? url
    }

    private func load() async {
        loading = true
        do {
            feeds = try await store.feeds()
        } catch {
            say("读不到订阅：\((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)", isError: true)
        }
        loading = false
    }

    private func addFeed() {
        let u = urlDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !u.isEmpty else { return }
        busy.insert("__add__")
        message = "正在添加订阅…"
        Task {
            do {
                let r = try await store.addFeed(url: u)
                busy.remove("__add__")
                if r.succeeded {
                    say("已添加「\(r.feed?.title ?? u)」，里面有 \(r.itemCount) 篇文章")
                    urlDraft = ""
                } else {
                    say(r.error ?? "添加失败", isError: true)
                }
            } catch {
                busy.remove("__add__")
                say("添加失败：\((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)", isError: true)
            }
            await load()
        }
    }

    private func importOPML(_ text: String) {
        busy.insert("__import__")
        message = "正在导入…"
        Task {
            do {
                let r = try await store.importFeeds(opml: text)
                busy.remove("__import__")
                if r.succeeded {
                    say("导入完成：新增 \(r.addedCount) 个订阅，现在一共 \(r.totalCount) 个")
                } else {
                    say(r.error ?? "导入失败", isError: true)
                }
            } catch {
                busy.remove("__import__")
                say("导入失败：\((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)", isError: true)
            }
            await load()
        }
    }

    private func handleImport(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let e):
            say("选文件失败：\(e.localizedDescription)", isError: true)
        case .success(let urls):
            guard let u = urls.first else { return }
            // OPML 文件在「文件」App / iCloud 里，拿到沙盒外路径，得先拷进来再读
            let scoped = u.startAccessingSecurityScopedResource()
            defer { if scoped { u.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: u)
                guard let text = String(data: data, encoding: .utf8) else {
                    say("这个文件不是文本，可能是二进制格式", isError: true)
                    return
                }
                importOPML(text)
            } catch {
                say("读不了这个文件：\(error.localizedDescription)", isError: true)
            }
        }
    }

    private func pull(_ f: Feed) {
        busy.insert(f.id)
        message = "正在拉取「\(f.title)」…"
        Task {
            let r = await store.pullFeed(f.id, limit: f.limit)
            busy.remove(f.id)
            if let err = r.error {
                say("拉取失败：\(err)", isError: true)
            } else {
                say("拉取完成：存入 \(r.saved.count) 篇"
                    + (r.skipped.count > 0 ? "，跳过 \(r.skipped.count) 篇（多半已经收藏过）" : "")
                    + (r.errors.count > 0 ? "，失败 \(r.errors.count) 篇" : "")
                    + "，用时 \(Int(r.durationMs / 1000)) 秒")
                await store.refresh(showSpinner: false)
            }
            await load()
        }
    }

    private func setEnabled(_ f: Feed, _ v: Bool) {
        if let i = feeds.firstIndex(where: { $0.id == f.id }) {
            feeds[i].enabled = v
        }
        Task {
            let ok = await store.saveFeedConfig(f.id, enabled: v)
            if !ok {
                if let i = feeds.firstIndex(where: { $0.id == f.id }) {
                    feeds[i].enabled = !v
                }
                say("「\(f.title)」的开关没保存上：连不上服务端", isError: true)
            } else {
                say("「\(f.title)」" + (v ? "已启用" : "已停用"))
            }
            await load()
        }
    }

    private func setLimit(_ f: Feed, _ n: Int) {
        if let i = feeds.firstIndex(where: { $0.id == f.id }) {
            feeds[i].limit = n
        }
        Task {
            let ok = await store.saveFeedConfig(f.id, limit: n)
            if ok {
                say("「\(f.title)」每次拉 \(n) 篇")
            } else {
                say("条数没保存上：连不上服务端", isError: true)
            }
            await load()
        }
    }

    private func setInterval(_ f: Feed, _ sec: Int) {
        Task {
            let ok = await store.saveFeedConfig(f.id, intervalSec: sec)
            if ok {
                say(sec <= 0 ? "「\(f.title)」已关闭自动拉取"
                            : "「\(f.title)」自动拉取：每 \(sec / 3600) 小时")
            } else {
                say("自动拉取间隔没保存上：连不上服务端", isError: true)
            }
            await load()
        }
    }

    /// 「每次拉几篇」：可以自由输入 1~50，不再是固定几个选项
    private func limitPicker(_ f: Feed) -> some View {
        HStack(spacing: 4) {
            Text("每次")
                .pvFont(.caption)
                .foregroundColor(.secondary)
            TextField("10", value: Binding(
                get: { f.limit },
                set: { v in
                    if let i = feeds.firstIndex(where: { $0.id == f.id }) {
                        feeds[i].limit = max(1, min(50, v))
                    }
                }
            ), format: .number)
            .pvFont(.caption)
            .keyboardType(.numberPad)
            .multilineTextAlignment(.trailing)
            .frame(width: 46)
            Text("篇")
                .pvFont(.caption)
                .foregroundColor(.secondary)
        }
        .onSubmit { setLimit(f, f.limit) }
    }

    private func remove(_ f: Feed) {
        Task {
            let ok = await store.deleteFeed(f.id)
            if ok {
                say("已删除「\(f.title)」")
            } else {
                say("删除失败：连不上服务端", isError: true)
            }
            await load()
        }
    }
}

// MARK: - 数据模型

struct Feed: Identifiable, Decodable {
    let id: String
    let url: String
    let title: String
    var limit: Int
    var enabled: Bool
    var intervalSec: Int?
    let addedAt: String?
    /// 和内置热榜重复时服务端会告诉用户是哪个源
    var duplicateOf: FeedDuplicate?

    struct FeedDuplicate: Decodable {
        let id: String
        let name: String
    }
}

struct FeedAddResult: Decodable {
    let ok: Bool?
    let feed: Feed?
    let items: Int?
    let error: String?

    /// 服务端老版本不返回 ok 时，用「有没有解析出 feed」当成功标志
    var succeeded: Bool { ok == true || (ok == nil && feed != nil) }
    var itemCount: Int { items ?? 0 }
}

struct FeedImportResult: Decodable {
    let ok: Bool?
    let added: Int?
    let total: Int?
    let error: String?

    var succeeded: Bool { ok == true || (ok == nil && (added ?? 0) > 0) }
    var addedCount: Int { added ?? 0 }
    var totalCount: Int { total ?? 0 }
}
