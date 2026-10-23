import SwiftUI

/// 外观 + 字号字体 + 阅读 三组控件。设置页和阅读页右上角的「阅读设置」共用这一份，
/// 免得两边改出不一致。
///
/// 注意：字号 / 粗细 / 字体 是**整个客户端界面**的设置（列表、设置、按钮、正文全跟着走），
/// 不是只作用于正文。
struct ReaderStyleControls: View {
    @EnvironmentObject private var store: Store

    private var installed: Set<String> { store.installedFonts }

    var body: some View {
        Section {
            Picker("外观", selection: $store.theme) {
                ForEach(AppTheme.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
        } header: {
            Text("外观")
        } footer: {
            Text("「跟随系统」会跟着手机的深色模式走；单独选浅色/深色则固定不变。")
        }

        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("字号")
                    Spacer()
                    Text(store.fontSizeLabel).foregroundColor(.secondary)
                }
                Picker("字号", selection: $store.fontSize) {
                    ForEach(Store.fontSizes) { item in
                        Text(item.label).tag(item.value)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }

            Toggle("粗体", isOn: $store.boldText)

            Picker("字体", selection: $store.readerFont) {
                ForEach(ReaderFont.allCases) { font in
                    Text(fontLabel(font)).tag(font)
                }
            }

            fontDownloadRow
        } header: {
            Text("字号与字体")
        } footer: {
            Text("这三项作用于整个界面——列表、设置、按钮，以及正文阅读。字号同时决定正文的基准大小。")
        }

        Section {
            Toggle("只显示正文", isOn: $store.readerMode)
        } header: {
            Text("阅读")
        } footer: {
            if store.readerMode {
                Text("已开启「只显示正文」：去掉导航、侧栏、广告和评论区，只留文章——所以字号放到超大也不会超出屏幕。个别页面提取不准时，关掉这个开关即可看原样。")
            } else {
                Text("当前显示网页原样。字太小就调大字号（只放大文字，不会让页面横向溢出）；想要更清爽就打开「只显示正文」。")
            }
        }

        Section {
            VStack(alignment: .leading, spacing: 10) {
                Text("界面文字预览").pvFont(.caption).foregroundColor(.secondary)
                Text("网页收藏").pvFont(.headline)
                Text("列表标题、说明文字、按钮都会跟着字号、粗细、字体一起变。")
                    .pvFont(.body)
                    .foregroundColor(.secondary)
            }
            .padding(.vertical, 2)

            VStack(alignment: .leading, spacing: 8) {
                Text("正文预览").pvFont(.caption).foregroundColor(.secondary)
                Text("这是一段正文预览，用来感受当前的字号、粗细与字体。在手机上读长文，宋体比苹方更耐看。")
                    .font(.custom(store.readerFont.uiFontName(installed: installed),
                                  size: store.fontSize)
                          .weight(store.boldText ? .semibold : .regular))
                    .lineSpacing(5)
            }
            .padding(.vertical, 4)
        } header: {
            Text("预览")
        }

        if !store.installedFonts.isEmpty {
            Section {
                LabeledContent("已下载字体", value: store.fontsSizeText)
                ForEach(ReaderFont.allCases.filter { installed.contains($0.rawValue) }) { font in
                    Button(role: .destructive) {
                        store.removeFont(font)
                    } label: {
                        Text("删除 \(font.title)")
                    }
                }
            } header: {
                Text("字体存储")
            } footer: {
                Text("字体文件存在 App 沙盒里，删掉不影响收藏数据，只是该字体需要重新下载。")
            }
        }
    }

    private func fontLabel(_ font: ReaderFont) -> String {
        if font.needsDownload(installed: installed) {
            return "\(font.title)（需下载）"
        }
        return font.subtitle.isEmpty ? font.title : "\(font.title) · \(font.subtitle)"
    }

    @ViewBuilder
    private var fontDownloadRow: some View {
        if let spec = store.readerFont.spec, store.selectedFontNeedsDownload {
            if let job = store.fontJob, job.id == spec.id {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("正在下载 \(spec.subtitle)")
                        Spacer()
                        Text("\(Int(job.progress * 100))%").foregroundColor(.secondary)
                    }
                    .pvFont(.footnote)
                    ProgressView(value: job.progress)
                }
            } else {
                Button {
                    Task { await store.downloadFont(store.readerFont) }
                } label: {
                    HStack {
                        Label("下载\(spec.subtitle)", systemImage: "arrow.down.circle")
                        Spacer()
                        Text(spec.sizeText).foregroundColor(.secondary)
                    }
                }
            }
            if let err = store.fontDownloadError {
                Text(err).pvFont(.footnote).foregroundColor(.red)
            }
            Text("iOS 只自带苹方，宋体/黑体/楷体要下载后才能用（开源字体，下载后可离线使用）。")
                .pvFont(.caption)
                .foregroundColor(.secondary)
        }
    }
}
