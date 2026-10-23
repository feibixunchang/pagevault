import SwiftUI

/// 外观 + 阅读 两组控件。设置页和阅读页右上角的「阅读设置」共用这一份，
/// 免得两边改出不一致。
struct ReaderStyleControls: View {
    @EnvironmentObject private var store: Store

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
            Toggle("只显示正文", isOn: $store.readerMode)

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

            Picker("字体", selection: $store.readerFont) {
                ForEach(ReaderFont.allCases) { Text($0.title).tag($0) }
            }
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
                Text("这是一段预览文字，用来感受当前的字号与字体。在手机上读长文，宋体/楷体比黑体更耐看。")
                    .font(.custom(store.readerFont.uiFontName, size: store.fontSize))
                    .lineSpacing(5)
            }
            .padding(.vertical, 4)
        } header: {
            Text("预览")
        }
    }
}
