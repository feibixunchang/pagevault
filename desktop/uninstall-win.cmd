@echo off
rem 网页收藏 Windows 卸载（用户级）
rem 删除安装目录、快捷方式、注册表项。收藏数据（%APPDATA%\pagevault-desktop）默认保留。
chcp 65001 >nul
setlocal

echo ============================================
echo   网页收藏 · 卸载
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "Get-Process WebVault -ErrorAction SilentlyContinue | Stop-Process -Force;" ^
  "$dest = Join-Path $env:LOCALAPPDATA 'Programs\WebVault';" ^
  "if (Test-Path $dest) { Remove-Item -Recurse -Force $dest };" ^
  "$desktop = [Environment]::GetFolderPath('Desktop');" ^
  "Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $desktop '网页收藏.lnk');" ^
  "$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs';" ^
  "Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $startMenu '网页收藏.lnk');" ^
  "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\WebVault';" ^
  "Write-Host '[OK] 已卸载程序本体。';" ^
  "Write-Host '[i] 收藏数据仍保留在 %APPDATA%\pagevault-desktop，重装不会丢失。';" ^
  "Write-Host '[i] 如需彻底清除数据，请手动删除该文件夹。';"

echo.
pause
