# AgentDeck 启动入口（Windows PowerShell）
# 用法: .\run.ps1 [-Port 48080]  （其余参数见 README）
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
# 给启动它的窗口一个显眼的标题：关掉这个窗口 = 服务停止，页面会报「无法连接」
try { $Host.UI.RawUI.WindowTitle = "AgentDeck 服务（勿关闭此窗口）" } catch { }

try {
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
} catch [System.Management.Automation.PipelineStoppedException] {
  # Ctrl+C 主动中断，正常退出，不当作失败
  exit 130
} catch {
  # 出错时别让窗口一闪就没（否则观感就是「右键没反应」）
  Write-Host ""
  Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "排查：① 确认已安装 Node.js（在终端执行 npm -v）② 在终端里手动执行 npm start 看完整报错" -ForegroundColor Yellow
  Write-Host "页面报「保存失败 / Failed to fetch」通常就是因为这个窗口没起来或已被关闭。" -ForegroundColor Yellow
  try { $null = Read-Host "按回车键关闭此窗口" } catch { }
  exit 1
}
