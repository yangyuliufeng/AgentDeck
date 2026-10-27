#!/usr/bin/env node
import { spawn } from "node:child_process";
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

function openBrowser(u: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", u] : [u];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // 打不开浏览器不致命，手动访问即可
  }
}
