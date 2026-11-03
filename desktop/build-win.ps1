<#
  build-win.ps1 - Native Windows build for WebVault (pagevault-desktop).

  WHY THIS EXISTS
  ---------------
  The Windows NSIS installer used to be produced by electron-builder running on
  macOS (desktop/build-win.sh, step 5) against a `prepackaged` directory.
  An NSIS installer stores the app as an appended 7z payload and unpacks it at
  install time through the Nsis7z plugin (7z.dll). When that plugin is not wired
  up correctly, NSIS does NOT fail loudly - the plugin call is silently skipped.
  Result: the wizard copies the stub as "Uninstall WebVault.exe", writes the
  HKCU uninstall key, creates both shortcuts, shows "installation complete" -
  and not a single app file is ever extracted. Double-clicking the shortcut then
  gives "Windows cannot find WebVault.exe". Reproduced on v1.5.20: install dir
  held exactly 141,002 bytes (the stub) while the registry claimed 266,715 KB.

  Building on Windows (CI: windows-latest) uses the real NSIS toolchain, and the
  smoke test below actually installs the produced Setup.exe and verifies the
  payload landed, so this class of bug can never ship silently again.

  Usage (from any shell, no admin required):
     powershell -NoProfile -ExecutionPolicy Bypass -File desktop\build-win.ps1
  Options:
     -SkipSetup     only assemble the portable dir + zip, do not build NSIS
     -SkipInstall    do not run the install smoke test
     -ElectronVer   Electron runtime version (default 31.7.7)
#>
[CmdletBinding()]
param(
    [string]$ElectronVer = '31.7.7',
    [switch]$SkipSetup,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "!!! $msg" -ForegroundColor Yellow }
function Die($msg) { Write-Host "xxx $msg" -ForegroundColor Red; exit 1 }

$desktop = $PSScriptRoot
$root = Split-Path -Parent $desktop
$server = Join-Path $root 'server'
$extension = Join-Path $root 'extension'
$dist = Join-Path $desktop 'dist'
$out = Join-Path $dist 'WebVault-win32-x64'

New-Item -ItemType Directory -Force -Path $dist | Out-Null

# ---------------------------------------------------------------- version ----
$ver = (Get-Content (Join-Path $desktop 'package.json') -Raw | ConvertFrom-Json).version
if (-not $ver) { Die 'cannot read desktop/package.json version' }
Step "building WebVault $ver for win32-x64 (Electron $ElectronVer)"

# ------------------------------------------------- single source of truth ----
Step 'stamp-version.js (sync version to all files)'
Push-Location $root
node scripts/stamp-version.js
if ($LASTEXITCODE -ne 0) { Pop-Location; Die 'stamp-version.js failed' }
Pop-Location

# ------------------------------------------------------ electron runtime ----
$buildDir = Join-Path $desktop '.win-build'
$rtDir = Join-Path $buildDir "electron-v$ElectronVer-win32-x64"
$rtZip = Join-Path $buildDir "electron-v$ElectronVer-win32-x64.zip"
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

if (-not (Test-Path (Join-Path $rtDir 'electron.exe'))) {
    $urls = @(
        "https://registry.npmmirror.com/-/binary/electron/v$ElectronVer/electron-v$ElectronVer-win32-x64.zip",
        "https://github.com/electron/electron/releases/download/v$ElectronVer/electron-v$ElectronVer-win32-x64.zip"
    )
    $ok = $false
    foreach ($u in $urls) {
        Step "downloading Electron runtime: $u"
        curl.exe -fL --retry 2 --connect-timeout 20 -o $rtZip $u
        if ($LASTEXITCODE -eq 0 -and (Get-Item $rtZip -ErrorAction SilentlyContinue).Length -gt 10MB) { $ok = $true; break }
        Warn 'that mirror failed, trying the next one'
    }
    if (-not $ok) { Die 'no Electron runtime source worked' }
    if (Test-Path $rtDir) { Remove-Item $rtDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $rtDir | Out-Null
    Step 'extracting Electron runtime'
    Expand-Archive -Path $rtZip -DestinationPath $rtDir -Force
}
if (-not (Test-Path (Join-Path $rtDir 'electron.exe'))) { Die 'electron.exe missing after extract' }

# ------------------------------------------------------------- assemble ------
Step 'assembling app dir'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

# whole runtime tree except the launcher, which we rename to WebVault.exe
Get-ChildItem $rtDir -Force | Where-Object { $_.Name -ne 'electron.exe' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $out $_.Name) -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $rtDir 'electron.exe') -Destination (Join-Path $out 'WebVault.exe') -Force

# app icon must be embedded into the PE resource section, a side-by-side .ico
# does nothing for Explorer / the taskbar
Step 'embedding AppIcon.ico into WebVault.exe'
Push-Location $desktop
node set-win-icon.mjs (Join-Path $out 'WebVault.exe') (Join-Path $desktop 'AppIcon.ico')
if ($LASTEXITCODE -ne 0) { Pop-Location; Die 'set-win-icon.mjs failed' }
Pop-Location

$appDst = Join-Path $out 'resources\app'
New-Item -ItemType Directory -Force -Path $appDst | Out-Null
foreach ($f in @('main.js', 'updater.js', 'preload.js', 'package.json')) {
    Copy-Item -LiteralPath (Join-Path $desktop $f) -Destination (Join-Path $appDst $f) -Force
}

Step 'bundling sync server + browser extension'
function Mirror($src, $dst) {
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    & robocopy $src $dst /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NC /NS /NP /XD data .DS_Store node_modules | Out-Null
    if ($LASTEXITCODE -ge 8) { Die "robocopy failed ($LASTEXITCODE): $src -> $dst" }
    $global:LASTEXITCODE = 0
}
Mirror $server (Join-Path $out 'resources\server')
Mirror $extension (Join-Path $out 'extension')
Mirror $extension (Join-Path $out 'resources\extension')

Copy-Item -LiteralPath (Join-Path $desktop 'AppIcon.ico') -Destination (Join-Path $out 'AppIcon.ico') -Force
Copy-Item -LiteralPath (Join-Path $desktop 'install-win.cmd') -Destination (Join-Path $out 'install.cmd') -Force
Copy-Item -LiteralPath (Join-Path $desktop 'uninstall-win.cmd') -Destination (Join-Path $out 'uninstall.cmd') -Force

# README.txt with a UTF-8 BOM so even legacy Notepad renders Chinese correctly
$readme = @"
网页收藏 Windows 版使用说明（v$ver）
============================

两种装法，任选其一：

A. 安装版（推荐）：双击 WebVault-Setup-$ver.exe，按向导安装
   - 用户级安装，不需要管理员权限
   - 自动创建桌面 / 开始菜单快捷方式，"设置 - 应用"里可卸载
   - 装完后应用内检查更新会自动升级到新版本

B. 免安装：完整解压 WebVault-$ver-win32-x64.zip 到任意英文路径（如 D:\WebVault），
   然后双击里面的 install.cmd 一键安装，或直接双击 WebVault.exe 便携使用。
   注意：不要在资源管理器的 zip 预览窗口里直接双击 exe，那样伴生文件
   （icudtl.dat、*.pak、locales 等）不在同目录，程序会报 ICU 错误且无窗口。

首次运行被拦？
  1. SmartScreen「Windows 已保护你的电脑」（未买代码签名）：点「更多信息」-「仍要运行」。
  2. 双击没反应：右键 exe - 属性 - 勾选「解除锁定」- 确定，再双击。
  3. 提示缺 dll：安装微软 VC++ Redistributable x64 (2015-2022)。

数据与端口
  - 收藏数据：%APPDATA%\pagevault-desktop（卸载/重装不丢，删掉该文件夹=清空收藏）
  - 端口 8731（被占用时自动复用已有服务）
  - 诊断日志：%APPDATA%\pagevault-desktop\desktop.log

浏览器扩展
  本目录下的 extension 文件夹就是扩展：
  Chrome/Edge 打开 chrome://extensions - 开发者模式 - 加载已解压的扩展程序 - 选它。
  也可以在阅读器底部状态栏点「安装扩展」。

多端同步
  阅读器右下角设置 - 账号与同步：填你自己的 WebDAV（坚果云 / Nextcloud / 群晖），
  或添加家里 NAS（PageVault 服务器，地址 http://<NAS-IP>:8731 + 同步令牌）。
"@
[System.IO.File]::WriteAllText((Join-Path $out 'README.txt'), $readme, (New-Object System.Text.UTF8Encoding($true)))

$payloadFiles = @(Get-ChildItem $out -Recurse -File -Force)
$payloadBytes = ($payloadFiles | Measure-Object Length -Sum).Sum
Step ("payload assembled: " + $payloadFiles.Count + " files, " + [math]::Round($payloadBytes / 1MB, 1) + " MB")
if ($payloadBytes -lt 150MB) { Die "payload looks too small ($payloadBytes bytes) - refusing to ship" }
foreach ($must in @('WebVault.exe', 'icudtl.dat', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
                    'resources\app\main.js', 'resources\server\server.js', 'locales\zh-CN.pak')) {
    if (-not (Test-Path (Join-Path $out $must))) { Die "payload is missing $must" }
}

# ------------------------------------------------------------------- zip -----
$zipName = "WebVault-$ver-win32-x64.zip"
$zipPath = Join-Path $dist $zipName
Step "building portable zip: $zipName"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $out -DestinationPath $zipPath -CompressionLevel Optimal
Step ("zip ready: " + [math]::Round((Get-Item $zipPath).Length / 1MB, 1) + " MB")

if ($SkipSetup) { Step 'SkipSetup set - done (no NSIS)'; exit 0 }

# ----------------------------------------------------------------- NSIS ------
Step 'building NSIS Setup with electron-builder (native Windows toolchain)'
Push-Location $desktop
$env:ELECTRON_BUILDER_CACHE = Join-Path $buildDir 'electron-builder-cache'
New-Item -ItemType Directory -Force -Path $env:ELECTRON_BUILDER_CACHE | Out-Null
node -e "const path=require('path');const {build}=require('electron-builder');build({prepackaged:path.resolve('dist/WebVault-win32-x64'),win:['nsis']}).then(()=>{console.log('NSIS OK')}).catch(e=>{console.error('NSIS FAIL:',(e&&e.stack)||e);process.exit(1)})"
if ($LASTEXITCODE -ne 0) { Pop-Location; Die 'electron-builder NSIS failed' }
Pop-Location

$setupName = "WebVault-Setup-$ver.exe"
$setupPath = Join-Path $dist $setupName
if (-not (Test-Path $setupPath)) {
    $found = Get-ChildItem $dist -Filter '*.exe' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($found) { $setupPath = $found.FullName; Warn "expected $setupName, using $($found.Name)" } else { Die "no Setup exe produced" }
}
Step ("Setup built: " + (Split-Path $setupPath -Leaf) + " (" + [math]::Round((Get-Item $setupPath).Length / 1MB, 1) + " MB)")

# --------------------------------------------------------- smoke test --------
if ($SkipInstall) { Warn 'SkipInstall set - NOT verifying the installer'; exit 0 }

Step 'SMOKE TEST: installing the Setup silently into a scratch dir'
$rv = 'C:\webvault-ci'
$target = Join-Path $rv 'pv'
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $rv | Out-Null

# /S = silent, /D must be the LAST argument and unquoted (NSIS rule)
$p = Start-Process -FilePath $setupPath -ArgumentList @('/S', "/D=$target") -Wait -PassThru
Step ("installer exited with code " + $p.ExitCode)

if (-not (Test-Path (Join-Path $target 'WebVault.exe'))) {
    $left = @(Get-ChildItem $target -Recurse -File -ErrorAction SilentlyContinue)
    Die ("INSTALLER DID NOT EXTRACT THE PAYLOAD. target has " + $left.Count + " file(s): " + (($left | Select-Object -First 10 | ForEach-Object { $_.Name }) -join ', '))
}
$installed = @(Get-ChildItem $target -Recurse -File -Force)
$instBytes = ($installed | Measure-Object Length -Sum).Sum
Step ("installed " + $installed.Count + " files, " + [math]::Round($instBytes / 1MB, 1) + " MB")
if ($installed.Count -lt 100) { Die "only $($installed.Count) files installed - payload incomplete" }
if ($instBytes -lt 150MB) { Die "installed payload is only $instBytes bytes - incomplete" }
foreach ($must in @('WebVault.exe', 'icudtl.dat', 'resources\app\main.js', 'resources\server\server.js', 'locales\zh-CN.pak', 'Uninstall WebVault.exe')) {
    if (-not (Test-Path (Join-Path $target $must))) { Die "installed tree is missing $must" }
}

Step 'SMOKE TEST: shortcuts + uninstall registry entry'
$desk = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desk 'WebVault.lnk'
if (-not (Test-Path $lnk)) { $lnk = Join-Path $desk "网页收藏.lnk" }
if (Test-Path $lnk) {
    $sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
    if (-not (Test-Path $sh.TargetPath)) { Die "shortcut target does not exist: $($sh.TargetPath)" }
    Step ("shortcut OK -> " + $sh.TargetPath)
} else { Warn 'no desktop shortcut found (may be a headless-runner quirk)' }
$uninstallKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -match 'WebVault|网页收藏' }
if (-not $uninstallKey) { Die 'no uninstall registry entry was created' }
Step ("uninstall entry OK: " + $uninstallKey.DisplayName + " v" + $uninstallKey.DisplayVersion)

Step 'SMOKE TEST: starting the bundled sync server from the installed copy'
$envSaved = @{ n = $env:ELECTRON_RUN_AS_NODE; p = $env:PORT }
$env:ELECTRON_RUN_AS_NODE = '1'
$env:PORT = '8731'
$env:PAGEVAULT_DATA = Join-Path $rv 'data'
# 与 main.js 的 fork env 保持一致，否则状态栏会显示成「网页版」
$env:PAGEVAULT_PLATFORM = 'desktop'
New-Item -ItemType Directory -Force -Path $env:PAGEVAULT_DATA | Out-Null
$srv = Start-Process -FilePath (Join-Path $target 'WebVault.exe') -ArgumentList 'resources\server\server.js' `
    -WorkingDirectory $target -PassThru -WindowStyle Hidden
$alive = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $st = Invoke-RestMethod 'http://127.0.0.1:8731/api/status' -TimeoutSec 3
        if ($st.ok) { $alive = $true; Step ("server answered: v" + $st.version + " platform=" + $st.platform); break }
    } catch { }
}
Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
Get-Process | Where-Object { $_.Path -like "$target*" } | Stop-Process -Force -ErrorAction SilentlyContinue
$env:ELECTRON_RUN_AS_NODE = $envSaved.n
$env:PORT = $envSaved.p
if (-not $alive) { Die 'the installed app could not start its sync server' }

Step 'SMOKE TEST: silent uninstall cleans up'
$un = Join-Path $target 'Uninstall WebVault.exe'
Start-Process -FilePath $un -ArgumentList '/S' -Wait | Out-Null
Start-Sleep -Seconds 3
$leftovers = @(Get-ChildItem $target -Recurse -File -Force -ErrorAction SilentlyContinue)
if ($leftovers.Count -gt 0) { Warn ("uninstall left " + $leftovers.Count + " file(s) behind") } else { Step 'uninstall removed every installed file' }
$after = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -match 'WebVault|网页收藏' }
if ($after) { Warn 'uninstall registry entry still present' } else { Step 'uninstall registry entry removed' }
Remove-Item $rv -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Step 'ALL CHECKS PASSED - this Setup is verified installable'
Write-Host ("  portable zip : " + $zipPath)
Write-Host ("  installer    : " + $setupPath)
