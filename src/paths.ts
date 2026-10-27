import { join, sep } from "node:path";
import { homedir } from "node:os";

/** agent-deck 自身的配置目录（provider/model 台账） */
export function catalogPath(): string {
  return join(homedir(), ".config", "agent-deck.yaml");
}
/** Claude Code 用户设置 */
export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** OpenCode 主配置 */
export function opencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

/**
 * OpenCode v2 的 API key 存储（SQLite，credential 表）。
 * 注意：~/.local/share/opencode/auth.json 是 v1 遗留文件，v2 运行时不再读取。
 */
export function opencodeDbPath(): string {
  return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

/** Cline 桌面版设置目录 */
export function clineSettingsDir(): string {
  return join(homedir(), ".cline", "data", "settings");
}

/** 展示用路径：家目录前缀替换为 ~，分隔符统一为 /（macOS 原生如此，Windows 下观感一致） */
export function displayPath(p: string): string {
  const home = homedir();
  let out = p;
  if (p === home) out = "~";
  else if (p.startsWith(home + sep)) out = "~" + p.slice(home.length);
  return out.split(sep).join("/");
}
