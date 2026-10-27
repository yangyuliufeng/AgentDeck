import { existsSync, copyFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 读取 JSON 文件，不存在或解析失败时返回 null */
export function readJson<T = Record<string, unknown>>(p: string): T | null {
  try {
    const text = readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * 原子化写 JSON 文件：
 * 1. 已有文件先备份到 <path>.agentdeck.bak
 * 2. 写临时文件后 rename，避免写一半导致文件损坏
 * 3. 新建文件默认 0600 权限（可能包含 API key）
 */
export function writeJsonAtomic(p: string, data: unknown): void {
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });

  let mode = 0o600;
  if (existsSync(p)) {
    copyFileSync(p, `${p}.agentdeck.bak`);
    mode = statSync(p).mode & 0o777;
  }

  const tmp = `${p}.agentdeck.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode });
  renameSync(tmp, p);
}
