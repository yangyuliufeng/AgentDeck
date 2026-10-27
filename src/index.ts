#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import { startServer } from "./server.js";
import { loadCatalog } from "./catalog.js";
import { catalogPath, displayPath } from "./paths.js";

/* ---------- 命令行参数 ---------- */

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const port = Number.parseInt(argValue("port") ?? process.env.AGENT_DECK_PORT ?? "37890", 10);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`无效端口: ${port}`);
  process.exit(1);
}
const noOpen = process.argv.includes("--no-open");

/* ---------- 启动 ---------- */

const initial = loadCatalog(catalogPath());
if (initial.error) {
  console.warn(`⚠︎  ${initial.error}`);
}

const server = startServer(port);
const url = `http://127.0.0.1:${port}`;

server.on("listening", () => {
  console.log("AgentDeck 已启动");
  console.log(`  界面:      ${url}`);
  console.log(`  配置台账:  ${displayPath(catalogPath())}`);
  console.log(`  按 Ctrl+C 退出`);
  if (!noOpen) openBrowser(url);
});

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被占用（是否已有一个 AgentDeck 在运行？可用 --port 换端口）`);
  } else {
    console.error(`启动失败: ${e.message}`);
  }
  process.exit(1);
});

/* 支持以「应用窗口」方式打开的浏览器（macOS），按顺序取第一个已安装的 */
const APP_WINDOW_BROWSERS = [
  "/Applications/Google Chrome.app",
  `${homedir()}/Applications/Google Chrome.app`,
  "/Applications/Microsoft Edge.app",
  "/Applications/Brave Browser.app",
  "/Applications/Chromium.app",
];

/**
 * 打开界面窗口。
 * macOS 上若装有 Chromium 系浏览器，优先用 --app 模式：
 * 无地址栏、无标签页、独立 Dock 图标，看起来是一个本地 App 窗口而非网页。
 * 找不到时退回普通方式打开。
 */
function openBrowser(u: string): void {
  try {
    if (process.platform === "darwin") {
      const app = APP_WINDOW_BROWSERS.find((p) => existsSync(p));
      if (app) {
        const appName = basename(app, ".app");
        spawn("open", ["-n", "-a", appName, "--args", "--app", u], {
          detached: true,
          stdio: "ignore",
        }).unref();
        return;
      }
    }
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", u] : [u];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // 打不开窗口不致命，手动访问即可
  }
}
