# 创建 "Mail Collector" 桌面快捷方式，指向 start.bat
# 用法：在项目根目录运行 create-shortcut.bat (或直接运行此脚本)

$ErrorActionPreference = 'Stop'

$projectRoot  = Split-Path -Parent $PSScriptRoot
$target       = Join-Path $projectRoot 'start.bat'
$desktop      = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Mail Collector.lnk'

if (-not (Test-Path $target)) {
    Write-Error "未找到启动脚本: $target"
    exit 1
}

$shell = New-Object -ComObject WScript.Shell
$lnk   = $shell.CreateShortcut($shortcutPath)
$lnk.TargetPath       = $target
$lnk.WorkingDirectory = $projectRoot
$lnk.WindowStyle      = 1
$lnk.Description      = 'Mail Collector 一键启动'

$iconCandidate = Join-Path $projectRoot 'public\favicon.svg'
# .lnk 不支持 svg 图标，使用 cmd 默认图标即可
$lnk.IconLocation = "$env:SystemRoot\System32\cmd.exe,0"
$lnk.Save()

Write-Host "已创建桌面快捷方式: $shortcutPath"
