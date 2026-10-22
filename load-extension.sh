#!/usr/bin/env bash
# PageVault 扩展一键辅助：复制扩展目录到剪贴板 + 打开 Chrome 扩展管理页。
# 你只需要：① 打开右上角「开发者模式」 ② 点「加载已解压的扩展程序」
#            ③ 在弹出的文件框按 Cmd+Shift+G，粘贴（Cmd+V）回车 → 选择
set -e

EXT_DIR="/Users/lovenasuserlove/WorkBuddy/2026-10-22-13-27-54/pagevault/extension"

printf '%s' "$EXT_DIR" | pbcopy
echo "✓ 扩展目录已复制到剪贴板: $EXT_DIR"

BROWSER="${1:-Google Chrome}"   # 也可传 "Brave Browser"
open -a "$BROWSER" "chrome://extensions" 2>/dev/null \
  && echo "✓ 已打开 $BROWSER 的扩展管理页" \
  || echo "! 打开浏览器失败，请手动打开 chrome://extensions"
