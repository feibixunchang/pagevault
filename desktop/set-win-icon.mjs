// 把 AppIcon.ico 嵌进 Windows exe 的资源区（替换 Electron 默认图标）。
// 为什么需要：资源管理器/任务栏显示的是 exe 内部 PE 资源里的图标，
// exe 旁边放一个 .ico 文件没有任何作用——我们是从官方 electron.exe 改名来的，
// 不嵌入的话 Windows 端会显示 Electron 默认图标，与 Mac 版不一致。
//
// 实现：vendor 的 resedit（纯 JS，MIT）+ pe-library，跨平台可跑（macOS/Linux 上即可构建）。
// 注意：改写资源区会使原有的代码签名失效（本来也没买签名），SmartScreen
// 提示按 README 的"更多信息 → 仍要运行"绕过即可。
//
// 用法: node set-win-icon.mjs <exe路径> <ico路径>
import * as fs from 'fs';
import * as resedit from './vendor/node_modules/resedit/dist/index.js';

const [exePath, icoPath] = process.argv.slice(2);
if (!exePath || !icoPath) {
  console.error('usage: node set-win-icon.mjs <exe> <ico>');
  process.exit(1);
}

const exe = fs.readFileSync(exePath);
const ico = fs.readFileSync(icoPath);

const nt = resedit.NtExecutable.from(exe);
const rsrc = resedit.NtExecutableResource.from(nt);

// 解析 .ico（Pillow 生成的 ico 各尺寸为 PNG 数据 → RawIconItem）
const iconFile = resedit.Data.IconFile.from(ico);
const iconItems = iconFile.icons.map(i => i.data);
if (!iconItems.length) { console.error('ico 里没有图标'); process.exit(1); }

// 替换 id=1（主图标）图标组；RT_ICON 条目 id 由库自动分配
resedit.Resource.IconGroupEntry.replaceIconsForResource(rsrc.entries, 1, 0x409, iconItems);
rsrc.outputResource(nt);

fs.writeFileSync(exePath, Buffer.from(nt.generate()));
console.log(`icon embedded (${iconItems.length} sizes) -> ${exePath} (${fs.statSync(exePath).size} bytes)`);
