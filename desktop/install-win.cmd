@echo off
rem 网页收藏 Windows 一键安装（用户级，无需管理员权限）
rem 用法：解压 zip 后双击本文件。安装到 %LOCALAPPDATA%\Programs\WebVault，
rem       创建桌面/开始菜单快捷方式，并注册"设置→应用"卸载入口。
chcp 65001 >nul
setlocal

rem ---- 以管理员身份时降权回当前用户（用户级安装不需要特权）----
net session >nul 2>&1
if %errorlevel%==0 (
  echo [i] 检测到管理员权限，切换到普通用户安装...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb Open"
  exit /b
)

echo ============================================
echo   网页收藏 · 安装
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$src = $PSScriptRoot;" ^
  "$exe = Join-Path $src 'WebVault.exe';" ^
  "if (-not (Test-Path $exe)) { Write-Host '[x] 当前目录找不到 WebVault.exe，请在本文件所在目录运行'; exit 1 };" ^
  "$dest = Join-Path $env:LOCALAPPDATA 'Programs\WebVault';" ^
  "Write-Host ('[i] 安装到: ' + $dest);" ^
  "Get-Process WebVault -ErrorAction SilentlyContinue | Stop-Process -Force;" ^
  "for ($i=0; $i -lt 20; $i++) { if (-not (Get-Process WebVault -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 300 };" ^
  "Start-Sleep -Milliseconds 500;" ^
  "New-Item -ItemType Directory -Force -Path $dest | Out-Null;" ^
  "robocopy $src $dest /MIR /R:3 /W:1 /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null;" ^
  "if ($LASTEXITCODE -ge 8) { Write-Host '[x] 复制文件失败（可能有另一个实例还在运行，全部退出后再试一次）'; exit 1 }" ^
  "$shell = New-Object -ComObject WScript.Shell;" ^
  "$desktop = [Environment]::GetFolderPath('Desktop');" ^
  "$lnk1 = $shell.CreateShortcut((Join-Path $desktop '网页收藏.lnk'));" ^
  "$lnk1.TargetPath = (Join-Path $dest 'WebVault.exe');" ^
  "$lnk1.WorkingDirectory = $dest;" ^
  "$lnk1.IconLocation = ((Join-Path $dest 'AppIcon.ico') + ',0');" ^
  "$lnk1.Description = '网页收藏 - 整页保存，离线回看';" ^
  "$lnk1.Save();" ^
  "$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs';" ^
  "$lnk2 = $shell.CreateShortcut((Join-Path $startMenu '网页收藏.lnk'));" ^
  "$lnk2.TargetPath = (Join-Path $dest 'WebVault.exe');" ^
  "$lnk2.WorkingDirectory = $dest;" ^
  "$lnk2.IconLocation = ((Join-Path $dest 'AppIcon.ico') + ',0');" ^
  "$lnk2.Description = '网页收藏 - 整页保存，离线回看';" ^
  "$lnk2.Save();" ^
  "$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\WebVault';" ^
  "New-Item -Force -Path $reg | Out-Null;" ^
  "Set-ItemProperty -Path $reg -Name 'DisplayName' -Value '网页收藏';" ^
  "Set-ItemProperty -Path $reg -Name 'DisplayIcon' -Value ((Join-Path $dest 'WebVault.exe') + ',0');" ^
  "Set-ItemProperty -Path $reg -Name 'Publisher' -Value 'pagevault';" ^
  "Set-ItemProperty -Path $reg -Name 'InstallLocation' -Value $dest;" ^
  "Set-ItemProperty -Path $reg -Name 'UninstallString' -Value ('\"' + (Join-Path $dest 'uninstall.cmd') + '\"');" ^
  "Set-ItemProperty -Path $reg -Name 'NoModify' -Value 1 -Type DWord;" ^
  "Set-ItemProperty -Path $reg -Name 'NoRepair' -Value 1 -Type DWord;" ^
  "Write-Host '[OK] 安装完成，正在启动...';" ^
  "Start-Process (Join-Path $dest 'WebVault.exe');"

if %errorlevel% neq 0 (
  echo.
  echo [x] 安装失败，请把上面的错误信息反馈给开发者
  pause
  exit /b 1
)
echo.
echo 安装完成！之后可以从桌面图标、开始菜单启动；
echo 卸载：设置 → 应用 → 网页收藏 → 卸载（或运行安装目录里的 uninstall.cmd）
pause
