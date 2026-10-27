# AgentDeck 启动入口（Windows PowerShell）
# 用法: .\run.ps1 [-Port 48080]  （其余参数见 README）
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

# 用 npm.cmd 而不是 npm.ps1：PowerShell 会吞掉传给脚本的 "--"，
# 导致 --port / --no-open 传不到 node（Windows 专有坑）
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npm) { throw "未找到 npm，请先安装 Node.js（https://nodejs.org）" }
$npmExe = $npm.Source

# 首次运行自动安装依赖
if (-not (Test-Path "node_modules")) {
  Write-Host "首次运行，安装依赖…" -ForegroundColor Cyan
  & $npmExe install
} elseif (-not (Test-Path "node_modules\.bin\tsc.cmd")) {
  # node_modules 可能是从 macOS/Linux 拷贝来的（.bin 只有 Unix shim，没有 tsc.cmd）
  Write-Host "检测到 node_modules 缺少 Windows 可执行 shim，重建依赖…" -ForegroundColor Cyan
  & $npmExe rebuild
}

& $npmExe start -- @args
exit $LASTEXITCODE
